//! KnowledgeObject service. Every read is scoped by user_id; nothing loads an item by id alone.

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use worker::D1Database;

use crate::args;
use crate::auth::AuthUser;
use crate::db::{self, Arg, Count};
use crate::error::{ApiError, ApiResult};
use crate::ingest::fetch::PageFetcher;
use crate::ingest::platforms::extract_link;
use crate::ingest::url_safety::{assert_fetchable, canonicalize, detect_platform};
use crate::plans::limits;
use crate::retrieval::embed::{embedding_text, to_blob, Embedder};
use crate::util::{iso_from_ms, new_id, normalize_text, now_iso, now_ms, sha256_hex};

pub const TITLE_MAX: usize = 300;
pub const CONTENT_MAX: usize = 100_000;
pub const DESCRIPTION_MAX: usize = 1000;
pub const TAG_MAX: usize = 32;
pub const TAGS_PER_ITEM: usize = 20;
pub const MAX_ATTEMPTS: i64 = 5;

pub const ITEM_COLUMNS: &str = "seq, id, user_id, kind, title, original_url, canonical_url, source_platform, description, content, extracted_text, content_hash, metadata, status, error_code, attempts, archived, embedding_model, created_at, updated_at, ingested_at";

pub fn item_cols(alias: &str) -> String {
    ITEM_COLUMNS.split(", ").map(|c| format!("{alias}.{c}")).collect::<Vec<_>>().join(", ")
}

#[derive(Deserialize, Clone)]
pub struct ItemRow {
    pub seq: i64,
    pub id: String,
    pub user_id: String,
    pub kind: String,
    pub title: String,
    pub original_url: Option<String>,
    pub canonical_url: Option<String>,
    pub source_platform: String,
    pub description: String,
    pub content: String,
    pub extracted_text: String,
    pub content_hash: Option<String>,
    pub metadata: String,
    pub status: String,
    pub error_code: Option<String>,
    pub attempts: i64,
    pub archived: i64,
    pub embedding_model: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub ingested_at: Option<String>,
}

pub fn to_public(r: &ItemRow, tags: &[String], cols: &[String]) -> Value {
    json!({
        "id": r.id, "kind": r.kind, "title": r.title, "originalUrl": r.original_url, "sourcePlatform": r.source_platform,
        "description": r.description, "content": r.content, "extractedText": r.extracted_text,
        "metadata": serde_json::from_str::<Value>(&r.metadata).unwrap_or(json!({})),
        "status": r.status, "errorCode": r.error_code, "archived": r.archived == 1, "hasEmbedding": r.embedding_model.is_some(),
        "tags": tags, "collections": cols, "createdAt": r.created_at, "updatedAt": r.updated_at, "ingestedAt": r.ingested_at,
    })
}

pub async fn get_owned(db: &D1Database, user_id: &str, id: &str) -> ApiResult<ItemRow> {
    db::first(db, &format!("SELECT {ITEM_COLUMNS} FROM knowledge_items WHERE id = ? AND user_id = ?"), args![id, user_id])
        .await?
        .ok_or_else(|| ApiError::not_found("Item"))
}

pub struct Relations {
    pub tags: HashMap<String, Vec<String>>,
    pub cols: HashMap<String, Vec<String>>,
}

pub async fn load_relations(db: &D1Database, user_id: &str, ids: &[String]) -> ApiResult<Relations> {
    let mut rel = Relations { tags: HashMap::new(), cols: HashMap::new() };
    if ids.is_empty() {
        return Ok(rel);
    }
    let ph = vec!["?"; ids.len()].join(",");
    let mut a1: Vec<Arg> = vec![user_id.into()];
    a1.extend(ids.iter().map(Arg::from));
    let mut a2: Vec<Arg> = vec![user_id.into()];
    a2.extend(ids.iter().map(Arg::from));
    #[derive(Deserialize)]
    struct T {
        item_id: String,
        name: String,
    }
    #[derive(Deserialize)]
    struct C {
        item_id: String,
        collection_id: String,
    }
    let t: Vec<T> = db::all(db, &format!("SELECT it.item_id AS item_id, t.name AS name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.user_id = ? AND it.item_id IN ({ph}) ORDER BY t.name"), a1).await?;
    let c: Vec<C> = db::all(db, &format!("SELECT item_id, collection_id FROM collection_items WHERE user_id = ? AND item_id IN ({ph})"), a2).await?;
    for r in t {
        rel.tags.entry(r.item_id).or_default().push(r.name);
    }
    for r in c {
        rel.cols.entry(r.item_id).or_default().push(r.collection_id);
    }
    Ok(rel)
}

pub async fn public_item(db: &D1Database, user_id: &str, row: &ItemRow) -> ApiResult<Value> {
    let rel = load_relations(db, user_id, std::slice::from_ref(&row.id)).await?;
    Ok(to_public(row, rel.tags.get(&row.id).map(Vec::as_slice).unwrap_or(&[]), rel.cols.get(&row.id).map(Vec::as_slice).unwrap_or(&[])))
}

pub fn normalize_tags(input: &[String]) -> ApiResult<Vec<String>> {
    let mut out: Vec<String> = vec![];
    for raw in input {
        let t = normalize_text(raw, TAG_MAX).to_lowercase().split_whitespace().collect::<Vec<_>>().join("-");
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
    }
    if out.len() > TAGS_PER_ITEM {
        return Err(ApiError::new(422, "too_many_tags", format!("An item can have at most {TAGS_PER_ITEM} tags.")));
    }
    Ok(out)
}

const PRUNE_TAGS: &str = "DELETE FROM tags WHERE user_id = ? AND id NOT IN (SELECT tag_id FROM item_tags WHERE user_id = ?)";

pub async fn set_tags(db: &D1Database, user_id: &str, item_id: &str, names: &[String]) -> ApiResult<()> {
    let tags = normalize_tags(names)?;
    let now = now_iso();
    let mut stmts = vec![db::stmt(db, "DELETE FROM item_tags WHERE user_id = ? AND item_id = ?", args![user_id, item_id])?];
    for name in &tags {
        stmts.push(db::stmt(db, "INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, name) DO NOTHING", args![new_id("tag"), user_id, name, &now])?);
        stmts.push(db::stmt(db, "INSERT INTO item_tags (user_id, item_id, tag_id) SELECT ?, ?, id FROM tags WHERE user_id = ? AND name = ?", args![user_id, item_id, user_id, name])?);
    }
    stmts.push(db::stmt(db, PRUNE_TAGS, args![user_id, user_id])?);
    db::batch(db, stmts).await
}

async fn assert_capacity(db: &D1Database, user: &AuthUser, kind: &str) -> ApiResult<()> {
    let l = limits(&user.plan);
    let total: Count = db::first(db, "SELECT COUNT(*) AS n FROM knowledge_items WHERE user_id = ?", args![&user.id]).await?.unwrap_or(Count { n: 0 });
    if total.n >= l.max_items {
        return Err(ApiError::new(403, "plan_limit_items", format!("Your plan stores up to {} items. Delete items or upgrade.", l.max_items)));
    }
    if kind == "url" {
        let since = iso_from_ms(now_ms() - 86_400_000.0);
        let today: Count = db::first(db, "SELECT COUNT(*) AS n FROM knowledge_items WHERE user_id = ? AND kind = 'url' AND created_at >= ?", args![&user.id, since]).await?.unwrap_or(Count { n: 0 });
        if today.n >= l.max_url_ingest_per_day {
            return Err(ApiError::new(429, "plan_limit_url_daily", format!("Your plan imports up to {} links per day.", l.max_url_ingest_per_day)));
        }
    }
    Ok(())
}

pub enum CreateInput {
    Url { url: String, title: Option<String>, note: Option<String>, tags: Vec<String> },
    Text { kind: String, content: String, title: Option<String>, source_url: Option<String>, tags: Vec<String> },
}

pub struct Created {
    pub row: ItemRow,
    pub duplicate: bool,
    pub needs_processing: bool,
}

async fn find_by(db: &D1Database, user_id: &str, col: &str, v: &str) -> ApiResult<Option<ItemRow>> {
    let cond = if col == "canonical_url" { "canonical_url = ?" } else { "canonical_url IS NULL AND content_hash = ?" };
    db::first(db, &format!("SELECT {ITEM_COLUMNS} FROM knowledge_items WHERE user_id = ? AND {cond}"), args![user_id, v]).await
}

pub async fn create(db: &D1Database, user: &AuthUser, input: CreateInput) -> ApiResult<Created> {
    let now = now_iso();
    let id = new_id("ki");
    match input {
        CreateInput::Url { url, title, note, tags } => {
            let u = assert_fetchable(&url).map_err(|r| ApiError::new(422, "invalid_url", "Enter a public http or https link.").with_details(json!({ "reason": r })))?;
            let canonical = canonicalize(&u);
            if let Some(row) = find_by(db, &user.id, "canonical_url", &canonical).await? {
                return Ok(Created { row, duplicate: true, needs_processing: false });
            }
            assert_capacity(db, user, "url").await?;
            let r = db::run_unique(
                db,
                "INSERT INTO knowledge_items (id, user_id, kind, title, original_url, canonical_url, source_platform, content, status, created_at, updated_at) VALUES (?, ?, 'url', ?, ?, ?, ?, ?, 'pending', ?, ?)",
                args![&id, &user.id, normalize_text(title.as_deref().unwrap_or(""), TITLE_MAX), u.as_str(), &canonical, detect_platform(&u), normalize_text(note.as_deref().unwrap_or(""), CONTENT_MAX), &now, &now],
            )
            .await;
            match r {
                Ok(_) => {}
                Err(Some(e)) => return Err(e),
                Err(None) => {
                    let row = find_by(db, &user.id, "canonical_url", &canonical).await?.ok_or_else(ApiError::internal)?;
                    return Ok(Created { row, duplicate: true, needs_processing: false });
                }
            }
            if !tags.is_empty() {
                set_tags(db, &user.id, &id, &tags).await?;
            }
            Ok(Created { row: get_owned(db, &user.id, &id).await?, duplicate: false, needs_processing: true })
        }
        CreateInput::Text { kind, content, title, source_url, tags } => {
            let content = normalize_text(&content, CONTENT_MAX);
            if content.is_empty() {
                return Err(ApiError::new(422, "empty_content", "Add some text before saving."));
            }
            let mut platform = if kind == "capture" { "browser".to_string() } else { "manual".to_string() };
            // Provenance link is optional; an unsafe one is dropped, not stored.
            let source = source_url.and_then(|s| assert_fetchable(&s).ok()).map(|u| {
                platform = detect_platform(&u).to_string();
                u.to_string()
            });
            let hash = sha256_hex(&format!("{kind}\n{}\n{content}", source.as_deref().unwrap_or("")));
            if let Some(row) = find_by(db, &user.id, "content_hash", &hash).await? {
                return Ok(Created { row, duplicate: true, needs_processing: false });
            }
            assert_capacity(db, user, &kind).await?;
            let first_line = content.lines().next().unwrap_or("").to_string();
            let title = normalize_text(title.filter(|t| !t.trim().is_empty()).as_deref().unwrap_or(&first_line), TITLE_MAX);
            let r = db::run_unique(
                db,
                "INSERT INTO knowledge_items (id, user_id, kind, title, original_url, source_platform, content, content_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
                args![&id, &user.id, &kind, &title, source, &platform, &content, &hash, &now, &now],
            )
            .await;
            match r {
                Ok(_) => {}
                Err(Some(e)) => return Err(e),
                Err(None) => {
                    let row = find_by(db, &user.id, "content_hash", &hash).await?.ok_or_else(ApiError::internal)?;
                    return Ok(Created { row, duplicate: true, needs_processing: false });
                }
            }
            if !tags.is_empty() {
                set_tags(db, &user.id, &id, &tags).await?;
            }
            Ok(Created { row: get_owned(db, &user.id, &id).await?, duplicate: false, needs_processing: true })
        }
    }
}

async fn embed_blob(embedder: Option<&Embedder>, text: String) -> (Option<Vec<u8>>, Option<&'static str>, bool) {
    match embedder {
        None => (None, None, false),
        Some(e) => match e.embed(&[text]).await {
            Ok(mut v) if !v.is_empty() => (Some(to_blob(&v.remove(0))), Some(e.model()), false),
            _ => (None, None, true),
        },
    }
}

/// Pipeline: fetch (URL items) -> extract -> embed -> ready. Failures keep a stable code and are retryable.
/// Embedding failure is not fatal: the item stays searchable by words.
pub async fn process<F: PageFetcher>(db: &D1Database, embedder: Option<&Embedder>, fetcher: &F, instagram_token: Option<&str>, user_id: &str, item_id: &str) -> ApiResult<ItemRow> {
    let abandoned = iso_from_ms(now_ms() - 300_000.0);
    let claimed = db::run(
        db,
        "UPDATE knowledge_items SET status = 'processing', attempts = attempts + 1, error_code = NULL, updated_at = ?
         WHERE id = ? AND user_id = ? AND attempts < ? AND (status IN ('pending','failed') OR (status = 'processing' AND updated_at < ?))",
        args![now_iso(), item_id, user_id, MAX_ATTEMPTS, abandoned],
    )
    .await?;
    if claimed == 0 {
        return get_owned(db, user_id, item_id).await;
    }
    let row = get_owned(db, user_id, item_id).await?;
    let mut title = row.title.clone();
    let mut description = row.description.clone();
    let mut extracted = row.extracted_text.clone();
    let mut meta: Value = serde_json::from_str(&row.metadata).unwrap_or(json!({}));

    if let (true, Some(orig)) = (row.kind == "url", row.original_url.as_deref()) {
        let start = url::Url::parse(orig).map_err(|_| ApiError::internal())?;
        let host = start.host_str().unwrap_or("").to_string();
        match extract_link(fetcher, start, instagram_token).await {
            Ok(k) => {
                let ex = k.ex;
                if title.is_empty() {
                    title = if ex.title.is_empty() { k.final_url.host_str().unwrap_or("").to_string() } else { ex.title.clone() };
                }
                description = ex.description;
                extracted = ex.text;
                if let Value::Object(m) = k.meta {
                    for (key, val) in m {
                        meta[key] = val;
                    }
                }
                meta["finalUrl"] = json!(k.final_url.as_str());
                if !ex.site_name.is_empty() {
                    meta["siteName"] = json!(ex.site_name);
                }
            }
            Err(code) => {
                db::run(
                    db,
                    "UPDATE knowledge_items SET status = 'failed', error_code = ?, title = CASE WHEN title = '' THEN ? ELSE title END, updated_at = ? WHERE id = ? AND user_id = ?",
                    args![code, host, now_iso(), item_id, user_id],
                )
                .await?;
                return get_owned(db, user_id, item_id).await;
            }
        }
    }

    let (blob, model, failed) = embed_blob(embedder, embedding_text(&title, &description, &row.content, &extracted)).await;
    if failed {
        meta["embeddingError"] = json!(true);
    }
    let now = now_iso();
    db::run(
        db,
        "UPDATE knowledge_items SET title = ?, description = ?, extracted_text = ?, metadata = ?, embedding = ?, embedding_model = ?, status = 'ready', error_code = NULL, ingested_at = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        vec![title.into(), description.into(), extracted.into(), meta.to_string().into(), blob.map(Arg::Blob).unwrap_or(Arg::Null), model.map(str::to_string).into(), (&now).into(), (&now).into(), item_id.into(), user_id.into()],
    )
    .await?;
    get_owned(db, user_id, item_id).await
}

#[derive(Default)]
pub struct Patch {
    pub title: Option<String>,
    pub content: Option<String>,
    pub description: Option<String>,
    pub archived: Option<bool>,
    pub tags: Option<Vec<String>>,
}

pub async fn update(db: &D1Database, embedder: Option<&Embedder>, user_id: &str, id: &str, p: Patch) -> ApiResult<ItemRow> {
    let row = get_owned(db, user_id, id).await?;
    let title = p.title.map(|t| normalize_text(&t, TITLE_MAX)).unwrap_or_else(|| row.title.clone());
    let content = p.content.map(|t| normalize_text(&t, CONTENT_MAX)).unwrap_or_else(|| row.content.clone());
    let description = p.description.map(|t| normalize_text(&t, DESCRIPTION_MAX)).unwrap_or_else(|| row.description.clone());
    let archived = p.archived.map(|a| a as i64).unwrap_or(row.archived);
    let now = now_iso();
    if title != row.title || content != row.content || description != row.description {
        let (blob, model, _) = embed_blob(embedder, embedding_text(&title, &description, &content, &row.extracted_text)).await;
        db::run(
            db,
            "UPDATE knowledge_items SET title = ?, content = ?, description = ?, archived = ?, embedding = ?, embedding_model = ?, updated_at = ? WHERE id = ? AND user_id = ?",
            vec![title.into(), content.into(), description.into(), archived.into(), blob.map(Arg::Blob).unwrap_or(Arg::Null), model.map(str::to_string).into(), now.into(), id.into(), user_id.into()],
        )
        .await?;
    } else {
        db::run(db, "UPDATE knowledge_items SET archived = ?, updated_at = ? WHERE id = ? AND user_id = ?", args![archived, now, id, user_id]).await?;
    }
    if let Some(t) = p.tags {
        set_tags(db, user_id, id, &t).await?;
    }
    get_owned(db, user_id, id).await
}

pub async fn delete(db: &D1Database, user_id: &str, id: &str) -> ApiResult<()> {
    let n = db::run(db, "DELETE FROM knowledge_items WHERE id = ? AND user_id = ?", args![id, user_id]).await?;
    if n == 0 {
        return Err(ApiError::not_found("Item"));
    }
    db::run(db, PRUNE_TAGS, args![user_id, user_id]).await?;
    Ok(())
}
