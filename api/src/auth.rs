//! Accounts and sessions, with passkeys (WebAuthn) instead of passwords.
//!
//! - Sign up: email + name, then create a passkey (Face ID, Touch ID, Windows Hello, a phone or a
//!   security key). Eight one-time recovery codes are shown once.
//! - Sign in: choose a passkey. No email or password needed.
//! - Lost every device: sign in with a recovery code, then add a new passkey.
//! - Desktop companion: the web app issues a 10-minute pairing code; the desktop exchanges it for
//!   a long-lived, revocable device token.
//!
//! Every secret (session, device token, recovery code, pairing code) is a high-entropy random value
//! stored only as SHA-256. Passkey verification costs a few milliseconds of CPU, which fits the
//! Workers free plan; password hashing did not.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use worker::{D1Database, Request, Response};

use crate::args;
use crate::audit::audit;
use crate::db::{self, Arg};
use crate::error::{ApiError, ApiResult};
use crate::http::{self, Config};
use crate::util::{iso_from_ms, iso_in, new_id, new_token, normalize_text, now_iso, now_ms, random_bytes, sha256_hex};
use crate::webauthn::{self, b64, unb64, Expect};

const BROWSER_SESSION_MS: f64 = 30.0 * 86_400_000.0;
const DEVICE_SESSION_MS: f64 = 365.0 * 86_400_000.0;
const CHALLENGE_TTL_MS: f64 = 5.0 * 60_000.0;
const PAIRING_TTL_MS: f64 = 10.0 * 60_000.0;
const FRESH_SESSION_MS: f64 = 15.0 * 60_000.0;
const RECOVERY_CODES: usize = 8;

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
    email_verified: i64,
    plan: String,
    webauthn_handle: Option<String>,
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

const USER_COLS: &str = "id, email, name, email_verified, plan, webauthn_handle";

/// Who is calling, and how. Bearer (device) callers are exempt from cookie CSRF checks.
pub struct Caller {
    pub user: AuthUser,
    pub token_hash: String,
    pub via_bearer: bool,
    pub session_created_at: String,
}

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
    #[derive(Deserialize)]
    struct R {
        id: String,
        email: String,
        name: String,
        email_verified: i64,
        plan: String,
        webauthn_handle: Option<String>,
        session_created_at: String,
    }
    let row: Option<R> = db::first(
        db,
        "SELECT u.id, u.email, u.name, u.email_verified, u.plan, u.webauthn_handle, s.created_at AS session_created_at
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
        args![&hash, &now],
    )
    .await?;
    let Some(r) = row else { return Ok(None) };
    let stale = iso_from_ms(now_ms() - 3_600_000.0);
    db::run(db, "UPDATE sessions SET last_used_at = ? WHERE token_hash = ? AND last_used_at < ?", args![&now, &hash, &stale]).await?;
    let user = UserRow { id: r.id, email: r.email, name: r.name, email_verified: r.email_verified, plan: r.plan, webauthn_handle: r.webauthn_handle }.public();
    Ok(Some(Caller { user, token_hash: hash, via_bearer, session_created_at: r.session_created_at }))
}

/// Fixed-window rate limit stored in D1. Disabled in tests.
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

fn browser_session_response(cfg: &Config, token: &str, body: Value) -> ApiResult<Response> {
    let res = http::ok(&body)?;
    http::set_cookie(&res, cfg, token, (BROWSER_SESSION_MS / 1000.0) as i64)?;
    Ok(res)
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

fn rp_id(cfg: &Config) -> String {
    url::Url::parse(&cfg.app_url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| "localhost".into())
}

fn expect<'a>(cfg_rp: &'a str, origin: &'a str, challenge: &'a str) -> Expect<'a> {
    Expect { rp_id: cfg_rp, origin, challenge }
}

/// Human-friendly code from a random value: groups of 4 from an alphabet without look-alikes.
fn friendly_code(bytes: &[u8], groups: usize) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols, 5 bits each
    let mut bits: u64 = 0;
    let mut nbits = 0;
    let mut out = String::new();
    let mut i = 0;
    let mut chars = 0;
    while chars < groups * 4 {
        if nbits < 5 {
            bits = (bits << 8) | bytes[i % bytes.len()] as u64;
            nbits += 8;
            i += 1;
        }
        nbits -= 5;
        let idx = ((bits >> nbits) & 31) as usize;
        if chars > 0 && chars % 4 == 0 {
            out.push('-');
        }
        out.push(ALPHABET[idx] as char);
        chars += 1;
    }
    out
}

/// Normalize a typed code: uppercase, drop spaces and dashes. The alphabet has no 0/O or 1/I.
fn normalize_code(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

fn code_hash(code: &str) -> String {
    sha256_hex(&format!("cognis-code:{}", normalize_code(code)))
}

async fn issue_recovery_codes(db: &D1Database, user_id: &str) -> ApiResult<Vec<String>> {
    let mut codes = vec![];
    let mut stmts = vec![db::stmt(db, "DELETE FROM recovery_codes WHERE user_id = ?", args![user_id])?];
    for _ in 0..RECOVERY_CODES {
        let r: [u8; 10] = random_bytes(); // 80 bits
        let code = friendly_code(&r, 4);
        stmts.push(db::stmt(db, "INSERT INTO recovery_codes (code_hash, user_id) VALUES (?, ?)", args![code_hash(&code), user_id])?);
        codes.push(code);
    }
    db::batch(db, stmts).await?;
    Ok(codes)
}

async fn new_challenge(db: &D1Database, purpose: &str, user_id: Option<&str>, email: Option<&str>, name: Option<&str>, handle: Option<&str>) -> ApiResult<(String, String)> {
    let id = new_id("wch");
    let challenge = b64(&random_bytes::<32>());
    // Opportunistic cleanup of expired challenges.
    db::run(db, "DELETE FROM webauthn_challenges WHERE expires_at < ?", args![now_iso()]).await?;
    db::run(
        db,
        "INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, pending_email, pending_name, user_handle, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        args![&id, &challenge, purpose, user_id.map(str::to_string), email.map(str::to_string), name.map(str::to_string), handle.map(str::to_string), iso_in(CHALLENGE_TTL_MS)],
    )
    .await?;
    Ok((id, challenge))
}

#[derive(Deserialize)]
struct ChallengeRow {
    challenge: String,
    user_id: Option<String>,
    pending_email: Option<String>,
    pending_name: Option<String>,
    user_handle: Option<String>,
}

/// Single use: deleted in the statement that reads it.
async fn take_challenge(db: &D1Database, id: &str, purpose: &str) -> ApiResult<ChallengeRow> {
    if !id.starts_with("wch_") || id.len() > 40 {
        return Err(ApiError::new(400, "invalid_challenge", "This sign-in attempt expired. Try again."));
    }
    db::first(
        db,
        "DELETE FROM webauthn_challenges WHERE id = ? AND purpose = ? AND expires_at > ? RETURNING challenge, user_id, pending_email, pending_name, user_handle",
        args![id, purpose, now_iso()],
    )
    .await?
    .ok_or_else(|| ApiError::new(400, "invalid_challenge", "This sign-in attempt expired. Try again."))
}

fn creation_options(cfg: &Config, challenge: &str, handle: &str, email: &str, name: &str, exclude: &[String]) -> Value {
    json!({
        "challenge": challenge,
        "rp": { "id": rp_id(cfg), "name": "Cognis" },
        "user": { "id": handle, "name": email, "displayName": if name.is_empty() { email } else { name } },
        "pubKeyCredParams": [{ "type": "public-key", "alg": webauthn::ALG_ES256 }, { "type": "public-key", "alg": webauthn::ALG_RS256 }],
        "authenticatorSelection": { "residentKey": "required", "requireResidentKey": true, "userVerification": "preferred" },
        "attestation": "none",
        "timeout": 120000,
        "excludeCredentials": exclude.iter().map(|id| json!({ "type": "public-key", "id": id })).collect::<Vec<_>>(),
    })
}

fn bad_passkey(code: &str) -> ApiError {
    // Do not reveal which check failed beyond a stable code.
    ApiError::new(400, "passkey_rejected", "That passkey could not be verified. Try again.").with_details(json!({ "reason": code }))
}

// ---------- sign up ----------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegisterStart {
    email: String,
    #[serde(default)]
    name: String,
}

pub async fn register_options(mut req: Request, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    limit(db, cfg, "register", &http::client_ip(&req), 10, 60).await?;
    let b: RegisterStart = http::json_body(&mut req).await?;
    let email = b.email.trim().to_lowercase();
    if !valid_email(&email) {
        return Err(ApiError::validation("email", "Enter a valid email address."));
    }
    let name = normalize_text(&b.name, 80);
    let exists: Option<db::Count> = db::first(db, "SELECT COUNT(*) AS n FROM users WHERE email = ?", args![&email]).await?;
    if exists.map(|c| c.n).unwrap_or(0) > 0 {
        return Err(ApiError::new(409, "email_taken", "An account with this email already exists. Sign in with your passkey instead."));
    }
    let handle = b64(&random_bytes::<16>());
    let (cid, challenge) = new_challenge(db, "register", None, Some(&email), Some(&name), Some(&handle)).await?;
    http::ok(&json!({ "challengeId": cid, "publicKey": creation_options(cfg, &challenge, &handle, &email, &name, &[]) }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RegisterFinish {
    challenge_id: String,
    id: String,
    client_data_json: String,
    attestation_object: String,
    #[serde(default)]
    name: Option<String>,
}

async fn store_passkey(db: &D1Database, user_id: &str, reg: &webauthn::Registered, name: &str) -> ApiResult<()> {
    let id = b64(&reg.credential_id);
    match db::run_unique(
        db,
        "INSERT INTO passkeys (id, user_id, public_key, sign_count, name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        vec![id.into(), user_id.into(), Arg::Blob(reg.cose_key.clone()), (reg.sign_count as i64).into(), normalize_text(name, 60).into(), now_iso().into()],
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(None) => Err(ApiError::new(409, "passkey_exists", "This passkey is already registered.")),
        Err(Some(e)) => Err(e),
    }
}

fn finish_registration(cfg: &Config, ch: &ChallengeRow, b: &RegisterFinish) -> ApiResult<webauthn::Registered> {
    let rp = rp_id(cfg);
    let origin = cfg.origin();
    let cd = unb64(&b.client_data_json).map_err(bad_passkey)?;
    let att = unb64(&b.attestation_object).map_err(bad_passkey)?;
    let reg = webauthn::verify_registration(&expect(&rp, &origin, &ch.challenge), &cd, &att).map_err(bad_passkey)?;
    if b64(&reg.credential_id) != b.id.trim_end_matches('=') {
        return Err(bad_passkey("id_mismatch"));
    }
    Ok(reg)
}

pub async fn register_verify(mut req: Request, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    limit(db, cfg, "register", &http::client_ip(&req), 10, 60).await?;
    let b: RegisterFinish = http::json_body(&mut req).await?;
    let ch = take_challenge(db, &b.challenge_id, "register").await?;
    let reg = finish_registration(cfg, &ch, &b)?;
    let (Some(email), Some(handle)) = (ch.pending_email.clone(), ch.user_handle.clone()) else { return Err(ApiError::internal()) };
    let name = ch.pending_name.clone().unwrap_or_default();
    let uid = new_id("usr");
    let now = now_iso();
    // password_hash is kept for schema compatibility; passkey accounts store a marker, never a password.
    match db::run_unique(
        db,
        "INSERT INTO users (id, email, name, password_hash, email_verified, plan, webauthn_handle, created_at, updated_at) VALUES (?, ?, ?, 'passkey', 0, 'free', ?, ?, ?)",
        args![&uid, &email, &name, &handle, &now, &now],
    )
    .await
    {
        Ok(_) => {}
        Err(None) => return Err(ApiError::new(409, "email_taken", "An account with this email already exists. Sign in with your passkey instead.")),
        Err(Some(e)) => return Err(e),
    }
    store_passkey(db, &uid, &reg, b.name.as_deref().unwrap_or("First passkey")).await?;
    let codes = issue_recovery_codes(db, &uid).await?;
    audit(db, Some(&uid), "account.created", json!({ "method": "passkey" })).await?;
    let token = create_session(db, &uid, "browser", "").await?;
    let user = AuthUser { id: uid, email, name, email_verified: false, plan: "free".into() };
    browser_session_response(cfg, &token, json!({ "user": user, "recoveryCodes": codes }))
}

// ---------- sign in ----------

pub async fn login_options(req: Request, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    limit(db, cfg, "login", &http::client_ip(&req), 20, 60).await?;
    let (cid, challenge) = new_challenge(db, "login", None, None, None, None).await?;
    http::ok(&json!({ "challengeId": cid, "publicKey": { "challenge": challenge, "rpId": rp_id(cfg), "userVerification": "preferred", "timeout": 120000, "allowCredentials": [] } }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LoginFinish {
    challenge_id: String,
    id: String,
    client_data_json: String,
    authenticator_data: String,
    signature: String,
    #[serde(default)]
    user_handle: Option<String>,
}

pub async fn login_verify(mut req: Request, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    limit(db, cfg, "login", &http::client_ip(&req), 20, 60).await?;
    let b: LoginFinish = http::json_body(&mut req).await?;
    let ch = take_challenge(db, &b.challenge_id, "login").await?;
    let cred_id = b.id.trim_end_matches('=').to_string();
    if cred_id.is_empty() || cred_id.len() > 1400 {
        return Err(bad_passkey("bad_id"));
    }
    #[derive(Deserialize)]
    struct Pk {
        user_id: String,
        #[serde(with = "serde_bytes")]
        public_key: Vec<u8>,
        sign_count: i64,
        webauthn_handle: Option<String>,
    }
    let pk: Pk = db::first(
        db,
        "SELECT p.user_id, p.public_key, p.sign_count, u.webauthn_handle FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ?",
        args![&cred_id],
    )
    .await?
    .ok_or_else(|| ApiError::new(401, "unknown_passkey", "This passkey is not registered with Cognis. Sign up, or use a recovery code."))?;
    if let (Some(h), Some(expected)) = (b.user_handle.as_deref().filter(|h| !h.is_empty()), pk.webauthn_handle.as_deref()) {
        if h.trim_end_matches('=') != expected {
            return Err(bad_passkey("user_mismatch"));
        }
    }
    let rp = rp_id(cfg);
    let origin = cfg.origin();
    let (cd, ad, sig) = (unb64(&b.client_data_json).map_err(bad_passkey)?, unb64(&b.authenticator_data).map_err(bad_passkey)?, unb64(&b.signature).map_err(bad_passkey)?);
    let count = webauthn::verify_assertion(&expect(&rp, &origin, &ch.challenge), &pk.public_key, pk.sign_count as u32, &cd, &ad, &sig).map_err(|e| {
        bad_passkey(e)
    })?;
    db::run(db, "UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?", args![count as i64, now_iso(), &cred_id]).await?;
    let row: UserRow = db::first(db, &format!("SELECT {USER_COLS} FROM users WHERE id = ?"), args![&pk.user_id]).await?.ok_or_else(ApiError::unauthenticated)?;
    let token = create_session(db, &row.id, "browser", "").await?;
    browser_session_response(cfg, &token, json!({ "user": row.public() }))
}

// ---------- recovery ----------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoveryBody {
    email: String,
    code: String,
}

pub async fn recovery_sign_in(mut req: Request, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    limit(db, cfg, "recovery", &http::client_ip(&req), 5, 300).await?;
    let b: RecoveryBody = http::json_body(&mut req).await?;
    let email = b.email.trim().to_lowercase();
    limit(db, cfg, "recovery-email", &email, 5, 300).await?;
    #[derive(Deserialize)]
    struct U {
        user_id: String,
    }
    let used: Option<U> = db::first(
        db,
        "UPDATE recovery_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND user_id = (SELECT id FROM users WHERE email = ?) RETURNING user_id",
        args![now_iso(), code_hash(&b.code), &email],
    )
    .await?;
    let Some(u) = used else {
        audit(db, None, "recovery.failed", json!({})).await?;
        return Err(ApiError::new(401, "invalid_recovery_code", "That email and recovery code do not match, or the code was already used."));
    };
    let left: Option<db::Count> = db::first(db, "SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL", args![&u.user_id]).await?;
    audit(db, Some(&u.user_id), "recovery.used", json!({})).await?;
    let row: UserRow = db::first(db, &format!("SELECT {USER_COLS} FROM users WHERE id = ?"), args![&u.user_id]).await?.ok_or_else(ApiError::unauthenticated)?;
    let token = create_session(db, &row.id, "browser", "").await?;
    browser_session_response(cfg, &token, json!({ "user": row.public(), "recoveryCodesLeft": left.map(|c| c.n).unwrap_or(0) }))
}

pub async fn regenerate_recovery_codes(caller: &Caller, db: &D1Database) -> ApiResult<Response> {
    require_fresh(caller)?;
    let codes = issue_recovery_codes(db, &caller.user.id).await?;
    audit(db, Some(&caller.user.id), "recovery.regenerated", json!({})).await?;
    http::ok(&json!({ "recoveryCodes": codes }))
}

// ---------- manage passkeys ----------

pub async fn add_options(caller: &Caller, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    #[derive(Deserialize)]
    struct Id {
        id: String,
    }
    let existing: Vec<Id> = db::all(db, "SELECT id FROM passkeys WHERE user_id = ?", args![&caller.user.id]).await?;
    let handle_row: Option<UserRow> = db::first(db, &format!("SELECT {USER_COLS} FROM users WHERE id = ?"), args![&caller.user.id]).await?;
    let handle = match handle_row.and_then(|u| u.webauthn_handle) {
        Some(h) => h,
        None => {
            let h = b64(&random_bytes::<16>());
            db::run(db, "UPDATE users SET webauthn_handle = ? WHERE id = ? AND webauthn_handle IS NULL", args![&h, &caller.user.id]).await?;
            h
        }
    };
    let (cid, challenge) = new_challenge(db, "add", Some(&caller.user.id), None, None, Some(&handle)).await?;
    let ids: Vec<String> = existing.into_iter().map(|i| i.id).collect();
    http::ok(&json!({ "challengeId": cid, "publicKey": creation_options(cfg, &challenge, &handle, &caller.user.email, &caller.user.name, &ids) }))
}

pub async fn add_verify(mut req: Request, caller: &Caller, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    let b: RegisterFinish = http::json_body(&mut req).await?;
    let ch = take_challenge(db, &b.challenge_id, "add").await?;
    if ch.user_id.as_deref() != Some(caller.user.id.as_str()) {
        return Err(ApiError::new(400, "invalid_challenge", "This attempt expired. Try again."));
    }
    let reg = finish_registration(cfg, &ch, &b)?;
    let n: Option<db::Count> = db::first(db, "SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?", args![&caller.user.id]).await?;
    if n.map(|c| c.n).unwrap_or(0) >= 20 {
        return Err(ApiError::new(403, "too_many_passkeys", "You can register up to 20 passkeys."));
    }
    store_passkey(db, &caller.user.id, &reg, b.name.as_deref().unwrap_or("Passkey")).await?;
    audit(db, Some(&caller.user.id), "passkey.added", json!({})).await?;
    http::ok(&json!({ "ok": true }))
}

pub async fn list_passkeys(caller: &Caller, db: &D1Database) -> ApiResult<Response> {
    #[derive(Deserialize)]
    struct P {
        id: String,
        name: String,
        created_at: String,
        last_used_at: Option<String>,
    }
    let rows: Vec<P> = db::all(db, "SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at", args![&caller.user.id]).await?;
    let codes: Option<db::Count> = db::first(db, "SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL", args![&caller.user.id]).await?;
    http::ok(&json!({
        "passkeys": rows.iter().map(|p| json!({ "id": p.id, "name": p.name, "createdAt": p.created_at, "lastUsedAt": p.last_used_at })).collect::<Vec<_>>(),
        "recoveryCodesLeft": codes.map(|c| c.n).unwrap_or(0),
    }))
}

pub async fn delete_passkey(caller: &Caller, db: &D1Database, id: &str) -> ApiResult<Response> {
    let n: Option<db::Count> = db::first(db, "SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?", args![&caller.user.id]).await?;
    if n.map(|c| c.n).unwrap_or(0) <= 1 {
        return Err(ApiError::new(409, "last_passkey", "Add another passkey before removing your last one."));
    }
    let gone = db::run(db, "DELETE FROM passkeys WHERE id = ? AND user_id = ?", args![id, &caller.user.id]).await?;
    if gone == 0 {
        return Err(ApiError::not_found("Passkey"));
    }
    audit(db, Some(&caller.user.id), "passkey.removed", json!({})).await?;
    http::no_content()
}

// ---------- desktop pairing ----------

/// Web app: create a 10-minute code the desktop companion can exchange for a device token.
pub async fn create_pairing(caller: &Caller, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    if caller.via_bearer {
        return Err(ApiError::new(403, "browser_only", "Create pairing codes from the web app."));
    }
    limit(db, cfg, "pairing", &caller.user.id, 10, 600).await?;
    let r: [u8; 8] = random_bytes(); // 40 bits used: 8 chars of 5 bits
    let code = friendly_code(&r, 2);
    db::run(db, "DELETE FROM pairing_codes WHERE user_id = ? OR expires_at < ?", args![&caller.user.id, now_iso()]).await?;
    let expires = iso_in(PAIRING_TTL_MS);
    db::run(db, "INSERT INTO pairing_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)", args![code_hash(&code), &caller.user.id, &expires]).await?;
    http::ok(&json!({ "code": code, "expiresAt": expires }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairBody {
    code: String,
    #[serde(default)]
    device: String,
}

/// Desktop companion: exchange a pairing code for a device token. Single use.
pub async fn pair(mut req: Request, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    limit(db, cfg, "pair", &http::client_ip(&req), 10, 60).await?;
    let b: PairBody = http::json_body(&mut req).await?;
    if normalize_code(&b.code).len() != 8 {
        return Err(ApiError::new(400, "invalid_pairing_code", "Enter the 8-character code shown in the web app."));
    }
    #[derive(Deserialize)]
    struct U {
        user_id: String,
    }
    let u: U = db::first(db, "DELETE FROM pairing_codes WHERE code_hash = ? AND expires_at > ? RETURNING user_id", args![code_hash(&b.code), now_iso()])
        .await?
        .ok_or_else(|| ApiError::new(400, "invalid_pairing_code", "That code is wrong or expired. Create a new one in the web app, Account, Devices."))?;
    let label = normalize_text(&b.device, 60);
    let token = create_session(db, &u.user_id, "device", if label.is_empty() { "Desktop companion" } else { &label }).await?;
    let row: UserRow = db::first(db, &format!("SELECT {USER_COLS} FROM users WHERE id = ?"), args![&u.user_id]).await?.ok_or_else(ApiError::unauthenticated)?;
    http::ok(&json!({ "user": row.public(), "token": token }))
}

// ---------- sessions and account ----------

fn require_fresh(caller: &Caller) -> ApiResult<()> {
    if caller.via_bearer || caller.session_created_at.as_str() < iso_from_ms(now_ms() - FRESH_SESSION_MS).as_str() {
        return Err(ApiError::new(403, "reauth_required", "For your security, sign in again with your passkey, then retry."));
    }
    Ok(())
}

pub async fn sign_out(caller: &Caller, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    db::run(db, "DELETE FROM sessions WHERE token_hash = ?", args![&caller.token_hash]).await?;
    let res = http::ok(&json!({ "ok": true }))?;
    http::clear_cookie(&res, cfg)?;
    Ok(res)
}

pub async fn list_sessions(caller: &Caller, db: &D1Database) -> ApiResult<Response> {
    #[derive(Deserialize)]
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
    confirm: String,
}

/// Requires typing DELETE and a sign-in within the last 15 minutes. Cascades to everything.
pub async fn delete_account(mut req: Request, caller: &Caller, db: &D1Database, cfg: &Config) -> ApiResult<Response> {
    let b: DeleteAccount = http::json_body(&mut req).await?;
    if b.confirm != "DELETE" {
        return Err(ApiError::validation("confirm", "Type DELETE to confirm."));
    }
    require_fresh(caller)?;
    db::run(db, "DELETE FROM users WHERE id = ?", args![&caller.user.id]).await?;
    audit(db, Some(&caller.user.id), "account.deleted", json!({})).await?;
    let res = http::ok(&json!({ "ok": true }))?;
    http::clear_cookie(&res, cfg)?;
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_shape() {
        for ok in ["a@b.co", "first.last+tag@sub.example.com"] {
            assert!(valid_email(ok), "{ok}");
        }
        for bad in ["", "a", "a@b", "@b.com", "a@.com", "a@b.com.", "a b@c.com", "a@b@c.com"] {
            assert!(!valid_email(bad), "{bad}");
        }
    }

    #[test]
    fn friendly_codes() {
        let c = friendly_code(&[0xff, 0x00, 0xaa, 0x55, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc], 4);
        assert_eq!(c.len(), 19);
        assert_eq!(c.matches('-').count(), 3);
        assert!(c.chars().all(|ch| ch == '-' || "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains(ch)));
        assert_eq!(friendly_code(&[1, 2, 3, 4, 5, 6, 7, 8], 2).len(), 9);
        // Typing variations hash the same.
        assert_eq!(code_hash("ab2c-d3ef"), code_hash(" AB2C D3EF "));
        assert_eq!(normalize_code("kl-mn 23"), "KLMN23");
    }
}
