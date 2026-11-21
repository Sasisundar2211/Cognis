//! Pure ranking logic: query tokenization, FTS query building, Reciprocal Rank Fusion, explanations.

use std::collections::HashMap;

pub const RRF_K: f64 = 60.0;
/// Snippet highlight markers. Control chars are stripped on ingest, so they cannot occur in content.
pub const HL_START: char = '\u{0002}';
pub const HL_END: char = '\u{0003}';

const STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have", "how", "i", "in", "is", "it", "its", "of", "on", "or",
    "that", "the", "this", "to", "was", "what", "when", "where", "which", "who", "why", "with", "you", "your",
];

/// Split a free-text query into at most 12 lowercase alphanumeric terms.
pub fn query_terms(q: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for tok in q.to_lowercase().split(|c: char| !c.is_alphanumeric()) {
        if tok.is_empty() || tok.chars().count() > 40 || STOPWORDS.contains(&tok) || out.iter().any(|t| t == tok) {
            continue;
        }
        out.push(tok.to_string());
        if out.len() >= 12 {
            break;
        }
    }
    out
}

/// Each term is quoted, so FTS5 operators in user input (NEAR, column filters, *) are inert.
pub fn fts_query(terms: &[String]) -> String {
    terms.iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(" OR ")
}

/// score(d) = sum over retrievers of 1 / (k + rank), rank starting at 1.
pub fn rrf(lists: &[Vec<String>]) -> Vec<(String, f64)> {
    let mut s: HashMap<String, f64> = HashMap::new();
    let mut first_seen: Vec<String> = vec![];
    for list in lists {
        for (i, id) in list.iter().enumerate() {
            if !s.contains_key(id) {
                first_seen.push(id.clone());
            }
            *s.entry(id.clone()).or_default() += 1.0 / (RRF_K + i as f64 + 1.0);
        }
    }
    let mut v: Vec<(String, f64)> = first_seen.into_iter().map(|id| { let sc = s[&id]; (id, sc) }).collect();
    v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    v
}

pub fn highlighted_terms(snippet: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut rest = snippet;
    while let Some(s) = rest.find(HL_START) {
        let after = &rest[s + HL_START.len_utf8()..];
        let Some(e) = after.find(HL_END) else { break };
        let t = after[..e].to_lowercase();
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
        rest = &after[e + HL_END.len_utf8()..];
    }
    out.truncate(6);
    out
}

/// Plain-language reason built only from retrieval evidence. Never invented.
pub fn explain(lexical: bool, semantic: bool, terms: &[String]) -> String {
    let mut parts: Vec<String> = vec![];
    if lexical && !terms.is_empty() {
        parts.push(format!("Contains {}", terms.iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(", ")));
    } else if lexical {
        parts.push("Contains words from your search".into());
    }
    if semantic {
        parts.push(if parts.is_empty() { "Close in meaning to your search".into() } else { "and is close in meaning".into() });
    }
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizes_hostile_input_into_inert_terms() {
        assert_eq!(query_terms("title:secret OR \"x\" NEAR(a b) * -- ; DROP TABLE"), ["title", "secret", "x", "near", "b", "drop", "table"]);
        assert_eq!(fts_query(&["a1".into(), "b".into()]), "\"a1\" OR \"b\"");
        assert!(query_terms("the a of").is_empty());
        assert_eq!(query_terms("日本語 テスト"), ["日本語", "テスト"]);
    }

    #[test]
    fn rrf_k60() {
        let r = rrf(&[vec!["a".into(), "b".into()], vec!["b".into(), "c".into()]]);
        assert_eq!(r[0].0, "b");
        assert!((r[0].1 - (1.0 / 62.0 + 1.0 / 61.0)).abs() < 1e-12);
        let a = r.iter().find(|x| x.0 == "a").unwrap().1;
        assert!((a - 1.0 / 61.0).abs() < 1e-12);
    }

    #[test]
    fn explanations_use_evidence() {
        let snip = format!("post in niche {HL_START}subreddits{HL_END} and {HL_START}Launch{HL_END}");
        let t = highlighted_terms(&snip);
        assert_eq!(t, ["subreddits", "launch"]);
        assert_eq!(explain(true, false, &t), "Contains \"subreddits\", \"launch\"");
        assert_eq!(explain(true, true, &t), "Contains \"subreddits\", \"launch\" and is close in meaning");
        assert_eq!(explain(false, true, &[]), "Close in meaning to your search");
    }
}
