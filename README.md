# Cognis

Cognis remembers what you learn and brings it back when it becomes useful.

Save links and notes from anywhere. Press a hotkey on your desktop and ask. Cognis answers from what you saved, cites the sources, and links back to the originals.

## Status

Live at https://cognis.sasisundhar2211.workers.dev on Cloudflare's free plan. Sign in with a passkey (no password). Works end to end: saving, link import, library, collections, hybrid search, Grok-style ask with cited answers, desktop companion with Observe, export, account deletion. See [docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md).

## Parts

| Folder | What | Stack |
|---|---|---|
| `api/` | API and web host | Rust on Cloudflare Workers (workers-rs), D1 (SQLite + FTS5), Workers AI |
| `desktop/` | Desktop companion: hotkey, floating window, ask, save | Rust + Tauri 2, TypeScript UI |
| `web/` | Web app: library, search, collections, account | React 19, Tailwind 4, Vite |
| `worker/` | Superseded TypeScript API, kept for reference | Hono, Better Auth |

Search: BM25 full-text plus `bge-small-en-v1.5` embeddings, fused with Reciprocal Rank Fusion (k=60). Answers: `mistral-small-3.1-24b-instruct` (Apache 2.0) on Workers AI, citing sources. Cognis's code, models and libraries are open source. Cloudflare's hosting is a free tier of a proprietary service; the Workers runtime (workerd) is open source and can self-host the API.

## Quick start

```sh
npm install
npm run build -w web
cargo install worker-build@0.9.0
rustup target add wasm32-unknown-unknown
cd api
npx wrangler d1 migrations apply cognis-dev --local -c wrangler.dev.jsonc  # 0001 to 0003
npx wrangler dev -c wrangler.dev.jsonc          # http://localhost:8787
```

Desktop companion: see [docs/DESKTOP.md](docs/DESKTOP.md).

## Docs

- [Implementation status](docs/IMPLEMENTATION-STATUS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Desktop companion](docs/DESKTOP.md)
- [Security](docs/SECURITY.md)
- [Local development](docs/LOCAL-DEVELOPMENT.md)
- [Production deployment](docs/PRODUCTION-DEPLOYMENT.md)
- [Operations runbook](docs/OPERATIONS-RUNBOOK.md)
- [Testing](docs/TESTING.md)
- [Known limitations](docs/KNOWN-LIMITATIONS.md)
- [Pricing and costs](docs/PRICING.md)
