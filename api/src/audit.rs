//! Security events. Never pass content, emails, IPs or tokens in `detail`.

use serde_json::Value;
use worker::D1Database;

use crate::args;
use crate::db;
use crate::error::ApiResult;
use crate::util::{new_id, now_iso};

pub async fn audit(db: &D1Database, user_id: Option<&str>, event: &str, detail: Value) -> ApiResult<()> {
    db::run(
        db,
        "INSERT INTO audit_events (id, user_id, event, detail, created_at) VALUES (?, ?, ?, ?, ?)",
        args![new_id("evt"), user_id.map(str::to_string), event, detail.to_string(), now_iso()],
    )
    .await?;
    Ok(())
}
