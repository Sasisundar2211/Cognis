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
2. The user asks a question. If Observe is on, the app name and window title in front go along as context.
3. The Rust core in the companion posts to `POST /api/v1/ask` with the device token.
4. The API runs hybrid search over the user's own items (top 6, ready, not archived).
5. It streams server-sent events: `status` (searching), `sources` (numbered items), `status` (writing), `delta` (answer text), `done`.
6. The answer comes from an open-weights model on Workers AI, instructed to cite `[n]` and to treat sources as untrusted data.
7. The companion renders citations as buttons that open the original links, keeps 6 turns for follow-ups, and hides on Esc.

Without the language model (local dev, outage, quota), `/ask` returns the matching sources and says no written answer is available.

## Observe: working beside you

1. Observe is on (opt-in). Every 2 s the companion reads the app name and title of the window in front (`active-win-pos-rs`, with an X11 `WM_NAME` fallback).
2. On the device: skip Cognis's own windows (keeping the last work context), skip private windows, wait until the window stays in front for about 4 s, never resend the same window, at most one request per 6 s.
3. `POST /api/v1/context/suggest {appName, windowTitle}` (device token).
4. Server: `context::extract_task` turns the title into a TaskContext (focus phrase, keywords, confidence), skipping private windows again.
5. Hybrid search over the user's ready items with the task keywords; items shown in the last 30 min or dismissed in the last 7 days are removed; only items with word evidence or a strong meaning match are kept.
6. `context::gate` picks SILENT, PASSIVE, SUGGEST or HIGH_CONFIDENCE. Cooldown (90 s) and a daily cap (40) demote to PASSIVE.
7. SUGGEST or higher is logged (item ids only) and returned; the companion shows the beside panel without taking focus.
8. Feedback (`useful`, `not_useful`, `opened`, `dismissed`) feeds the Useful Intervention Rate at `GET /api/v1/suggestions/stats`.

When Observe is on, `/ask` also receives the current window, and its task keywords join the retrieval query.

## Saved posts and reels from a link

`ingest/platforms.rs` routes each link to the platform's official public source: Reddit post JSON (post and top comments), oEmbed for X, YouTube (plus the watch page description) and TikTok, Instagram's Graph oEmbed when `INSTAGRAM_OEMBED_TOKEN` is set, the GitHub README API, and the page itself for everything else. Pages that only show a sign-in prompt fail with `login_wall`. `POST /api/v1/items/batch` takes up to 50 links; the first 5 process right away and a cron trigger (every 5 minutes) processes the rest, reclaims abandoned items and retries transient failures.

## API code layout (`api/src`)

| Module | Responsibility |
|---|---|
| `lib.rs` | Worker entry: static assets vs API, security headers, access log |
| `routes.rs` | Dispatch, validation, items, search, ask, collections, account, export |
| `auth.rs` | Passkey sign-up and sign-in, recovery codes, pairing codes, sessions, device tokens, deletion, rate limits |
| `webauthn.rs` | WebAuthn relying party: client data, authenticator data, COSE keys, ES256 and RS256 verification |
| `password.rs`, `email.rs` | Unused since passkeys; kept for reference |
| `knowledge.rs` | KnowledgeObject service: create, dedupe, process (fetch, extract, embed), update, delete, tags |
| `ingest/` | URL safety (SSRF), safe fetch with redirect re-validation, HTML extraction (lol_html) |
| `retrieval/` | Embedder, filters, ranking (terms, RRF, explanations), D1 search |
| `ask.rs` | Prompt building, delimiter hardening, SSE framing, model stream parsing, citation checks |
| `context.rs` | TaskContext from window titles, private-window rules, relevance gate |
| `ingest/platforms.rs` | Official routes and parsers for Reddit, X, YouTube, TikTok, Instagram, GitHub; login-wall detection |
| `db.rs`, `http.rs`, `error.rs`, `util.rs`, `email.rs`, `audit.rs`, `plans.rs` | Helpers |

Pure logic (`util`, `webauthn`, `ingest`, `retrieval/rank`, `retrieval/embed`, `ask`) compiles natively and has unit tests. Worker-bound code is covered by the HTTP suite.

## Data model (`api/migrations/0001_init.sql`)

- `users`: email (lowercase, unique), name, WebAuthn user handle, plan. Password columns from 0001 are unused.
- `passkeys`, `webauthn_challenges`, `recovery_codes`, `pairing_codes` (`0003_passkeys.sql`): public keys and counters, single-use challenges, SHA-256 of recovery and pairing codes.
- `sessions`: SHA-256 of the token only. `kind` is `browser` (30 days) or `device` (365 days, labeled).
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
| `src-tauri/src/observe.rs` | Observe loop, debounce, private-window filter, beside panel |
| `src/beside.ts`, `beside.html` | Beside panel UI: cards, feedback, Ask about this |
| `src-tauri/src/api.rs` | HTTPS client, server URL validation, SSE parser |
| `src/main.ts` | UI: sign-in, conversation, streaming render, citations, Observe toggle and "Working on" line |
| `src-tauri/capabilities/default.json` | The web view may only call Cognis commands and hide the window |

## Why the TypeScript worker is still here

`worker/` was the first implementation (Hono + Better Auth). The Rust API replaces it and keeps the same HTTP contract for items, search and collections. Auth endpoints changed. It stays in the repo as a reference and is not deployed.
