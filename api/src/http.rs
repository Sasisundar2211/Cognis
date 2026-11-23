//! Request context, JSON IO with limits, cookies, CSRF checks, security headers.

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use worker::{Env, Headers, Request, Response};

use crate::error::{ApiError, ApiResult};

pub const MAX_JSON_BYTES: usize = 256_000;

#[derive(Clone)]
pub struct Config {
    pub app_env: String,
    pub email_mode: String,
    pub embedder: String,
    pub app_url: String,
    pub resend_key: Option<String>,
    pub email_from: Option<String>,
    pub llm_model: String,
    /// Meta app token for Instagram's official oEmbed. Optional; without it Instagram links use the public page.
    pub instagram_token: Option<String>,
}

impl Config {
    pub fn from_env(env: &Env) -> Self {
        let var = |k: &str| env.var(k).ok().map(|v| v.to_string()).or_else(|| env.secret(k).ok().map(|s| s.to_string()));
        Self {
            app_env: var("APP_ENV").unwrap_or_else(|| "production".into()),
            email_mode: var("EMAIL_MODE").unwrap_or_else(|| "disabled".into()),
            embedder: var("EMBEDDER").unwrap_or_else(|| "none".into()),
            app_url: var("APP_URL").unwrap_or_else(|| "http://localhost:8787".into()).trim_end_matches('/').to_string(),
            resend_key: var("RESEND_API_KEY"),
            email_from: var("EMAIL_FROM"),
            llm_model: var("LLM_MODEL").unwrap_or_else(|| "@cf/mistralai/mistral-small-3.1-24b-instruct".into()),
            instagram_token: var("INSTAGRAM_OEMBED_TOKEN").filter(|t| !t.is_empty()),
        }
    }
    pub fn is_test(&self) -> bool {
        self.app_env == "test"
    }
    pub fn email_enabled(&self) -> bool {
        self.email_mode != "disabled"
    }
    pub fn https(&self) -> bool {
        self.app_url.starts_with("https://")
    }
    pub fn origin(&self) -> String {
        url::Url::parse(&self.app_url).map(|u| u.origin().ascii_serialization()).unwrap_or_default()
    }
    pub fn cookie_name(&self) -> &'static str {
        // __Host- prefix pins the cookie to this exact host, HTTPS, Path=/.
        if self.https() { "__Host-cognis_session" } else { "cognis_session" }
    }
}

pub fn header(req: &Request, name: &str) -> Option<String> {
    req.headers().get(name).ok().flatten()
}

pub fn client_ip(req: &Request) -> String {
    header(req, "cf-connecting-ip").unwrap_or_else(|| "local".into())
}

pub fn cookie(req: &Request, name: &str) -> Option<String> {
    let raw = header(req, "cookie")?;
    raw.split(';').find_map(|p| {
        let (k, v) = p.trim().split_once('=')?;
        (k == name).then(|| v.to_string())
    })
}

pub fn bearer(req: &Request) -> Option<String> {
    let h = header(req, "authorization")?;
    let t = h.strip_prefix("Bearer ")?.trim();
    (!t.is_empty() && t.len() <= 128).then(|| t.to_string())
}

/// Parse a JSON body: size-capped, content-type checked, strict schema via serde.
pub async fn json_body<T: DeserializeOwned>(req: &mut Request) -> ApiResult<T> {
    if let Some(len) = header(req, "content-length").and_then(|v| v.parse::<usize>().ok()) {
        if len > MAX_JSON_BYTES {
            return Err(ApiError::new(413, "payload_too_large", "That is too large to save."));
        }
    }
    let bytes = req.bytes().await.map_err(|_| ApiError::new(400, "invalid_json", "Request body is not valid JSON."))?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err(ApiError::new(413, "payload_too_large", "That is too large to save."));
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| ApiError::new(400, "invalid_json", "Request body is not valid JSON."))?;
    serde_json::from_value(value).map_err(|e| {
        let msg = e.to_string();
        // serde messages describe the schema, not the user's data; truncate to be safe.
        ApiError::new(422, "validation_failed", "Some fields are invalid.").with_details(json!({ "fields": [{ "path": "", "message": msg.chars().take(160).collect::<String>() }] }))
    })
}

/// CSRF defense for cookie-authenticated, state-changing requests.
pub fn csrf_check(req: &Request, cfg: &Config) -> ApiResult<()> {
    let m = req.method().to_string();
    if m == "GET" || m == "HEAD" || m == "OPTIONS" {
        return Ok(());
    }
    if let Some(origin) = header(req, "origin") {
        if origin != cfg.origin() {
            return Err(ApiError::new(403, "bad_origin", "Request origin not allowed."));
        }
    }
    if header(req, "sec-fetch-site").as_deref() == Some("cross-site") {
        return Err(ApiError::new(403, "bad_origin", "Request origin not allowed."));
    }
    let len = header(req, "content-length").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
    let has_body = len > 0 || header(req, "transfer-encoding").is_some();
    let ct = header(req, "content-type").unwrap_or_default().to_ascii_lowercase();
    if has_body && !ct.starts_with("application/json") {
        return Err(ApiError::new(415, "unsupported_media_type", "Send JSON."));
    }
    Ok(())
}

pub fn security_headers(h: &Headers) {
    let _ = h.set("X-Content-Type-Options", "nosniff");
    let _ = h.set("Referrer-Policy", "no-referrer");
    let _ = h.set("Cache-Control", "no-store");
    let _ = h.set("X-Frame-Options", "DENY");
    let _ = h.set("Cross-Origin-Resource-Policy", "same-origin");
}

pub fn json_response<T: Serialize>(value: &T, status: u16) -> ApiResult<Response> {
    let r = Response::from_json(value)?.with_status(status);
    Ok(r)
}

pub fn ok<T: Serialize>(value: &T) -> ApiResult<Response> {
    json_response(value, 200)
}

pub fn no_content() -> ApiResult<Response> {
    Ok(Response::empty()?.with_status(204))
}

pub fn redirect(location: &str) -> ApiResult<Response> {
    let r = Response::empty()?.with_status(302);
    r.headers().set("Location", location)?;
    Ok(r)
}

pub fn set_cookie(res: &Response, cfg: &Config, token: &str, max_age: i64) -> ApiResult<()> {
    let secure = if cfg.https() { "; Secure" } else { "" };
    res.headers().append("Set-Cookie", &format!("{}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{}", cfg.cookie_name(), token, max_age, secure))?;
    Ok(())
}

pub fn clear_cookie(res: &Response, cfg: &Config) -> ApiResult<()> {
    set_cookie(res, cfg, "", 0)
}

/// Query string as key/value pairs (last value wins).
pub fn query(req: &Request) -> std::collections::HashMap<String, String> {
    req.url().map(|u| u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect()).unwrap_or_default()
}
