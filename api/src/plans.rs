//! Plan entitlements, enforced server-side. Billing is not connected; every account is "free".

pub struct Limits {
    pub max_items: i64,
    pub max_collections: i64,
    pub max_url_ingest_per_day: i64,
    pub max_asks_per_day: i64,
}

pub fn limits(plan: &str) -> Limits {
    match plan {
        "plus" => Limits { max_items: 10_000, max_collections: 200, max_url_ingest_per_day: 500, max_asks_per_day: 200 },
        "pro" => Limits { max_items: 50_000, max_collections: 1_000, max_url_ingest_per_day: 2_000, max_asks_per_day: 1_000 },
        _ => Limits { max_items: 500, max_collections: 10, max_url_ingest_per_day: 50, max_asks_per_day: 30 },
    }
}

impl Limits {
    pub fn json(&self) -> serde_json::Value {
        serde_json::json!({ "maxItems": self.max_items, "maxCollections": self.max_collections, "maxUrlIngestPerDay": self.max_url_ingest_per_day, "maxAsksPerDay": self.max_asks_per_day })
    }
}
