# Architecture

## Topology

```
 Desktop companion (Tauri, Rust)          Browser (React SPA)
   hotkey -> floating window                 library, search, account
   Bearer device token (OS keychain)         HttpOnly session cookie
            \                                 /
             \--------- HTTPS ---------------/
                            |
            Cloudflare Worker "cognis" (Rust, wasm32)
              /api/auth/*   accounts, sessions, device tokens
              /api/v1/*     items, search, ask, collections, export
              /*            static web app (assets binding)
            Bindings: D1 (DB), Workers AI (AI), Rate Limiting
```

One Worker, one origin, one deploy. No microservices.

## The Grok-style workflow

1. The companion runs in the tray. The global hotkey (Ctrl/Cmd + Shift + Space) shows an always-on-top window.
2. The user asks a question. Optionally they share clipboard text after seeing a preview.
3. The Rust core in the companion posts to `POST /api/v1/ask` with the device token.
4. The API runs hybrid search over the user's own items (top 6, ready, not archived).
5. It streams server-sent events: `status` (searching), `sources` (numbered items), `status` (writing), `delta` (answer text), `done`.
6. The answer comes from an open-weights model on Workers AI, instructed to cite `[n]` and to treat sources as untrusted data.
7. The companion renders citations as buttons that open the original links, keeps 6 turns for follow-ups, and hides on Esc.

Without the language model (local dev, outage, quota), `/ask` returns the matching sources and says no written answer is available.

## API code layout (`api/src`)

| Module | Responsibility |
|---|---|
| `lib.rs` | Worker entry: static assets vs API, security headers, access log |
| `routes.rs` | Dispatch, validation, items, search, ask, collections, account, export |
| `auth.rs` | Sign-up, sign-in, verification, reset, change password, sessions, device tokens, deletion, rate limits |
| `password.rs` | scrypt hashing, constant-time verify |
| `knowledge.rs` | KnowledgeObject service: create, dedupe, process (fetch, extract, embed), update, delete, tags |
| `ingest/` | URL safety (SSRF), safe fetch with redirect re-validation, HTML extraction (lol_html) |
| `retrieval/` | Embedder, filters, ranking (terms, RRF, explanations), D1 search |
| `ask.rs` | Prompt building, delimiter hardening, SSE framing, model stream parsing, citation checks |
| `db.rs`, `http.rs`, `error.rs`, `util.rs`, `email.rs`, `audit.rs`, `plans.rs` | Helpers |

Pure logic (`util`, `password`, `ingest`, `retrieval/rank`, `retrieval/embed`, `ask`) compiles natively and has unit tests. Worker-bound code is covered by the HTTP suite.

## Data model (`api/migrations/0001_init.sql`)

- `users`: email (lowercase, unique), name, scrypt hash, verified flag, plan.
- `sessions`: SHA-256 of the token only. `kind` is `browser` (30 days) or `device` (365 days, labeled).
- `email_tokens`: SHA-256 of verification and reset tokens, single use, expiring.
- `auth_rate_limits`: fixed-window counters keyed by a hash of route and IP or email.
- `knowledge_items`, `tags`, `item_tags`, `collections`, `collection_items`, `knowledge_fts`, `audit_events`: as before. Join tables carry `user_id` with composite foreign keys so rows can never link objects of different users. Deleting a user cascades to everything.

## Retrieval

- Lexical: FTS5, Porter stemming, BM25 weights title 4, description 2, content 1, page text 1. Every query term is quoted.
- Semantic: brute-force cosine over the user's newest 2,000 embeddings stored in D1 (Vectorize's free tier holds about 13,000 vectors in total, too few for many users).
- Hybrid: RRF with k = 60. Explanations come only from evidence: which retriever matched and which terms FTS highlighted.

## Desktop code layout (`desktop/`)

| File | Responsibility |
|---|---|
| `src-tauri/src/lib.rs` | Tray, global hotkey, window toggle, commands, keychain, config |
| `src-tauri/src/api.rs` | HTTPS client, server URL validation, SSE parser |
| `src/main.ts` | UI: sign-in, conversation, streaming render, citations, clipboard preview |
| `src-tauri/capabilities/default.json` | The web view may only call Cognis commands and hide the window |

## Why the TypeScript worker is still here

`worker/` was the first implementation (Hono + Better Auth). The Rust API replaces it and keeps the same HTTP contract for items, search and collections. Auth endpoints changed. It stays in the repo as a reference and is not deployed.
