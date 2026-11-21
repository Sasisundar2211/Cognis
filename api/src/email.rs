//! Outgoing email. "disabled": nothing is sent. "resend": Resend HTTP API. "capture": test builds only.

use crate::error::{ApiError, ApiResult};
use crate::http::Config;

#[cfg(feature = "test-hooks")]
thread_local! {
    pub static CAPTURED: std::cell::RefCell<Vec<(String, String, String)>> = const { std::cell::RefCell::new(Vec::new()) };
}

pub async fn send_email(cfg: &Config, to: &str, subject: &str, text: &str) -> ApiResult<()> {
    match cfg.email_mode.as_str() {
        #[cfg(feature = "test-hooks")]
        "capture" if cfg.is_test() => {
            CAPTURED.with(|c| c.borrow_mut().push((to.to_string(), subject.to_string(), text.to_string())));
            Ok(())
        }
        "resend" => send_resend(cfg, to, subject, text).await,
        // Never log the message: it can contain a secret link.
        _ => Ok(()),
    }
}

#[cfg(target_arch = "wasm32")]
async fn send_resend(cfg: &Config, to: &str, subject: &str, text: &str) -> ApiResult<()> {
    use worker::{Fetch, Headers, Method, Request, RequestInit};
    let (Some(key), Some(from)) = (&cfg.resend_key, &cfg.email_from) else {
        return Err(ApiError::new(503, "email_unavailable", "Email is not configured."));
    };
    let headers = Headers::new();
    headers.set("Authorization", &format!("Bearer {key}"))?;
    headers.set("Content-Type", "application/json")?;
    let body = serde_json::json!({ "from": from, "to": [to], "subject": subject, "text": text }).to_string();
    let mut init = RequestInit::new();
    init.with_method(Method::Post).with_headers(headers).with_body(Some(body.into()));
    let res = Fetch::Request(Request::new_with_init("https://api.resend.com/emails", &init)?).send().await?;
    if !(200..300).contains(&res.status_code()) {
        return Err(ApiError::new(502, "email_failed", "Could not send the email. Try again later."));
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
async fn send_resend(_: &Config, _: &str, _: &str, _: &str) -> ApiResult<()> {
    Err(ApiError::new(503, "email_unavailable", "Email is not configured."))
}
