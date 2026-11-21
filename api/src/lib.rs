//! Cognis API: a Cloudflare Worker written in Rust (workers-rs).
//!
//! One Worker serves the JSON API under /api and the React web app as static assets.

pub mod ask;
pub mod audit;
pub mod auth;
pub mod db;
pub mod email;
pub mod error;
pub mod http;
pub mod ingest;
pub mod password;
pub mod plans;
pub mod retrieval;
pub mod util;
#[cfg(target_arch = "wasm32")]
pub mod knowledge;
#[cfg(target_arch = "wasm32")]
mod routes;

#[cfg(target_arch = "wasm32")]
mod entry {
    use super::*;
    use worker::{event, Context, Env, Request, Response, Result};

    #[event(fetch)]
    async fn fetch(req: Request, env: Env, ctx: Context) -> Result<Response> {
        console_error_panic_hook::set_once();
        let path = req.path();
        if !path.starts_with("/api/") {
            // The web app. Assets binding handles SPA fallback (not_found_handling).
            return env.assets("ASSETS")?.fetch_request(req).await;
        }
        let cfg = http::Config::from_env(&env);
        let request_id = req.headers().get("cf-ray").ok().flatten().unwrap_or_else(|| util::new_id("req"));
        let method = req.method().to_string();
        let started = util::now_ms();
        let mut res = match routes::handle(req, &env, &ctx, &cfg, &path).await {
            Ok(r) => r,
            Err(e) => Response::from_json(&e.body(&request_id))?.with_status(e.status),
        };
        let h = res.headers_mut();
        http::security_headers(h);
        let _ = h.set("X-Request-Id", &request_id);
        // Structured access log: method, coarse route, status, latency. No query strings, bodies or content.
        let route: String = path.split('/').take(4).collect::<Vec<_>>().join("/");
        worker::console_log!("{}", serde_json::json!({ "level": "info", "requestId": request_id, "method": method, "route": route, "status": res.status_code(), "ms": util::now_ms() - started }));
        Ok(res)
    }
}
