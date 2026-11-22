//! Safe fetching of public pages. Every redirect hop is re-validated; bodies are capped.

use url::Url;

use super::url_safety::assert_fetchable;

pub const MAX_BYTES: usize = 1_000_000;
pub const TIMEOUT_MS: u64 = 8_000;
pub const MAX_REDIRECTS: usize = 3;
const PAGE_TYPES: &[&str] = &["text/html", "application/xhtml+xml", "text/plain"];
const JSON_TYPES: &[&str] = &["application/json", "text/json"];

/// One HTTP response as seen by the ingest pipeline. `body` is already capped at the requested size.
pub struct RawResponse {
    pub status: u16,
    pub location: Option<String>,
    pub content_type: String,
    pub content_length: Option<u64>,
    pub body: Vec<u8>,
}

/// Abstracts the network so redirect and size logic is unit-testable without one.
#[allow(async_fn_in_trait)]
pub trait PageFetcher {
    /// GET without following redirects. Errors are stable codes like "fetch_timeout".
    async fn get(&self, url: &Url, max_bytes: usize) -> Result<RawResponse, String>;
}

pub struct FetchedPage {
    pub final_url: Url,
    pub content_type: String,
    pub body: String,
}

/// Fetch a web page (HTML or plain text).
pub async fn safe_fetch<F: PageFetcher>(fetcher: &F, start: Url) -> Result<FetchedPage, String> {
    fetch_typed(fetcher, start, PAGE_TYPES).await
}

/// Fetch a JSON document from an official platform endpoint (oEmbed, Reddit JSON, GitHub API).
pub async fn safe_fetch_json<F: PageFetcher>(fetcher: &F, start: Url) -> Result<FetchedPage, String> {
    fetch_typed(fetcher, start, JSON_TYPES).await
}

async fn fetch_typed<F: PageFetcher>(fetcher: &F, start: Url, allowed: &[&str]) -> Result<FetchedPage, String> {
    let mut url = start;
    for _ in 0..=MAX_REDIRECTS {
        let res = fetcher.get(&url, MAX_BYTES).await?;
        if (300..400).contains(&res.status) {
            let loc = res.location.ok_or("redirect_without_location")?;
            let next = url.join(&loc).map_err(|_| "redirect_invalid".to_string())?;
            url = assert_fetchable(next.as_str()).map_err(|r| format!("redirect_{r}"))?;
            continue;
        }
        if !(200..300).contains(&res.status) {
            return Err(format!("http_{}", res.status));
        }
        let ct = res.content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        if !allowed.contains(&ct.as_str()) {
            return Err("unsupported_content_type".into());
        }
        if res.content_length.unwrap_or(0) > (MAX_BYTES as u64) * 4 {
            return Err("too_large".into());
        }
        let mut body = res.body;
        body.truncate(MAX_BYTES);
        return Ok(FetchedPage { final_url: url, content_type: ct, body: String::from_utf8_lossy(&body).into_owned() });
    }
    Err("too_many_redirects".into())
}

#[cfg(target_arch = "wasm32")]
pub use wasm::WorkerFetcher;

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    use futures_util::{future::Either, pin_mut, StreamExt};
    use worker::{AbortController, Delay, Fetch, Headers, Method, Request, RequestInit, RequestRedirect};

    pub struct WorkerFetcher;

    impl PageFetcher for WorkerFetcher {
        async fn get(&self, url: &Url, max_bytes: usize) -> Result<RawResponse, String> {
            let headers = Headers::new();
            let _ = headers.set("User-Agent", "CognisBot/0.2 (+personal knowledge import; fetches only links a user saved)");
            let _ = headers.set("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8");
            let mut init = RequestInit::new();
            init.with_method(Method::Get).with_headers(headers).with_redirect(RequestRedirect::Manual);
            let req = Request::new_with_init(url.as_str(), &init).map_err(|_| "fetch_failed".to_string())?;
            let ctrl = AbortController::default();
            let signal = ctrl.signal();

            let work = async {
                let mut res = Fetch::Request(req).send_with_signal(&signal).await.map_err(|_| "fetch_failed".to_string())?;
                let status = res.status_code();
                let h = res.headers();
                let location = h.get("location").ok().flatten();
                let content_type = h.get("content-type").ok().flatten().unwrap_or_default();
                let content_length = h.get("content-length").ok().flatten().and_then(|v| v.parse().ok());
                let mut body = Vec::new();
                let ok_type = (200..300).contains(&status);
                if ok_type {
                    if let Ok(mut stream) = res.stream() {
                        while let Some(chunk) = stream.next().await {
                            let chunk = chunk.map_err(|_| "fetch_failed".to_string())?;
                            let room = max_bytes.saturating_sub(body.len());
                            body.extend_from_slice(&chunk[..chunk.len().min(room)]);
                            if body.len() >= max_bytes {
                                break;
                            }
                        }
                    }
                }
                Ok::<_, String>(RawResponse { status, location, content_type, content_length, body })
            };
            let timeout = Delay::from(std::time::Duration::from_millis(TIMEOUT_MS));
            pin_mut!(work);
            pin_mut!(timeout);
            match futures_util::future::select(work, timeout).await {
                Either::Left((r, _)) => r,
                Either::Right(_) => {
                    ctrl.abort();
                    Err("fetch_timeout".into())
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Mock<F: Fn(&Url) -> RawResponse>(F, Cell<usize>);
    impl<F: Fn(&Url) -> RawResponse> PageFetcher for Mock<F> {
        async fn get(&self, url: &Url, max: usize) -> Result<RawResponse, String> {
            self.1.set(self.1.get() + 1);
            let mut r = (self.0)(url);
            r.body.truncate(max);
            Ok(r)
        }
    }
    fn page(body: &str, ct: &str) -> RawResponse {
        RawResponse { status: 200, location: None, content_type: ct.into(), content_length: None, body: body.as_bytes().to_vec() }
    }
    fn redirect(to: &str) -> RawResponse {
        RawResponse { status: 302, location: Some(to.into()), content_type: String::new(), content_length: None, body: vec![] }
    }
    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        futures::executor::block_on(f)
    }
    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn refuses_redirect_to_private_host() {
        let m = Mock(|url: &Url| if url.host_str() == Some("public.example.com") { redirect("http://169.254.169.254/latest/") } else { page("secret", "text/html") }, Cell::new(0));
        assert_eq!(run(safe_fetch(&m, u("https://public.example.com/"))).err().unwrap(), "redirect_private_address");
    }

    #[test]
    fn caps_redirect_chain() {
        let m = Mock(|url: &Url| redirect(&format!("https://example.com/{}", url.path().len())), Cell::new(0));
        assert_eq!(run(safe_fetch(&m, u("https://example.com/"))).err().unwrap(), "too_many_redirects");
        assert_eq!(m.1.get(), MAX_REDIRECTS + 1);
    }

    #[test]
    fn rejects_binary_and_errors_and_caps_size() {
        let bin = Mock(|_: &Url| page("x", "application/octet-stream"), Cell::new(0));
        assert_eq!(run(safe_fetch(&bin, u("https://example.com/"))).err().unwrap(), "unsupported_content_type");
        let e503 = Mock(|_: &Url| RawResponse { status: 503, ..page("", "text/html") }, Cell::new(0));
        assert_eq!(run(safe_fetch(&e503, u("https://example.com/"))).err().unwrap(), "http_503");
        let big = Mock(|_: &Url| page(&"a".repeat(MAX_BYTES + 5000), "text/html; charset=utf-8"), Cell::new(0));
        assert_eq!(run(safe_fetch(&big, u("https://example.com/"))).unwrap().body.len(), MAX_BYTES);
    }

    #[test]
    fn follows_safe_relative_redirect() {
        let m = Mock(|url: &Url| if url.path() == "/old" { redirect("/new") } else { page("<p>hi</p>", "text/html") }, Cell::new(0));
        let p = run(safe_fetch(&m, u("https://example.com/old"))).unwrap();
        assert_eq!(p.final_url.as_str(), "https://example.com/new");
    }
}
