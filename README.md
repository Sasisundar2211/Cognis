# Cognis

Cognis remembers what you learn and brings it back when it becomes useful.

Save links and notes from anywhere. Cognis reads the page, keeps the original source, and finds it again by words or by meaning. Each search result says why it matched.

## Status

Core product works locally: accounts, saving, import, library, collections, hybrid search, export, account deletion. Not yet deployed. Browser extension and context suggestions are not built yet. See [docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md).

## Stack

All open source, running on Cloudflare's free tier.

| Layer | Choice |
|---|---|
| API | Cloudflare Workers, Hono, TypeScript, Zod |
| Auth | Better Auth (email + password, sessions, verification, reset) |
| Database | Cloudflare D1 (SQLite) with FTS5 full-text search |
| Embeddings | Workers AI `bge-small-en-v1.5` (384 dims) |
| Search | BM25 + cosine similarity, fused with Reciprocal Rank Fusion (k=60) |
| Web | React 19, React Router, Tailwind CSS 4, Vite, served as Worker static assets |
| Tests | Vitest in the Workers runtime, Playwright for the browser journey |

## Quick start

```sh
npm install
npm run build -w web
cd worker
npx wrangler d1 migrations apply cognis-dev --local -c wrangler.dev.jsonc
echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)" > .dev.vars
npx wrangler dev -c wrangler.dev.jsonc
```

Open http://localhost:8787.

## Docs

- [Implementation status](docs/IMPLEMENTATION-STATUS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [Local development](docs/LOCAL-DEVELOPMENT.md)
- [Production deployment](docs/PRODUCTION-DEPLOYMENT.md)
- [Operations runbook](docs/OPERATIONS-RUNBOOK.md)
- [Testing](docs/TESTING.md)
- [Known limitations](docs/KNOWN-LIMITATIONS.md)
- [Pricing and costs](docs/PRICING.md)
