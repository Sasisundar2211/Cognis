//! HTTP routing for /api/*. Every /api/v1 route requires a caller; every query is scoped by user id.

use serde::Deserialize;
use serde_json::{json, Value};
use worker::{Context, D1Database, Env, Request, Response};

use crate::args;
use crate::ask::{self, AskRequest, Source};
use crate::audit::audit;
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
                    let _ = kn::process(&db2, emb2.as_ref(), &WorkerFetcher, &uid, &iid).await;
                }
            });
        } else {
            row = kn::process(db, emb.as_ref(), &WorkerFetcher, &c.user.id, &row.id).await?;
        }
        audit(db, Some(&c.user.id), "item.created", json!({ "kind": row.kind })).await?;
    }
    let item = kn::public_item(db, &c.user.id, &row).await?;
    http::json_response(&json!({ "item": item, "duplicate": created.duplicate }), if created.duplicate { 200 } else { 201 })
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
    let updated = kn::process(db, emb.as_ref(), &WorkerFetcher, &c.user.id, id).await?;
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
    let out = search::search(db, emb.as_ref(), &c.user.id, &ask::retrieval_query(&b), "hybrid", &Filters { status: Some("ready".into()), ..Default::default() }, ask::MAX_SOURCES, 0).await?;
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
    if segs.first() == Some(&"api") && segs.get(1) == Some(&"v1") && !(method == "POST" && segs.get(2) == Some(&"items")) {
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
