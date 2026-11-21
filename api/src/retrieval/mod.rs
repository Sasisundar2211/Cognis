pub mod embed;
pub mod filters;
pub mod rank;
#[cfg(target_arch = "wasm32")]
pub mod search;

use crate::http::Config;
use embed::Embedder;

pub fn embedder(env: &worker::Env, cfg: &Config) -> Option<Embedder> {
    match cfg.embedder.as_str() {
        #[cfg(target_arch = "wasm32")]
        "workers-ai" => env.ai("AI").ok().map(Embedder::WorkersAi),
        "test-hash" if cfg.is_test() => Some(Embedder::TestHash),
        _ => {
            let _ = env;
            None
        }
    }
}
