//! Cognis API: a Cloudflare Worker written in Rust (workers-rs).
//!
//! One Worker serves the JSON API under /api and the React web app as static assets.

pub mod ask;
pub mod audit;
pub mod context;
pub mod auth;
pub mod db;
#[allow(dead_code)] // kept for optional email notices once a sender domain exists
pub mod email;
pub mod error;
pub mod http;
pub mod ingest;
#[allow(dead_code)] // superseded by passkeys; kept for reference and tests
pub mod password;
pub mod plans;
pub mod retrieval;
pub mod util;
pub mod webauthn;
#[cfg(target_arch = "wasm32")]
pub mod knowledge;
#[cfg(target_arch = "wasm32")]
pub mod routes;

#[cfg(target_arch = "wasm32")]
mod entry {
    use super::*;
    use worker::{event, Context, Env, Request, Response, Result, ScheduleContext, ScheduledEvent};

    /// Cron: works through pending and transiently failed link imports (see wrangler.jsonc triggers).
    #[event(scheduled)]
    async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
        match routes::process_pending(&env).await {
            Ok(n) => worker::console_log!("{}", serde_json::json!({ "level": "info", "metric": "queue", "processed": n })),
            Err(_) => worker::console_error!("{{\"level\":\"error\",\"metric\":\"queue\"}}"),
        }
    }

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
