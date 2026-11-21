//! Metadata filters shared by lexical, semantic and list queries. Values are always bound.

use crate::db::Arg;

#[derive(Default, Clone)]
pub struct Filters {
    pub source: Option<String>,
    pub tag: Option<String>,
    pub collection: Option<String>,
    pub status: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub include_archived: bool,
}

impl Filters {
    /// Returns an SQL fragment starting with " AND ..." (or empty) plus its arguments.
    pub fn sql(&self, a: &str) -> (String, Vec<Arg>) {
        let mut c: Vec<String> = vec![];
        let mut p: Vec<Arg> = vec![];
        if !self.include_archived {
            c.push(format!("{a}.archived = 0"));
        }
        let mut eq = |col: &str, v: &Option<String>, op: &str| {
            if let Some(v) = v {
                c.push(format!("{a}.{col} {op} ?"));
                p.push(Arg::Text(v.clone()));
            }
        };
        eq("source_platform", &self.source, "=");
        eq("status", &self.status, "=");
        eq("created_at", &self.from, ">=");
        eq("created_at", &self.to, "<=");
        if let Some(t) = &self.tag {
            c.push(format!("EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = {a}.id AND it.user_id = {a}.user_id AND t.name = ?)"));
            p.push(Arg::Text(t.clone()));
        }
        if let Some(col) = &self.collection {
            c.push(format!("EXISTS (SELECT 1 FROM collection_items ci WHERE ci.item_id = {a}.id AND ci.user_id = {a}.user_id AND ci.collection_id = ?)"));
            p.push(Arg::Text(col.clone()));
        }
        (if c.is_empty() { String::new() } else { format!(" AND {}", c.join(" AND ")) }, p)
    }
}
