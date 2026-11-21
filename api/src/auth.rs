//! Accounts and sessions.
//!
//! Sessions are opaque 256-bit random tokens. The database stores only their SHA-256,
//! so a leaked database does not yield usable sessions. Browsers carry the token in an
//! HttpOnly cookie; the desktop companion carries a long-lived device token as a Bearer header.

use serde::{Deserialize, Serialize};
use serde_json::json;
use worker::{D1Database, Request, Response};

use crate::args;
use crate::audit::audit;
use crate::db;
use crate::email::send_email;
use crate::error::{ApiError, ApiResult};
use crate::http::{self, Config};
use crate::password::{hash_password, verify_password, DUMMY_HASH};
use crate::util::{iso_in, new_id, new_token, normalize_text, now_iso, now_ms, sha256_hex};

const BROWSER_SESSION_MS: f64 = 30.0 * 86_400_000.0;
const DEVICE_SESSION_MS: f64 = 365.0 * 86_400_000.0;
const VERIFY_TTL_MS: f64 = 24.0 * 3_600_000.0;
const RESET_TTL_MS: f64 = 3_600_000.0;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    pub email: String,
    pub name: String,
    pub email_verified: bool,
    pub plan: String,
}

#[derive(Deserialize)]
struct UserRow {
    id: String,
    email: String,
    name: String,
    password_hash: String,
    email_verified: i64,
    plan: String,
}

impl UserRow {
    fn public(&self) -> AuthUser {
        AuthUser {
            id: self.id.clone(),
            email: self.email.clone(),
            name: self.name.clone(),
            email_verified: self.email_verified == 1,
            plan: match self.plan.as_str() {
                "plus" | "pro" => self.plan.clone(),
                _ => "free".into(),
            },
        }
    }
}

const USER_COLS: &str = "id, email, name, password_hash, email_verified, plan";

/// Who is calling, and how. Bearer (device) callers are exempt from cookie CSRF checks.
pub struct Caller {
    pub user: AuthUser,
    pub token_hash: String,
    pub via_bearer: bool,
}

/// Resolve the caller from a Bearer device token or the session cookie.
pub async fn resolve(req: &Request, db: &D1Database, cfg: &Config) -> ApiResult<Option<Caller>> {
    let (token, via_bearer) = match http::bearer(req) {
        Some(t) => (t, true),
        None => match http::cookie(req, cfg.cookie_name()) {
            Some(t) if !t.is_empty() && t.len() <= 128 => (t, false),
            _ => return Ok(None),
        },
    };
    let hash = sha256_hex(&token);
    let now = now_iso();
    let row: Option<UserRow> = db::first(
        db,
        &format!("SELECT u.{} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?", USER_COLS.replace(", ", ", u.")),
        args![&hash, &now],
    )
    .await?;
    let Some(row) = row else { return Ok(None) };
    // Touch at most once per hour to keep writes low.
    let stale = crate::util::iso_from_ms(now_ms() - 3_600_000.0);
    db::run(db, "UPDATE sessions SET last_used_at = ? WHERE token_hash = ? AND last_used_at < ?", args![&now, &hash, &stale]).await?;
    Ok(Some(Caller { user: row.public(), token_hash: hash, via_bearer }))
}

/// Fixed-window rate limit stored in D1. Returns Err(429) when exceeded. Disabled in tests.
async fn limit(db: &D1Database, cfg: &Config, bucket: &str, subject: &str, max: i64, window_s: i64) -> ApiResult<()> {
    if cfg.is_test() {
        return Ok(());
    }
    let key = sha256_hex(&format!("{bucket}:{subject}"));
    let now_s = (now_ms() / 1000.0) as i64;
    let start = now_s - now_s % window_s;
    #[derive(Deserialize)]
    struct C {
        count: i64,
    }
    let c: Option<C> = db::first(
        db,
        "INSERT INTO auth_rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
         ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start < ?2 THEN 1 ELSE count + 1 END,
                                        window_start = CASE WHEN window_start < ?2 THEN ?2 ELSE window_start END
         RETURNING count",
        args![&key, start],
    )
    .await?;
    if c.map(|c| c.count).unwrap_or(0) > max {
        return Err(ApiError::new(429, "rate_limited", "Too many attempts. Wait a minute and try again."));
    }
    Ok(())
}

async fn create_session(db: &D1Database, user_id: &str, kind: &str, label: &str) -> ApiResult<String> {
    let token = new_token();
    let ttl = if kind == "device" { DEVICE_SESSION_MS } else { BROWSER_SESSION_MS };
    let now = now_iso();
    db::run(
        db,
        "INSERT INTO sessions (token_hash, user_id, kind, label, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args![sha256_hex(&token), user_id, kind, label, &now, &now, iso_in(ttl)],
    )
    .await?;
    audit(db, Some(user_id), "session.created", json!({ "kind": kind })).await?;
    Ok(token)
}

async fn issue_email_token(db: &D1Database, user_id: &str, purpose: &str, ttl: f64) -> ApiResult<String> {
    let token = new_token();
    db::run(db, "DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?", args![user_id, purpose]).await?;
    db::run(
        db,
        "INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
        args![sha256_hex(&token), user_id, purpose, iso_in(ttl), now_iso()],
    )
    .await?;
    Ok(token)
}

/// Single-use: the token row is deleted in the same statement that reads it.
async fn consume_email_token(db: &D1Database, token: &str, purpose: &str) -> ApiResult<Option<String>> {
    #[derive(Deserialize)]
    struct R {
        user_id: String,
    }
    let r: Option<R> = db::first(
        db,
        "DELETE FROM email_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ? RETURNING user_id",
        args![sha256_hex(token), purpose, now_iso()],
    )
    .await?;
    Ok(r.map(|r| r.user_id))
}

fn valid_email(e: &str) -> bool {
    let e = e.trim();
    if e.len() > 254 || e.contains(char::is_whitespace) {
        return false;
    }
    match e.split_once('@') {
        Some((l, d)) => !l.is_empty() && d.contains('.') && !d.starts_with('.') && !d.ends_with('.') && !d.contains('@'),
        None => false,
    }
}

fn check_password(p: &str) -> ApiResult<()> {
    let n = p.chars().count();
    if n < 10 {
        return Err(ApiError::new(422, "password_too_short", "Use at least 10 characters."));
    }
    if n > 128 {
        return Err(ApiError::new(422, "password_too_long", "Use 128 characters or fewer."));
    }
    Ok(())
}

async fn send_verification(db: &D1Database, cfg: &Config, user_id: &str, email: &str) -> ApiResult<()> {
    let token = issue_email_token(db, user_id, "verify", VERIFY_TTL_MS).await?;
    let link = format!("{}/api/auth/verify-email?token={}", cfg.app_url, token);
    send_email(cfg, email, "Verify your Cognis email", &format!("Welcome to Cognis.\n\nVerify your email here: {link}\n\nThe link expires in 24 hours. If you did not create an account, ignore this email.")).await
}

// ---------- handlers ----------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignUp {
    email: String,
    password: String,
    #[serde(default)]
    name: String,
}

pub async fn sign_up(mut req: Request, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    limit(db, cfg, "sign-up", &http::client_ip(&req), 5, 60).await?;
    let b: SignUp = http::json_body(&mut req).await?;
    let email = b.email.trim().to_lowercase();
    if !valid_email(&email) {
        return Err(ApiError::validation("email", "Enter a valid email address."));
    }
    check_password(&b.password)?;
    let name = normalize_text(&b.name, 80);
    // Hash before the existence check so both paths cost the same.
    let hash = hash_password(&b.password);
    let id = new_id("usr");
    let now = now_iso();
    match db::run_unique(
        db,
        "INSERT INTO users (id, email, name, password_hash, email_verified, plan, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'free', ?, ?)",
        args![&id, &email, &name, &hash, &now, &now],
    )
    .await
    {
        Ok(_) => {}
        Err(Some(e)) => return Err(e),
        Err(None) => {
            if cfg.email_enabled() {
                // Do not reveal that the account exists. Tell the owner instead.
                send_email(cfg, &email, "Someone tried to sign up with your email", "Someone tried to create a Cognis account with this email, which already has one. If it was you, sign in or reset your password.").await?;
                return http::ok(&json!({ "verificationRequired": true }));
            }
            return Err(ApiError::new(409, "email_taken", "An account with this email already exists. Sign in instead."));
        }
    }
    audit(db, Some(&id), "account.created", json!({})).await?;
    if cfg.email_enabled() {
        send_verification(db, cfg, &id, &email).await?;
        return http::ok(&json!({ "verificationRequired": true }));
    }
    let token = create_session(db, &id, "browser", "").await?;
    let user = AuthUser { id, email, name, email_verified: false, plan: "free".into() };
    let res = http::ok(&json!({ "user": user, "verificationRequired": false }))?;
    http::set_cookie(&res, cfg, &token, (BROWSER_SESSION_MS / 1000.0) as i64)?;
    Ok(res)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignIn {
    email: String,
    password: String,
    /// Set by the desktop companion: returns a device token in the body instead of a cookie.
    device: Option<String>,
}

pub async fn sign_in(mut req: Request, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    let ip = http::client_ip(&req);
    limit(db, cfg, "sign-in-ip", &ip, 10, 60).await?;
    let b: SignIn = http::json_body(&mut req).await?;
    let email = b.email.trim().to_lowercase();
    limit(db, cfg, "sign-in-email", &email, 5, 60).await?;
    let row: Option<UserRow> = db::first(db, &format!("SELECT {USER_COLS} FROM users WHERE email = ?"), args![&email]).await?;
    let ok = match &row {
        Some(r) => verify_password(&r.password_hash, &b.password),
        None => {
            let _ = verify_password(DUMMY_HASH, &b.password); // equalize timing
            false
        }
    };
    let Some(row) = row.filter(|_| ok) else {
        audit(db, None, "sign_in.failed", json!({})).await?;
        return Err(ApiError::new(401, "invalid_credentials", "That email and password do not match."));
    };
    if cfg.email_enabled() && row.email_verified == 0 {
        return Err(ApiError::new(403, "email_not_verified", "Verify your email first. We sent you a link when you signed up."));
    }
    if let Some(label) = b.device {
        let label = normalize_text(&label, 60);
        let token = create_session(db, &row.id, "device", if label.is_empty() { "Desktop companion" } else { &label }).await?;
        return http::ok(&json!({ "user": row.public(), "token": token }));
    }
    let token = create_session(db, &row.id, "browser", "").await?;
    let res = http::ok(&json!({ "user": row.public() }))?;
    http::set_cookie(&res, cfg, &token, (BROWSER_SESSION_MS / 1000.0) as i64)?;
    Ok(res)
}

pub async fn sign_out(caller: &Caller, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    db::run(db, "DELETE FROM sessions WHERE token_hash = ?", args![&caller.token_hash]).await?;
    let res = http::ok(&json!({ "ok": true }))?;
    http::clear_cookie(&res, cfg)?;
    Ok(res)
}

pub async fn verify_email(req: &Request, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    let token = http::query(req).remove("token").unwrap_or_default();
    let Some(uid) = (if token.is_empty() || token.len() > 128 { None } else { consume_email_token(db, &token, "verify").await? }) else {
        return http::redirect("/sign-in?error=invalid_token");
    };
    db::run(db, "UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?", args![now_iso(), &uid]).await?;
    audit(db, Some(&uid), "email.verified", json!({})).await?;
    let session = create_session(db, &uid, "browser", "").await?;
    let res = http::redirect("/app/welcome")?;
    http::set_cookie(&res, cfg, &session, (BROWSER_SESSION_MS / 1000.0) as i64)?;
    Ok(res)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmailOnly {
    email: String,
}

/// Always answers 200, so the response never reveals whether an account exists.
pub async fn resend_verification(mut req: Request, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    limit(db, cfg, "resend", &http::client_ip(&req), 3, 300).await?;
    let b: EmailOnly = http::json_body(&mut req).await?;
    let email = b.email.trim().to_lowercase();
    if cfg.email_enabled() {
        let row: Option<UserRow> = db::first(db, &format!("SELECT {USER_COLS} FROM users WHERE email = ? AND email_verified = 0"), args![&email]).await?;
        if let Some(r) = row {
            send_verification(db, cfg, &r.id, &r.email).await?;
        }
    }
    http::ok(&json!({ "ok": true }))
}

pub async fn request_reset(mut req: Request, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    limit(db, cfg, "reset", &http::client_ip(&req), 3, 300).await?;
    let b: EmailOnly = http::json_body(&mut req).await?;
    if !cfg.email_enabled() {
        return Err(ApiError::new(503, "email_unavailable", "Password reset by email is not available yet."));
    }
    let email = b.email.trim().to_lowercase();
    let row: Option<UserRow> = db::first(db, &format!("SELECT {USER_COLS} FROM users WHERE email = ?"), args![&email]).await?;
    if let Some(r) = row {
        let token = issue_email_token(db, &r.id, "reset", RESET_TTL_MS).await?;
        let link = format!("{}/reset-password?token={}", cfg.app_url, token);
        send_email(cfg, &r.email, "Reset your Cognis password", &format!("Someone asked to reset the password for your Cognis account.\n\nReset it here: {link}\n\nThe link expires in 1 hour. If you did not ask for this, ignore this email.")).await?;
    }
    http::ok(&json!({ "ok": true }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Reset {
    token: String,
    new_password: String,
}

pub async fn reset_password(mut req: Request, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    limit(db, cfg, "reset-confirm", &http::client_ip(&req), 10, 300).await?;
    let b: Reset = http::json_body(&mut req).await?;
    check_password(&b.new_password)?;
    if b.token.len() > 128 {
        return Err(ApiError::new(400, "invalid_token", "This link has expired. Request a new one."));
    }
    let Some(uid) = consume_email_token(db, &b.token, "reset").await? else {
        return Err(ApiError::new(400, "invalid_token", "This link has expired. Request a new one."));
    };
    db::batch(
        db,
        vec![
            db::stmt(db, "UPDATE users SET password_hash = ?, email_verified = 1, updated_at = ? WHERE id = ?", args![hash_password(&b.new_password), now_iso(), &uid])?,
            db::stmt(db, "DELETE FROM sessions WHERE user_id = ?", args![&uid])?,
        ],
    )
    .await?;
    audit(db, Some(&uid), "password.reset", json!({})).await?;
    http::ok(&json!({ "ok": true }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ChangePw {
    current_password: String,
    new_password: String,
}

pub async fn change_password(mut req: Request, caller: &Caller, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    limit(db, cfg, "change-pw", &caller.user.id, 5, 60).await?;
    let b: ChangePw = http::json_body(&mut req).await?;
    check_password(&b.new_password)?;
    let row: UserRow = db::first(db, &format!("SELECT {USER_COLS} FROM users WHERE id = ?"), args![&caller.user.id]).await?.ok_or_else(ApiError::unauthenticated)?;
    if !verify_password(&row.password_hash, &b.current_password) {
        return Err(ApiError::new(401, "invalid_credentials", "Your current password is not correct."));
    }
    db::batch(
        db,
        vec![
            db::stmt(db, "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", args![hash_password(&b.new_password), now_iso(), &row.id])?,
            db::stmt(db, "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", args![&row.id, &caller.token_hash])?,
        ],
    )
    .await?;
    audit(db, Some(&row.id), "password.changed", json!({})).await?;
    http::ok(&json!({ "ok": true }))
}

pub async fn list_sessions(caller: &Caller, db: &D1Database) -> ApiResult<Response> {
    #[derive(Deserialize, Serialize)]
    #[serde(rename_all(serialize = "camelCase"))]
    struct S {
        id: String,
        kind: String,
        label: String,
        created_at: String,
        last_used_at: String,
        current: i64,
    }
    let rows: Vec<S> = db::all(
        db,
        "SELECT substr(token_hash, 1, 16) AS id, kind, label, created_at, last_used_at, (token_hash = ?) AS current FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_used_at DESC",
        args![&caller.token_hash, &caller.user.id, now_iso()],
    )
    .await?;
    http::ok(&json!({ "sessions": rows.into_iter().map(|s| json!({ "id": s.id, "kind": s.kind, "label": s.label, "createdAt": s.created_at, "lastUsedAt": s.last_used_at, "current": s.current == 1 })).collect::<Vec<_>>() }))
}

pub async fn revoke_session(caller: &Caller, db: &D1Database, id: &str) -> ApiResult<Response> {
    if id.len() != 16 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::not_found("Session"));
    }
    let n = db::run(db, "DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?", args![&caller.user.id, id]).await?;
    if n == 0 {
        return Err(ApiError::not_found("Session"));
    }
    audit(db, Some(&caller.user.id), "session.revoked", json!({})).await?;
    http::no_content()
}

pub async fn revoke_others(caller: &Caller, db: &D1Database) -> ApiResult<Response> {
    db::run(db, "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", args![&caller.user.id, &caller.token_hash]).await?;
    audit(db, Some(&caller.user.id), "session.revoked_others", json!({})).await?;
    http::ok(&json!({ "ok": true }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteAccount {
    password: String,
}

/// Deletes the user row; foreign keys cascade to sessions, tokens, items, tags, collections.
pub async fn delete_account(mut req: Request, caller: &Caller, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    limit(db, cfg, "delete-account", &caller.user.id, 5, 60).await?;
    let b: DeleteAccount = http::json_body(&mut req).await?;
    let row: UserRow = db::first(db, &format!("SELECT {USER_COLS} FROM users WHERE id = ?"), args![&caller.user.id]).await?.ok_or_else(ApiError::unauthenticated)?;
    if !verify_password(&row.password_hash, &b.password) {
        return Err(ApiError::new(401, "invalid_credentials", "That password is not correct."));
    }
    db::run(db, "DELETE FROM users WHERE id = ?", args![&row.id]).await?;
    audit(db, Some(&row.id), "account.deleted", json!({})).await?;
    let res = http::ok(&json!({ "ok": true }))?;
    http::clear_cookie(&res, cfg)?;
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::valid_email;

    #[test]
    fn email_shape() {
        for ok in ["a@b.co", "first.last+tag@sub.example.com"] {
            assert!(valid_email(ok), "{ok}");
        }
        for bad in ["", "a", "a@b", "@b.com", "a@.com", "a@b.com.", "a b@c.com", "a@b@c.com"] {
            assert!(!valid_email(bad), "{bad}");
        }
    }
}
