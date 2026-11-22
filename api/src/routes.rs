//! HTTP routing for /api/*. Every /api/v1 route requires a caller; every query is scoped by user id.

use serde::Deserialize;
use serde_json::{json, Value};
use worker::{Context, D1Database, Env, Request, Response};

use crate::args;
use crate::ask::{self, AskRequest, Source};
use crate::audit::audit;
use crate::context;
use crate::auth::{self, Caller};
use crate::db::{self, Arg, Count};
use crate::error::{ApiError, ApiResult};
use crate::http::{self, Config};
use crate::ingest::fetch::WorkerFetcher;
use crate::knowledge::{self as kn, item_cols, CreateInput, ItemRow, Patch, ITEM_COLUMNS};
use crate::plans::limits;
use crate::retrieval::{self, filters::Filters, search};
use crate::util::{iso_from_ms, new_id, normalize_text, now_iso, now_ms};

fn valid_id(s: &str) -> bool {
    let Some((p, h)) = s.split_once('_') else { return false };
    (2..=4).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_lowercase()) && h.len() == 32 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn opt(q: &std::collections::HashMap<String, String>, k: &str, max: usize) -> ApiResult<Option<String>> {
    match q.get(k).map(|s| s.trim()).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(v) if v.chars().count() > max => Err(ApiError::validation(k, "too long")),
        Some(v) => Ok(Some(v.to_string())),
    }
}

fn iso_param(q: &std::collections::HashMap<String, String>, k: &str) -> ApiResult<Option<String>> {
    let v = opt(q, k, 40)?;
    if let Some(s) = &v {
        // Accept YYYY-MM-DD or full ISO timestamps; compare lexically against stored ISO strings.
        let ok = s.len() >= 10 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-' && s[..4].bytes().all(|b| b.is_ascii_digit());
        if !ok {
            return Err(ApiError::validation(k, "must be an ISO date"));
        }
    }
    Ok(v)
}

fn int_param(q: &std::collections::HashMap<String, String>, k: &str, default: i64, min: i64, max: i64) -> ApiResult<i64> {
    match q.get(k) {
        None => Ok(default),
        Some(v) => match v.parse::<i64>() {
            Ok(n) if (min..=max).contains(&n) => Ok(n),
            _ => Err(ApiError::validation(k, &format!("must be an integer from {min} to {max}"))),
        },
    }
}

fn collection_param(q: &std::collections::HashMap<String, String>) -> ApiResult<Option<String>> {
    match opt(q, "collection", 40)? {
        Some(c) if !valid_id(&c) => Err(ApiError::validation("collection", "invalid id")),
        v => Ok(v),
    }
}

async fn rate_limit(env: &Env, binding: &str, key: &str) -> ApiResult<()> {
    if let Ok(l) = env.rate_limiter(binding) {
        if let Ok(o) = l.limit(format!("{binding}:{key}")).await {
            if !o.success {
                return Err(ApiError::new(429, "rate_limited", "Too many requests. Wait a minute and try again."));
            }
        }
    }
    Ok(())
}

// ---------- items ----------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateBody {
    kind: String,
    url: Option<String>,
    content: Option<String>,
    title: Option<String>,
    note: Option<String>,
    #[serde(rename = "sourceUrl")]
    source_url: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
}

fn check_len(field: &str, v: &Option<String>, max: usize) -> ApiResult<()> {
    if v.as_ref().map(|s| s.chars().count() > max).unwrap_or(false) {
        return Err(ApiError::validation(field, &format!("must be at most {max} characters")));
    }
    Ok(())
}

async fn create_item(mut req: Request, env: &Env, ctx: &Context, db: &D1Database, cfg: &Config, c: &Caller) -> ApiResult<Response> {
    rate_limit(env, "INGEST_LIMITER", &c.user.id).await?;
    let b: CreateBody = http::json_body(&mut req).await?;
    if b.tags.len() > 20 || b.tags.iter().any(|t| t.is_empty() || t.chars().count() > 64) {
        return Err(ApiError::validation("tags", "up to 20 tags, each 1 to 64 characters"));
    }
    check_len("title", &b.title, 300)?;
    let input = match b.kind.as_str() {
        "url" => {
            if b.content.is_some() || b.source_url.is_some() {
                return Err(ApiError::validation("kind", "url items take url, title, note, tags"));
            }
            let url = b.url.filter(|u| !u.is_empty()).ok_or_else(|| ApiError::validation("url", "required"))?;
            check_len("url", &Some(url.clone()), 2048)?;
            check_len("note", &b.note, 20_000)?;
            CreateInput::Url { url, title: b.title, note: b.note, tags: b.tags }
        }
        "text" | "note" | "capture" => {
            if b.url.is_some() || b.note.is_some() {
                return Err(ApiError::validation("kind", "text items take content, title, sourceUrl, tags"));
            }
            let content = b.content.filter(|c| !c.is_empty()).ok_or_else(|| ApiError::validation("content", "required"))?;
            check_len("content", &Some(content.clone()), 100_000)?;
            check_len("sourceUrl", &b.source_url, 2048)?;
            CreateInput::Text { kind: b.kind, content, title: b.title, source_url: b.source_url, tags: b.tags }
        }
        _ => return Err(ApiError::validation("kind", "must be url, text, note or capture")),
    };
    let created = kn::create(db, &c.user, input).await?;
    let mut row = created.row;
    if created.needs_processing {
        let emb = retrieval::embedder(env, cfg);
        if row.kind == "url" {
            // URL fetches run after the response so a slow site does not block the user.
            let (env2, cfg2, uid, iid) = (env.clone(), cfg.clone(), c.user.id.clone(), row.id.clone());
            ctx.wait_until(async move {
                if let Ok(db2) = env2.d1("DB") {
                    let emb2 = retrieval::embedder(&env2, &cfg2);
                    let _ = kn::process(&db2, emb2.as_ref(), &WorkerFetcher, cfg2.instagram_token.as_deref(), &uid, &iid).await;
                }
            });
        } else {
            row = kn::process(db, emb.as_ref(), &WorkerFetcher, cfg.instagram_token.as_deref(), &c.user.id, &row.id).await?;
        }
        audit(db, Some(&c.user.id), "item.created", json!({ "kind": row.kind })).await?;
    }
    let item = kn::public_item(db, &c.user.id, &row).await?;
    http::json_response(&json!({ "item": item, "duplicate": created.duplicate }), if created.duplicate { 200 } else { 201 })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchBody {
    urls: Vec<String>,
    #[serde(default)]
    tags: Vec<String>,
}

/// Bulk import: paste up to 50 saved-post or reel links at once. Each link becomes a pending item;
/// the first few are processed right away and the scheduled job works through the rest.
async fn batch_items(mut req: Request, env: &Env, ctx: &Context, db: &D1Database, cfg: &Config, c: &Caller) -> ApiResult<Response> {
    rate_limit(env, "INGEST_LIMITER", &c.user.id).await?;
    let b: BatchBody = http::json_body(&mut req).await?;
    if b.urls.is_empty() || b.urls.len() > 50 {
        return Err(ApiError::validation("urls", "send 1 to 50 links"));
    }
    if b.tags.len() > 20 || b.tags.iter().any(|t| t.is_empty() || t.chars().count() > 64) {
        return Err(ApiError::validation("tags", "up to 20 tags, each 1 to 64 characters"));
    }
    let mut results: Vec<Value> = vec![];
    let mut to_process: Vec<String> = vec![];
    let mut seen: Vec<String> = vec![];
    for raw in b.urls {
        let url = raw.trim().to_string();
        if url.is_empty() || seen.contains(&url) {
            continue;
        }
        seen.push(url.clone());
        if url.chars().count() > 2048 {
            results.push(json!({ "url": url.chars().take(80).collect::<String>(), "error": { "code": "invalid_url", "message": "Link is too long." } }));
            continue;
        }
        match kn::create(db, &c.user, CreateInput::Url { url: url.clone(), title: None, note: None, tags: b.tags.clone() }).await {
            Ok(cr) => {
                if cr.needs_processing {
                    to_process.push(cr.row.id.clone());
                }
                results.push(json!({ "url": url, "itemId": cr.row.id, "duplicate": cr.duplicate, "status": cr.row.status }));
            }
            Err(e) if e.status == 500 => return Err(e),
            Err(e) => {
                let stop = e.code == "plan_limit_items" || e.code == "plan_limit_url_daily";
                results.push(json!({ "url": url, "error": { "code": e.code, "message": e.message } }));
                if stop {
                    break;
                }
            }
        }
    }
    let queued = to_process.len();
    if queued > 0 {
        audit(db, Some(&c.user.id), "item.batch_created", json!({ "count": queued })).await?;
        let first: Vec<String> = to_process.into_iter().take(5).collect();
        let (env2, cfg2, uid) = (env.clone(), cfg.clone(), c.user.id.clone());
        ctx.wait_until(async move {
            if let Ok(db2) = env2.d1("DB") {
                let emb = retrieval::embedder(&env2, &cfg2);
                for id in first {
                    let _ = kn::process(&db2, emb.as_ref(), &WorkerFetcher, cfg2.instagram_token.as_deref(), &uid, &id).await;
                }
            }
        });
    }
    http::json_response(&json!({ "results": results, "queued": queued }), 202)
}

/// Scheduled job: process pending links, reclaim abandoned ones, and retry transient failures.
pub async fn process_pending(env: &Env) -> ApiResult<usize> {
    let db = env.d1("DB").map_err(|_| ApiError::internal())?;
    let cfg = Config::from_env(env);
    let emb = retrieval::embedder(env, &cfg);
    #[derive(Deserialize)]
    struct P {
        id: String,
        user_id: String,
    }
    let stale = iso_from_ms(now_ms() - 300_000.0);
    let retry_after = iso_from_ms(now_ms() - 600_000.0);
    let rows: Vec<P> = db::all(
        &db,
        "SELECT id, user_id FROM knowledge_items WHERE kind = 'url' AND (
           status = 'pending'
           OR (status = 'processing' AND updated_at < ?)
           OR (status = 'failed' AND attempts < 3 AND updated_at < ? AND (error_code IN ('fetch_timeout','fetch_failed','http_429') OR error_code LIKE 'http_5%'))
         ) ORDER BY updated_at LIMIT 15",
        args![stale, retry_after],
    )
    .await?;
    let n = rows.len();
    for r in rows {
        let _ = kn::process(&db, emb.as_ref(), &WorkerFetcher, cfg.instagram_token.as_deref(), &r.user_id, &r.id).await;
    }
    Ok(n)
}

async fn list_items(req: &Request, db: &D1Database, c: &Caller) -> ApiResult<Response> {
    let q = http::query(req);
    let archived = q.get("archived").map(String::as_str) == Some("true");
    let status = opt(&q, "status", 20)?;
    if let Some(s) = &status {
        if !["pending", "processing", "ready", "failed"].contains(&s.as_str()) {
            return Err(ApiError::validation("status", "invalid"));
        }
    }
    let f = Filters { source: opt(&q, "source", 32)?, tag: opt(&q, "tag", 64)?, collection: collection_param(&q)?, status, from: iso_param(&q, "from")?, to: iso_param(&q, "to")?, include_archived: archived };
    let limit = int_param(&q, "limit", 30, 1, 100)?;
    let (fsql, fargs) = f.sql("k");
    let mut a: Vec<Arg> = vec![c.user.id.clone().into()];
    a.extend(fargs);
    let mut cursor_sql = String::new();
    if let Some(cur) = opt(&q, "cursor", 80)? {
        let (ts, seq) = cur.split_once('|').ok_or_else(|| ApiError::new(422, "invalid_cursor", "Invalid page cursor."))?;
        let seq: i64 = seq.parse().map_err(|_| ApiError::new(422, "invalid_cursor", "Invalid page cursor."))?;
        cursor_sql = " AND (k.created_at < ? OR (k.created_at = ? AND k.seq < ?))".into();
        a.extend([ts.into(), ts.into(), seq.into()]);
    }
    a.push((limit + 1).into());
    let arch = if archived { " AND k.archived = 1" } else { "" };
    let sql = format!("SELECT {} FROM knowledge_items k WHERE k.user_id = ?{fsql}{arch}{cursor_sql} ORDER BY k.created_at DESC, k.seq DESC LIMIT ?", item_cols("k"));
    let mut rows: Vec<ItemRow> = db::all(db, &sql, a).await?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
    let rel = kn::load_relations(db, &c.user.id, &ids).await?;
    let next = if more { rows.last().map(|r| format!("{}|{}", r.created_at, r.seq)) } else { None };
    let items: Vec<Value> = rows.iter().map(|r| kn::to_public(r, rel.tags.get(&r.id).map(Vec::as_slice).unwrap_or(&[]), rel.cols.get(&r.id).map(Vec::as_slice).unwrap_or(&[]))).collect();
    http::ok(&json!({ "items": items, "nextCursor": next }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PatchBody {
    title: Option<String>,
    content: Option<String>,
    description: Option<String>,
    archived: Option<bool>,
    tags: Option<Vec<String>>,
}

async fn patch_item(mut req: Request, env: &Env, db: &D1Database, cfg: &Config, c: &Caller, id: &str) -> ApiResult<Response> {
    let b: PatchBody = http::json_body(&mut req).await?;
    check_len("title", &b.title, 300)?;
    check_len("content", &b.content, 100_000)?;
    check_len("description", &b.description, 1000)?;
    if let Some(t) = &b.tags {
        if t.len() > 20 || t.iter().any(|x| x.is_empty() || x.chars().count() > 64) {
            return Err(ApiError::validation("tags", "up to 20 tags, each 1 to 64 characters"));
        }
    }
    let emb = retrieval::embedder(env, cfg);
    let row = kn::update(db, emb.as_ref(), &c.user.id, id, Patch { title: b.title, content: b.content, description: b.description, archived: b.archived, tags: b.tags }).await?;
    http::ok(&json!({ "item": kn::public_item(db, &c.user.id, &row).await? }))
}

async fn retry_item(env: &Env, db: &D1Database, cfg: &Config, c: &Caller, id: &str) -> ApiResult<Response> {
    rate_limit(env, "INGEST_LIMITER", &c.user.id).await?;
    let row = kn::get_owned(db, &c.user.id, id).await?;
    if row.status != "failed" {
        return Err(ApiError::new(409, "not_failed", "Only failed items can be retried."));
    }
    let emb = retrieval::embedder(env, cfg);
    let updated = kn::process(db, emb.as_ref(), &WorkerFetcher, cfg.instagram_token.as_deref(), &c.user.id, id).await?;
    if updated.status == "failed" && updated.attempts >= kn::MAX_ATTEMPTS {
        return Err(ApiError::new(409, "retry_exhausted", "This item failed too many times. Delete it and save the link again."));
    }
    http::ok(&json!({ "item": kn::public_item(db, &c.user.id, &updated).await? }))
}

// ---------- search ----------

async fn search_route(req: &Request, env: &Env, db: &D1Database, cfg: &Config, c: &Caller) -> ApiResult<Response> {
    let q = http::query(req);
    let text = q.get("q").map(|s| s.trim().to_string()).unwrap_or_default();
    if text.is_empty() || text.chars().count() > 500 {
        return Err(ApiError::validation("q", "must be 1 to 500 characters"));
    }
    let mode = q.get("mode").map(String::as_str).unwrap_or("hybrid");
    if !["hybrid", "lexical", "semantic"].contains(&mode) {
        return Err(ApiError::validation("mode", "must be hybrid, lexical or semantic"));
    }
    let f = Filters { source: opt(&q, "source", 32)?, tag: opt(&q, "tag", 64)?, collection: collection_param(&q)?, from: iso_param(&q, "from")?, to: iso_param(&q, "to")?, ..Default::default() };
    let limit = int_param(&q, "limit", 20, 1, 50)? as usize;
    let offset = int_param(&q, "offset", 0, 0, 450)? as usize;
    let started = now_ms();
    let emb = retrieval::embedder(env, cfg);
    let out = search::search(db, emb.as_ref(), &c.user.id, &text, mode, &f, limit, offset).await?;
    let results = hydrate(db, &c.user.id, &out.hits).await?;
    worker::console_log!("{}", json!({ "level": "info", "metric": "search", "mode": out.mode_used, "degraded": out.degraded, "hits": out.total, "ms": now_ms() - started }));
    http::ok(&json!({ "results": results, "total": out.total, "mode": out.mode_used, "degraded": out.degraded }))
}

async fn hydrate(db: &D1Database, uid: &str, hits: &[search::Hit]) -> ApiResult<Vec<Value>> {
    if hits.is_empty() {
        return Ok(vec![]);
    }
    let ids: Vec<String> = hits.iter().map(|h| h.id.clone()).collect();
    let ph = vec!["?"; ids.len()].join(",");
    let mut a: Vec<Arg> = vec![uid.into()];
    a.extend(ids.iter().map(Arg::from));
    let rows: Vec<ItemRow> = db::all(db, &format!("SELECT {ITEM_COLUMNS} FROM knowledge_items WHERE user_id = ? AND id IN ({ph})"), a).await?;
    let rel = kn::load_relations(db, uid, &ids).await?;
    Ok(hits
        .iter()
        .filter_map(|h| {
            let r = rows.iter().find(|r| r.id == h.id)?;
            Some(json!({ "item": kn::to_public(r, rel.tags.get(&r.id).map(Vec::as_slice).unwrap_or(&[]), rel.cols.get(&r.id).map(Vec::as_slice).unwrap_or(&[])), "snippet": h.snippet, "reason": h.reason }))
        })
        .collect())
}

// ---------- ask (Grok-style companion) ----------

async fn ask_route(mut req: Request, env: &Env, db: &D1Database, cfg: &Config, c: &Caller) -> ApiResult<Response> {
    rate_limit(env, "API_LIMITER", &c.user.id).await?;
    let mut b: AskRequest = http::json_body(&mut req).await?;
    b.question = normalize_text(&b.question, ask::MAX_QUESTION);
    if b.question.is_empty() {
        return Err(ApiError::validation("question", "required"));
    }
    if b.history.len() > 20 {
        return Err(ApiError::validation("history", "at most 20 turns"));
    }
    // Private windows (password managers, incognito) never reach the model, even if a client sends them.
    if b.context.as_ref().map(|c| context::is_private(c.app_name.as_deref().unwrap_or(""), c.window_title.as_deref().unwrap_or(""))).unwrap_or(false) {
        b.context = None;
    }
    if let Some(ctx) = b.context.as_mut() {
        ctx.selected_text = ctx.selected_text.as_deref().map(|s| normalize_text(s, ask::MAX_CONTEXT));
        ctx.app_name = ctx.app_name.as_deref().map(|s| normalize_text(s, 80));
        ctx.window_title = ctx.window_title.as_deref().map(|s| normalize_text(s, 200));
    }
    let since = iso_from_ms(now_ms() - 86_400_000.0);
    let used: Count = db::first(db, "SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ? AND event = 'ask' AND created_at >= ?", args![&c.user.id, since]).await?.unwrap_or(Count { n: 0 });
    let cap = limits(&c.user.plan).max_asks_per_day;
    if used.n >= cap {
        return Err(ApiError::new(429, "plan_limit_asks", format!("Your plan answers up to {cap} questions per day.")));
    }

    let emb = retrieval::embedder(env, cfg);
    let task_keywords = b.context.as_ref().and_then(|ctx| context::extract_task(ctx.app_name.as_deref().unwrap_or(""), ctx.window_title.as_deref().unwrap_or(""))).map(|t| t.keywords).unwrap_or_default();
    let out = search::search(db, emb.as_ref(), &c.user.id, &ask::retrieval_query(&b, &task_keywords), "hybrid", &Filters { status: Some("ready".into()), ..Default::default() }, ask::MAX_SOURCES, 0).await?;
    let results = hydrate(db, &c.user.id, &out.hits).await?;
    let sources: Vec<Source> = results
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let it = &r["item"];
            let s = |k: &str| it[k].as_str().unwrap_or("").to_string();
            Source { n: i + 1, title: s("title"), url: it["originalUrl"].as_str().map(str::to_string), platform: s("sourcePlatform"), text: [s("description"), s("content"), s("extractedText")].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join("\n") }
        })
        .collect();
    let source_json: Vec<Value> = results.iter().enumerate().map(|(i, r)| json!({ "n": i + 1, "item": r["item"], "reason": r["reason"] })).collect();
    audit(db, Some(&c.user.id), "ask", json!({ "sources": sources.len() })).await?;

    let ai = (cfg.embedder == "workers-ai").then(|| env.ai("AI").ok()).flatten();
    let messages = ask::build_messages(&b, &sources);

    let Some(ai) = ai else {
        // No language model available: return the sources, say so plainly.
        let body = json!({ "answer": null, "sources": source_json, "degraded": true, "note": "Answers need the language model, which is not available. These are the closest items in your library." });
        if b.stream {
            let mut bytes = ask::sse("status", &json!({ "step": "searching" }));
            bytes.extend(ask::sse("sources", &json!({ "sources": source_json })));
            bytes.extend(ask::sse("done", &json!({ "degraded": true, "note": body["note"] })));
            return sse_response(bytes);
        }
        return http::ok(&body);
    };

    if !b.stream {
        #[derive(Deserialize)]
        struct Out {
            response: Option<String>,
        }
        let o: Out = ai.run(&cfg.llm_model, json!({ "messages": messages, "max_tokens": 700, "temperature": 0.3 })).await.map_err(|_| ApiError::new(503, "model_unavailable", "The answer model is busy. Try again in a moment."))?;
        let answer = o.response.unwrap_or_default();
        let used = ask::cited(&answer, sources.len());
        return http::ok(&json!({ "answer": answer, "sources": source_json, "cited": used, "degraded": out.degraded }));
    }

    use futures_util::StreamExt;
    let llm = ai
        .run_bytes(&cfg.llm_model, json!({ "messages": messages, "max_tokens": 700, "temperature": 0.3, "stream": true }))
        .await
        .map_err(|_| ApiError::new(503, "model_unavailable", "The answer model is busy. Try again in a moment."))?;
    let mut head = ask::sse("status", &json!({ "step": "searching" }));
    head.extend(ask::sse("sources", &json!({ "sources": source_json })));
    head.extend(ask::sse("status", &json!({ "step": "writing" })));
    let degraded = out.degraded;
    let mut parser = ask::LlmStreamParser::default();
    let body = futures_util::stream::once(async move { Ok::<Vec<u8>, worker::Error>(head) })
        .chain(llm.map(move |chunk| {
            let bytes = chunk.unwrap_or_default();
            let mut o = Vec::new();
            for d in parser.push(&bytes) {
                o.extend(ask::sse("delta", &json!({ "text": d })));
            }
            Ok(o)
        }))
        .chain(futures_util::stream::once(async move { Ok(ask::sse("done", &json!({ "degraded": degraded }))) }));
    let res = Response::from_stream(body)?;
    res.headers().set("Content-Type", "text/event-stream")?;
    Ok(res)
}

fn sse_response(bytes: Vec<u8>) -> ApiResult<Response> {
    let res = Response::from_bytes(bytes)?;
    res.headers().set("Content-Type", "text/event-stream")?;
    Ok(res)
}

// ---------- context suggestions (Observe mode) ----------

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ObserveBody {
    app_name: String,
    window_title: String,
}

const SUGGEST_COOLDOWN_MS: f64 = 90_000.0;
const MAX_SUGGESTIONS_PER_DAY: i64 = 40;

/// Given what is in front of the user, decide whether a saved item deserves their attention.
/// Window titles are processed in memory only and never stored or logged.
async fn suggest_route(mut req: Request, env: &Env, db: &D1Database, cfg: &Config, c: &Caller) -> ApiResult<Response> {
    let b: ObserveBody = http::json_body(&mut req).await?;
    if b.app_name.chars().count() > 120 || b.window_title.chars().count() > 400 {
        return Err(ApiError::validation("windowTitle", "too long"));
    }
    let app = normalize_text(&b.app_name, 120);
    let title = normalize_text(&b.window_title, 400);
    let Some(task) = context::extract_task(&app, &title) else {
        return http::ok(&json!({ "state": context::State::Silent, "task": null, "suggestions": [] }));
    };

    let uid = &c.user.id;
    let emb = retrieval::embedder(env, cfg);
    let query = task.keywords.join(" ");
    let out = search::search(db, emb.as_ref(), uid, &query, "hybrid", &Filters { status: Some("ready".into()), ..Default::default() }, 8, 0).await?;

    // Suppress items shown in the last 30 minutes, and items the user waved off in the last 7 days.
    #[derive(Deserialize)]
    struct Id {
        item_id: String,
    }
    let recent: Vec<Id> = db::all(
        db,
        "SELECT si.item_id AS item_id FROM suggestion_items si JOIN suggestion_events se ON se.id = si.suggestion_id AND se.user_id = si.user_id
         WHERE si.user_id = ? AND (se.created_at >= ? OR (se.feedback IN ('not_useful','dismissed') AND se.feedback_at >= ?))",
        args![uid, iso_from_ms(now_ms() - 1_800_000.0), iso_from_ms(now_ms() - 7.0 * 86_400_000.0)],
    )
    .await?;
    let min_sim = emb.as_ref().map(|e| e.min_similarity()).unwrap_or(0.45);
    // An interruption shows only items with word evidence or a clearly strong meaning match.
    let hits: Vec<&search::Hit> = out
        .hits
        .iter()
        .filter(|h| !recent.iter().any(|r| r.item_id == h.id))
        .filter(|h| h.lexical || h.similarity.map(|s| s >= min_sim + 0.1).unwrap_or(false))
        .take(3)
        .collect();

    let best = hits.first().map(|h| context::Evidence { lexical: h.lexical, matched_terms: crate::retrieval::rank::highlighted_terms(&h.snippet).len(), similarity: h.similarity, min_similarity: min_sim });
    let mut state = context::gate(Some(&task), best.as_ref());

    if state >= context::State::Suggest {
        #[derive(Deserialize)]
        struct Last {
            created_at: String,
            n: i64,
        }
        let since_day = iso_from_ms(now_ms() - 86_400_000.0);
        let last: Option<Last> = db::first(db, "SELECT MAX(created_at) AS created_at, COUNT(*) AS n FROM suggestion_events WHERE user_id = ? AND created_at >= ?", args![uid, since_day]).await.ok().flatten().filter(|l: &Last| l.n > 0);
        let cooling = last.as_ref().map(|l| l.created_at.as_str() >= iso_from_ms(now_ms() - SUGGEST_COOLDOWN_MS).as_str()).unwrap_or(false);
        let capped = last.as_ref().map(|l| l.n >= MAX_SUGGESTIONS_PER_DAY).unwrap_or(false);
        if cooling || capped {
            // Not a notification machine: hold the suggestion back, keep it available on request.
            state = context::State::Passive;
        }
    }

    let hit_views: Vec<search::Hit> = hits.iter().map(|h| search::Hit { id: h.id.clone(), snippet: h.snippet.clone(), reason: h.reason.clone(), lexical: h.lexical, semantic: h.semantic, similarity: h.similarity }).collect();
    let results = if state == context::State::Silent { vec![] } else { hydrate(db, uid, &hit_views).await? };
    let mut suggestion_id: Option<String> = None;
    if state >= context::State::Suggest && !results.is_empty() {
        let sid = new_id("sug");
        let mut stmts = vec![db::stmt(db, "INSERT INTO suggestion_events (id, user_id, state, item_count, created_at) VALUES (?, ?, ?, ?, ?)", args![&sid, uid, if state == context::State::HighConfidence { "HIGH_CONFIDENCE" } else { "SUGGEST" }, results.len() as i64, now_iso()])?];
        for (i, h) in hit_views.iter().enumerate() {
            stmts.push(db::stmt(db, "INSERT INTO suggestion_items (suggestion_id, user_id, item_id, position) VALUES (?, ?, ?, ?)", args![&sid, uid, &h.id, i as i64])?);
        }
        db::batch(db, stmts).await?;
        suggestion_id = Some(sid);
    }
    let suggestions: Vec<Value> = results
        .into_iter()
        .map(|r| {
            let why = format!("{}. Related to \"{}\".", r["reason"].as_str().unwrap_or("Related"), task.focus);
            json!({ "item": r["item"], "snippet": r["snippet"], "reason": why })
        })
        .collect();
    http::ok(&json!({ "state": state, "task": task, "suggestionId": suggestion_id, "suggestions": suggestions }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FeedbackBody {
    action: String,
}

async fn suggestion_feedback(mut req: Request, db: &D1Database, c: &Caller, id: &str) -> ApiResult<Response> {
    if !valid_id(id) {
        return Err(ApiError::not_found("Suggestion"));
    }
    let b: FeedbackBody = http::json_body(&mut req).await?;
    if !["useful", "not_useful", "opened", "dismissed"].contains(&b.action.as_str()) {
        return Err(ApiError::validation("action", "must be useful, not_useful, opened or dismissed"));
    }
    // "opened" never overwrites an explicit judgment.
    let n = db::run(
        db,
        "UPDATE suggestion_events SET feedback = ?, feedback_at = ? WHERE id = ? AND user_id = ? AND (? != 'opened' OR feedback IS NULL)",
        args![&b.action, now_iso(), id, &c.user.id, &b.action],
    )
    .await?;
    if n == 0 {
        let exists: Option<Count> = db::first(db, "SELECT COUNT(*) AS n FROM suggestion_events WHERE id = ? AND user_id = ?", args![id, &c.user.id]).await?;
        if exists.map(|e| e.n).unwrap_or(0) == 0 {
            return Err(ApiError::not_found("Suggestion"));
        }
    }
    http::no_content()
}

/// Useful Intervention Rate = useful suggestions / suggestions presented (last 30 days).
async fn suggestion_stats(db: &D1Database, c: &Caller) -> ApiResult<Response> {
    #[derive(Deserialize)]
    struct S {
        presented: i64,
        useful: i64,
        not_useful: i64,
        opened: i64,
        dismissed: i64,
    }
    let s: S = db::first(
        db,
        "SELECT COUNT(*) AS presented, COALESCE(SUM(feedback = 'useful'), 0) AS useful, COALESCE(SUM(feedback = 'not_useful'), 0) AS not_useful,
                COALESCE(SUM(feedback = 'opened'), 0) AS opened, COALESCE(SUM(feedback = 'dismissed'), 0) AS dismissed
         FROM suggestion_events WHERE user_id = ? AND created_at >= ?",
        args![&c.user.id, iso_from_ms(now_ms() - 30.0 * 86_400_000.0)],
    )
    .await?
    .unwrap_or(S { presented: 0, useful: 0, not_useful: 0, opened: 0, dismissed: 0 });
    let rate = if s.presented > 0 { Some(s.useful as f64 / s.presented as f64) } else { None };
    http::ok(&json!({ "days": 30, "presented": s.presented, "useful": s.useful, "notUseful": s.not_useful, "opened": s.opened, "dismissed": s.dismissed, "usefulInterventionRate": rate }))
}

// ---------- collections ----------

#[derive(Deserialize, serde::Serialize)]
struct ColRow {
    id: String,
    name: String,
    description: String,
    created_at: String,
    updated_at: String,
    item_count: i64,
}

fn col_pub(r: &ColRow) -> Value {
    json!({ "id": r.id, "name": r.name, "description": r.description, "itemCount": r.item_count, "createdAt": r.created_at, "updatedAt": r.updated_at })
}

const COL_SELECT: &str = "SELECT c.id, c.name, c.description, c.created_at, c.updated_at, (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id AND ci.user_id = c.user_id) AS item_count FROM collections c";

async fn owned_col(db: &D1Database, uid: &str, id: &str) -> ApiResult<ColRow> {
    if !valid_id(id) {
        return Err(ApiError::not_found("Collection"));
    }
    db::first(db, &format!("{COL_SELECT} WHERE c.id = ? AND c.user_id = ?"), args![id, uid]).await?.ok_or_else(|| ApiError::not_found("Collection"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ColBody {
    name: Option<String>,
    description: Option<String>,
}

fn col_name(n: &Option<String>) -> ApiResult<Option<String>> {
    match n {
        None => Ok(None),
        Some(s) => {
            let t = normalize_text(s, 80);
            if t.is_empty() || s.chars().count() > 80 {
                return Err(ApiError::validation("name", "must be 1 to 80 characters"));
            }
            Ok(Some(t))
        }
    }
}

async fn collections(mut req: Request, db: &D1Database, c: &Caller, rest: &[&str]) -> ApiResult<Response> {
    let uid = &c.user.id;
    let method = req.method().to_string();
    match (method.as_str(), rest) {
        ("GET", []) => {
            let rows: Vec<ColRow> = db::all(db, &format!("{COL_SELECT} WHERE c.user_id = ? ORDER BY c.name"), args![uid]).await?;
            http::ok(&json!({ "collections": rows.iter().map(col_pub).collect::<Vec<_>>() }))
        }
        ("POST", []) => {
            let b: ColBody = http::json_body(&mut req).await?;
            let name = col_name(&b.name)?.ok_or_else(|| ApiError::validation("name", "required"))?;
            check_len("description", &b.description, 500)?;
            let n: Count = db::first(db, "SELECT COUNT(*) AS n FROM collections WHERE user_id = ?", args![uid]).await?.unwrap_or(Count { n: 0 });
            let max = limits(&c.user.plan).max_collections;
            if n.n >= max {
                return Err(ApiError::new(403, "plan_limit_collections", format!("Your plan allows {max} collections.")));
            }
            let id = new_id("col");
            let now = now_iso();
            match db::run_unique(db, "INSERT INTO collections (id, user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", args![&id, uid, name, normalize_text(b.description.as_deref().unwrap_or(""), 500), &now, &now]).await {
                Ok(_) => {}
                Err(None) => return Err(ApiError::new(409, "collection_exists", "You already have a collection with that name.")),
                Err(Some(e)) => return Err(e),
            }
            http::json_response(&json!({ "collection": col_pub(&owned_col(db, uid, &id).await?) }), 201)
        }
        ("GET", [id]) => http::ok(&json!({ "collection": col_pub(&owned_col(db, uid, id).await?) })),
        ("PATCH", [id]) => {
            let row = owned_col(db, uid, id).await?;
            let b: ColBody = http::json_body(&mut req).await?;
            check_len("description", &b.description, 500)?;
            let name = col_name(&b.name)?.unwrap_or(row.name.clone());
            let desc = b.description.map(|d| normalize_text(&d, 500)).unwrap_or(row.description.clone());
            match db::run_unique(db, "UPDATE collections SET name = ?, description = ?, updated_at = ? WHERE id = ? AND user_id = ?", args![name, desc, now_iso(), &row.id, uid]).await {
                Ok(_) => {}
                Err(None) => return Err(ApiError::new(409, "collection_exists", "You already have a collection with that name.")),
                Err(Some(e)) => return Err(e),
            }
            http::ok(&json!({ "collection": col_pub(&owned_col(db, uid, &row.id).await?) }))
        }
        ("DELETE", [id]) => {
            let row = owned_col(db, uid, id).await?;
            db::run(db, "DELETE FROM collections WHERE id = ? AND user_id = ?", args![&row.id, uid]).await?;
            http::no_content()
        }
        ("PUT", [id, "items", item]) => {
            let col = owned_col(db, uid, id).await?;
            if !valid_id(item) {
                return Err(ApiError::not_found("Item"));
            }
            let it = kn::get_owned(db, uid, item).await?;
            db::run(db, "INSERT INTO collection_items (user_id, collection_id, item_id, added_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", args![uid, &col.id, &it.id, now_iso()]).await?;
            http::no_content()
        }
        ("DELETE", [id, "items", item]) => {
            let col = owned_col(db, uid, id).await?;
            if !valid_id(item) {
                return Err(ApiError::not_found("Item"));
            }
            db::run(db, "DELETE FROM collection_items WHERE user_id = ? AND collection_id = ? AND item_id = ?", args![uid, &col.id, *item]).await?;
            http::no_content()
        }
        _ => Err(ApiError::not_found("Endpoint")),
    }
}

// ---------- account ----------

async fn me(db: &D1Database, c: &Caller) -> ApiResult<Response> {
    #[derive(Deserialize)]
    struct U {
        items: i64,
        collections: i64,
    }
    let u: U = db::first(db, "SELECT (SELECT COUNT(*) FROM knowledge_items WHERE user_id = ?1) AS items, (SELECT COUNT(*) FROM collections WHERE user_id = ?1) AS collections", args![&c.user.id]).await?.unwrap_or(U { items: 0, collections: 0 });
    http::ok(&json!({ "user": c.user, "usage": { "items": u.items, "collections": u.collections }, "limits": limits(&c.user.plan).json() }))
}

async fn export(db: &D1Database, c: &Caller) -> ApiResult<Response> {
    let rows: Vec<ItemRow> = db::all(db, &format!("SELECT {ITEM_COLUMNS} FROM knowledge_items WHERE user_id = ? ORDER BY created_at"), args![&c.user.id]).await?;
    let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
    let rel = kn::load_relations(db, &c.user.id, &ids).await?;
    let cols: Vec<ColRow> = db::all(db, &format!("{COL_SELECT} WHERE c.user_id = ? ORDER BY c.name"), args![&c.user.id]).await?;
    audit(db, Some(&c.user.id), "account.exported", json!({ "items": rows.len() })).await?;
    let res = http::ok(&json!({
        "exportedAt": now_iso(), "format": "cognis-export/1",
        "user": { "id": c.user.id, "email": c.user.email, "name": c.user.name },
        "collections": cols.iter().map(col_pub).collect::<Vec<_>>(),
        "items": rows.iter().map(|r| kn::to_public(r, rel.tags.get(&r.id).map(Vec::as_slice).unwrap_or(&[]), rel.cols.get(&r.id).map(Vec::as_slice).unwrap_or(&[]))).collect::<Vec<_>>(),
    }))?;
    res.headers().set("Content-Disposition", "attachment; filename=\"cognis-export.json\"")?;
    Ok(res)
}

#[derive(Deserialize, serde::Serialize)]
struct NameCount {
    name: String,
    count: i64,
}

// ---------- dispatch ----------

pub async fn handle(req: Request, env: &Env, ctx: &Context, cfg: &Config, path: &str) -> ApiResult<Response> {
    let db = env.d1("DB").map_err(|_| ApiError::new(503, "not_ready", "Database unavailable."))?;
    let method = req.method().to_string();
    let segs: Vec<&str> = path.trim_matches('/').split('/').collect();

    // Public endpoints.
    match (method.as_str(), segs.as_slice()) {
        ("GET", ["api", "v1", "health"]) => return http::ok(&json!({ "status": "ok" })),
        ("GET", ["api", "v1", "ready"]) => {
            let db_ok = db::run(&db, "SELECT 1 FROM knowledge_items LIMIT 1", vec![]).await.is_ok();
            let emb = if retrieval::embedder(env, cfg).is_some() { "configured" } else { "unavailable" };
            let llm = if cfg.embedder == "workers-ai" && env.ai("AI").is_ok() { "configured" } else { "unavailable" };
            return http::json_response(&json!({ "status": if db_ok { "ready" } else { "not_ready" }, "database": if db_ok { "ok" } else { "error" }, "embeddings": emb, "answers": llm }), if db_ok { 200 } else { 503 });
        }
        ("POST", ["api", "auth", "sign-up"]) => {
            http::csrf_check(&req, cfg)?;
            return auth::sign_up(req, &db, cfg).await;
        }
        ("POST", ["api", "auth", "sign-in"]) => {
            http::csrf_check(&req, cfg)?;
            return auth::sign_in(req, &db, cfg).await;
        }
        ("GET", ["api", "auth", "verify-email"]) => return auth::verify_email(&req, &db, cfg).await,
        // Signed-out is a normal state for this probe, not an error.
        ("GET", ["api", "auth", "session"]) => {
            let c = auth::resolve(&req, &db, cfg).await?;
            return http::ok(&json!({ "user": c.map(|c| c.user) }));
        }
        ("POST", ["api", "auth", "resend-verification"]) => {
            http::csrf_check(&req, cfg)?;
            return auth::resend_verification(req, &db, cfg).await;
        }
        ("POST", ["api", "auth", "request-password-reset"]) => {
            http::csrf_check(&req, cfg)?;
            return auth::request_reset(req, &db, cfg).await;
        }
        ("POST", ["api", "auth", "reset-password"]) => {
            http::csrf_check(&req, cfg)?;
            return auth::reset_password(req, &db, cfg).await;
        }
        #[cfg(feature = "test-hooks")]
        ("GET", ["api", "test", "emails"]) if cfg.is_test() => {
            let mail: Vec<Value> = crate::email::CAPTURED.with(|c| c.borrow().iter().map(|(to, s, t)| json!({ "to": to, "subject": s, "text": t })).collect());
            return http::ok(&json!({ "emails": mail }));
        }
        _ => {}
    }

    // Everything else needs a caller.
    let Some(caller) = auth::resolve(&req, &db, cfg).await? else {
        return Err(ApiError::unauthenticated());
    };
    if !caller.via_bearer {
        http::csrf_check(&req, cfg)?;
    }
    if segs.first() == Some(&"api") && segs.get(1) == Some(&"v1") && !(method == "POST" && segs.get(2) == Some(&"items") && segs.len() <= 4) {
        rate_limit(env, "API_LIMITER", &caller.user.id).await?;
    }

    match (method.as_str(), segs.as_slice()) {
        ("POST", ["api", "auth", "sign-out"]) => auth::sign_out(&caller, &db, cfg).await,
        ("POST", ["api", "auth", "change-password"]) => auth::change_password(req, &caller, &db, cfg).await,
        ("GET", ["api", "auth", "sessions"]) => auth::list_sessions(&caller, &db).await,
        ("DELETE", ["api", "auth", "sessions", id]) => auth::revoke_session(&caller, &db, id).await,
        ("POST", ["api", "auth", "revoke-other-sessions"]) => auth::revoke_others(&caller, &db).await,
        ("POST", ["api", "auth", "delete-account"]) => auth::delete_account(req, &caller, &db, cfg).await,

        ("POST", ["api", "v1", "items"]) => create_item(req, env, ctx, &db, cfg, &caller).await,
        ("POST", ["api", "v1", "items", "batch"]) => batch_items(req, env, ctx, &db, cfg, &caller).await,
        ("GET", ["api", "v1", "items"]) => list_items(&req, &db, &caller).await,
        (m, ["api", "v1", "items", id, rest @ ..]) => {
            if !valid_id(id) {
                return Err(ApiError::not_found("Item"));
            }
            match (m, rest) {
                ("GET", []) => {
                    let row = kn::get_owned(&db, &caller.user.id, id).await?;
                    http::ok(&json!({ "item": kn::public_item(&db, &caller.user.id, &row).await? }))
                }
                ("PATCH", []) => patch_item(req, env, &db, cfg, &caller, id).await,
                ("DELETE", []) => {
                    kn::delete(&db, &caller.user.id, id).await?;
                    audit(&db, Some(&caller.user.id), "item.deleted", json!({})).await?;
                    http::no_content()
                }
                ("POST", ["retry"]) => retry_item(env, &db, cfg, &caller, id).await,
                _ => Err(ApiError::not_found("Endpoint")),
            }
        }
        ("GET", ["api", "v1", "search"]) => search_route(&req, env, &db, cfg, &caller).await,
        ("POST", ["api", "v1", "ask"]) => ask_route(req, env, &db, cfg, &caller).await,
        ("POST", ["api", "v1", "context", "suggest"]) => suggest_route(req, env, &db, cfg, &caller).await,
        ("POST", ["api", "v1", "suggestions", id, "feedback"]) => suggestion_feedback(req, &db, &caller, id).await,
        ("GET", ["api", "v1", "suggestions", "stats"]) => suggestion_stats(&db, &caller).await,
        (_, ["api", "v1", "collections", rest @ ..]) => collections(req, &db, &caller, rest).await,
        ("GET", ["api", "v1", "me"]) => me(&db, &caller).await,
        ("GET", ["api", "v1", "tags"]) => {
            let rows: Vec<NameCount> = db::all(&db, "SELECT t.name AS name, COUNT(it.item_id) AS count FROM tags t LEFT JOIN item_tags it ON it.tag_id = t.id AND it.user_id = t.user_id WHERE t.user_id = ? GROUP BY t.id ORDER BY t.name", args![&caller.user.id]).await?;
            http::ok(&json!({ "tags": rows }))
        }
        ("GET", ["api", "v1", "sources"]) => {
            let rows: Vec<NameCount> = db::all(&db, "SELECT source_platform AS name, COUNT(*) AS count FROM knowledge_items WHERE user_id = ? GROUP BY source_platform ORDER BY count DESC", args![&caller.user.id]).await?;
            http::ok(&json!({ "sources": rows.iter().map(|r| json!({ "source": r.name, "count": r.count })).collect::<Vec<_>>() }))
        }
        ("GET", ["api", "v1", "export"]) => export(&db, &caller).await,
        _ => Err(ApiError::not_found("Endpoint")),
    }
}
