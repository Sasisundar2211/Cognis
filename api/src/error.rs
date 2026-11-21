//! Structured API errors. `code` is stable and machine-readable; `message` is safe to show users.

use serde_json::{json, Value};

#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
    pub details: Option<Value>,
}

impl ApiError {
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into(), details: None }
    }
    pub fn with_details(mut self, d: Value) -> Self {
        self.details = Some(d);
        self
    }
    pub fn not_found(what: &str) -> Self {
        Self::new(404, "not_found", format!("{what} not found."))
    }
    pub fn unauthenticated() -> Self {
        Self::new(401, "unauthenticated", "Sign in to continue.")
    }
    pub fn validation(field: &str, message: &str) -> Self {
        Self::new(422, "validation_failed", "Some fields are invalid.").with_details(json!({ "fields": [{ "path": field, "message": message }] }))
    }
    /// Internal failure. The original error is logged by kind only and never returned.
    pub fn internal() -> Self {
        Self::new(500, "internal_error", "Something went wrong.")
    }
    pub fn body(&self, request_id: &str) -> Value {
        let mut e = json!({ "code": self.code, "message": self.message, "requestId": request_id });
        if let Some(d) = &self.details {
            e["details"] = d.clone();
        }
        json!({ "error": e })
    }
}

impl From<worker::Error> for ApiError {
    fn from(e: worker::Error) -> Self {
        // Log the error category only: driver messages can echo user content.
        let kind = match &e {
            worker::Error::D1(_) => "d1",
            worker::Error::Json(_) | worker::Error::SerdeJsonError(_) | worker::Error::SerdeWasmBindgenError(_) => "serde",
            worker::Error::JsError(_) | worker::Error::Internal(_) => "js",
            _ => "other",
        };
        worker::console_error!("{{\"level\":\"error\",\"kind\":\"{kind}\"}}");
        Self::internal()
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(_: serde_json::Error) -> Self {
        Self::internal()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
