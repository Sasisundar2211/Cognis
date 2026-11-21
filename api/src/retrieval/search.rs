//! Hybrid retrieval over D1: FTS5 BM25 + brute-force cosine over stored embeddings, fused with RRF (k=60).

use serde::Deserialize;
use worker::D1Database;

use super::embed::{dot, from_blob, Embedder};
use super::filters::Filters;
use super::rank::{explain, fts_query, highlighted_terms, query_terms, rrf, HL_END, HL_START};
use crate::db::{self, Arg};
use crate::error::ApiResult;

const CANDIDATES: usize = 50;
/// Max items scanned per semantic query (newest first). See docs/KNOWN-LIMITATIONS.md.
pub const SEMANTIC_SCAN_LIMIT: usize = 2000;

pub struct Hit {
    pub id: String,
    pub snippet: String,
    pub reason: String,
    pub lexical: bool,
    pub semantic: bool,
    pub similarity: Option<f32>,
}

pub struct SearchOut {
    pub hits: Vec<Hit>,
    pub total: usize,
    pub mode_used: &'static str,
    pub degraded: bool,
}

#[derive(Deserialize)]
struct LexRow {
    id: String,
    snippet: String,
}

async fn lexical(db: &D1Database, user_id: &str, terms: &[String], f: &Filters) -> ApiResult<Vec<LexRow>> {
    if terms.is_empty() {
        return Ok(vec![]);
    }
    let (fsql, fargs) = f.sql("k");
    let sql = format!(
        "SELECT k.id AS id, snippet(knowledge_fts, -1, '{HL_START}', '{HL_END}', '…', 16) AS snippet
         FROM knowledge_fts JOIN knowledge_items k ON k.seq = knowledge_fts.rowid
         WHERE knowledge_fts MATCH ? AND k.user_id = ?{fsql}
         ORDER BY bm25(knowledge_fts, 4.0, 2.0, 1.0, 1.0) LIMIT {CANDIDATES}"
    );
    let mut a: Vec<Arg> = vec![fts_query(terms).into(), user_id.into()];
    a.extend(fargs);
    db::all(db, &sql, a).await
}

#[derive(Deserialize)]
struct EmbRow {
    id: String,
    #[serde(with = "serde_bytes")]
    embedding: Vec<u8>,
}

async fn semantic(db: &D1Database, user_id: &str, qv: &[f32], min_sim: f32, f: &Filters) -> ApiResult<Vec<(String, f32)>> {
    let (fsql, fargs) = f.sql("k");
    let sql = format!("SELECT k.id AS id, k.embedding AS embedding FROM knowledge_items k WHERE k.user_id = ? AND k.embedding IS NOT NULL{fsql} ORDER BY k.created_at DESC LIMIT {SEMANTIC_SCAN_LIMIT}");
    let mut a: Vec<Arg> = vec![user_id.into()];
    a.extend(fargs);
    let rows: Vec<EmbRow> = db::all(db, &sql, a).await?;
    let mut scored: Vec<(String, f32)> = rows
        .into_iter()
        .filter_map(|r| {
            let v = from_blob(&r.embedding)?;
            let s = dot(qv, &v);
            (s >= min_sim).then_some((r.id, s))
        })
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(CANDIDATES);
    Ok(scored)
}

pub async fn search(db: &D1Database, embedder: Option<&Embedder>, user_id: &str, query: &str, mode: &str, f: &Filters, limit: usize, offset: usize) -> ApiResult<SearchOut> {
    let terms = query_terms(query);
    let mut mode_used: &'static str = match mode {
        "lexical" => "lexical",
        "semantic" => "semantic",
        _ => "hybrid",
    };
    let mut degraded = false;
    let mut qv: Option<Vec<f32>> = None;
    if mode_used != "lexical" {
        if let Some(e) = embedder {
            let q: String = query.chars().take(1000).collect();
            qv = e.embed(&[q]).await.ok().and_then(|mut v| (!v.is_empty()).then(|| v.remove(0)));
        }
        if qv.is_none() {
            // Graceful fallback: semantic unavailable, answer lexically and say so.
            degraded = true;
            mode_used = "lexical";
        }
    }
    let lex = if mode_used == "semantic" { vec![] } else { lexical(db, user_id, &terms, f).await? };
    let sem = match (&qv, mode_used) {
        (Some(v), m) if m != "lexical" => semantic(db, user_id, v, embedder.map(|e| e.min_similarity()).unwrap_or(0.45), f).await?,
        _ => vec![],
    };
    let lex_ids: Vec<String> = lex.iter().map(|r| r.id.clone()).collect();
    let sem_ids: Vec<String> = sem.iter().map(|r| r.0.clone()).collect();
    let fused = rrf(&[lex_ids.clone(), sem_ids.clone()]);
    let total = fused.len();
    let hits = fused
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|(id, _)| {
            let snippet = lex.iter().find(|r| r.id == id).map(|r| r.snippet.clone()).unwrap_or_default();
            let lexical = lex_ids.contains(&id);
            let similarity = sem.iter().find(|r| r.0 == id).map(|r| r.1);
            let terms = highlighted_terms(&snippet);
            Hit { reason: explain(lexical, similarity.is_some(), &terms), id, snippet, lexical, semantic: similarity.is_some(), similarity }
        })
        .collect();
    Ok(SearchOut { hits, total, mode_used, degraded })
}
