//! HTTP client for the Cognis API. All network traffic from the companion goes through here,
//! in Rust, so the device token never enters the web view.

use futures_util::StreamExt;
use serde_json::{json, Value};
use url::Url;

pub struct Api {
    http: reqwest::Client,
    pub server: Url,
}

#[derive(Debug, serde::Serialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

impl ApiError {
    fn new(code: &str, message: &str) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

pub type R<T> = Result<T, ApiError>;

/// Only HTTPS servers are accepted, except localhost for development, so passwords never travel in plain text.
pub fn parse_server(raw: &str) -> R<Url> {
    let u = Url::parse(raw.trim()).map_err(|_| ApiError::new("invalid_server", "Enter the full address of your Cognis server, starting with https://."))?;
    let local = matches!(u.host_str(), Some("localhost") | Some("127.0.0.1"));
    if u.scheme() != "https" && !(u.scheme() == "http" && local) {
        return Err(ApiError::new("insecure_server", "The server address must start with https://."));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(ApiError::new("invalid_server", "Remove the username or password from the address."));
    }
    let mut base = u.clone();
    base.set_path("/");
    base.set_query(None);
    base.set_fragment(None);
    Ok(base)
}

async fn error_from(res: reqwest::Response) -> ApiError {
    let status = res.status().as_u16();
    let v: Value = res.json().await.unwrap_or(json!({}));
    let code = v["error"]["code"].as_str().unwrap_or("error").to_string();
    let message = v["error"]["message"].as_str().map(str::to_string).unwrap_or_else(|| format!("The server answered with status {status}."));
    ApiError { code, message }
}

fn net_err(_: reqwest::Error) -> ApiError {
    ApiError::new("network", "Cognis could not reach the server. Check your connection.")
}

impl Api {
    pub fn new(server: Url) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("CognisDesktop/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("http client");
        Self { http, server }
    }

    fn url(&self, path: &str) -> Url {
        self.server.join(path.trim_start_matches('/')).expect("static path")
    }

    /// Exchange email + password for a long-lived device token. The password is not stored.
    pub async fn sign_in(&self, email: &str, password: &str, device: &str) -> R<(Value, String)> {
        let res = self.http.post(self.url("/api/auth/sign-in")).json(&json!({ "email": email, "password": password, "device": device })).send().await.map_err(net_err)?;
        if !res.status().is_success() {
            return Err(error_from(res).await);
        }
        let v: Value = res.json().await.map_err(net_err)?;
        let token = v["token"].as_str().ok_or_else(|| ApiError::new("bad_response", "The server did not return a device token."))?.to_string();
        Ok((v["user"].clone(), token))
    }

    pub async fn get(&self, token: &str, path: &str) -> R<Value> {
        let res = self.http.get(self.url(path)).bearer_auth(token).send().await.map_err(net_err)?;
        if !res.status().is_success() {
            return Err(error_from(res).await);
        }
        res.json().await.map_err(net_err)
    }

    pub async fn post(&self, token: &str, path: &str, body: &Value) -> R<Value> {
        let res = self.http.post(self.url(path)).bearer_auth(token).json(body).send().await.map_err(net_err)?;
        if !res.status().is_success() {
            return Err(error_from(res).await);
        }
        res.json().await.map_err(net_err)
    }

    /// Revokes this device's session on the server. Best effort: local sign-out happens regardless.
    pub async fn sign_out(&self, token: &str) {
        let _ = self.http.post(self.url("/api/auth/sign-out")).bearer_auth(token).send().await;
    }

    /// Stream an answer. `on_event` receives each server-sent event (name, JSON data) as it arrives.
    pub async fn ask(&self, token: &str, body: &Value, mut on_event: impl FnMut(&str, Value)) -> R<()> {
        let res = self
            .http
            .post(self.url("/api/v1/ask"))
            .bearer_auth(token)
            .header("Accept", "text/event-stream")
            .json(body)
            .send()
            .await
            .map_err(net_err)?;
        if !res.status().is_success() {
            return Err(error_from(res).await);
        }
        let mut parser = SseParser::default();
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(net_err)?;
            for (ev, data) in parser.push(&chunk) {
                on_event(&ev, data);
            }
        }
        Ok(())
    }
}

/// Incremental server-sent-events parser ("event: x\ndata: {...}\n\n").
#[derive(Default)]
pub struct SseParser {
    buf: String,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<(String, Value)> {
        self.buf.push_str(&String::from_utf8_lossy(chunk));
        let mut out = vec![];
        while let Some(i) = self.buf.find("\n\n") {
            let block: String = self.buf.drain(..i + 2).collect();
            let mut ev = "message".to_string();
            let mut data = String::new();
            for line in block.lines() {
                if let Some(v) = line.strip_prefix("event:") {
                    ev = v.trim().to_string();
                } else if let Some(v) = line.strip_prefix("data:") {
                    data.push_str(v.trim());
                }
            }
            if let Ok(v) = serde_json::from_str(&data) {
                out.push((ev, v));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_must_be_https_except_localhost() {
        assert!(parse_server("https://cognis.example.workers.dev").is_ok());
        assert_eq!(parse_server("https://x.example.com/some/path?q=1").unwrap().as_str(), "https://x.example.com/");
        assert!(parse_server("http://localhost:8787").is_ok());
        assert!(parse_server("http://127.0.0.1:8787").is_ok());
        assert_eq!(parse_server("http://cognis.example.com").unwrap_err().code, "insecure_server");
        assert_eq!(parse_server("file:///etc/passwd").unwrap_err().code, "insecure_server");
        assert_eq!(parse_server("https://u:p@x.com").unwrap_err().code, "invalid_server");
        assert_eq!(parse_server("nonsense").unwrap_err().code, "invalid_server");
    }

    #[test]
    fn sse_parser_handles_split_events() {
        let mut p = SseParser::default();
        assert!(p.push(b"event: status\ndata: {\"step\":").is_empty());
        let got = p.push(b"\"searching\"}\n\nevent: delta\ndata: {\"text\":\"Hi\"}\n\n");
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].0, "status");
        assert_eq!(got[1].1["text"], "Hi");
    }
}
