# Implementation Status

Last updated: 2026-11-21. Branch: `claude/repository-audit-ww81s4`.

## What changed in this checkpoint

- The API is now Rust on Cloudflare Workers (`api/`). The TypeScript API (`worker/`) is superseded and kept for reference.
- New Grok-style workflow: a desktop companion (`desktop/`, Rust + Tauri) summoned by a global hotkey, and an `/api/v1/ask` endpoint that answers from your library with citations.
- The web app now uses the Rust auth endpoints and shows signed-in devices.

## Phase 0 note

The GitHub repository was empty at the start. The earlier local work (`D:\cognis`, checkpoint `10591e2`) was never pushed and is not part of this codebase.

## Modules

| Module | Status | Evidence / gap |
|---|---|---|
| Accounts: sign-up, sign-in, sign-out, sessions | Done | HTTP suite `auth.test.mjs`, browser journey |
| Email verification, password reset | Done in code, Blocked in production | Tested end to end with captured email. Production sending needs a verified sender domain |
| Device tokens for the desktop companion | Done | Bearer auth, listed in Account, revocable, tested |
| Change password, revoke sessions, delete account | Done | Cascade deletion tested |
| Knowledge CRUD, tags, collections, archive, provenance | Done | `items.test.mjs`, `tenant.test.mjs`, browser journey |
| Link import: SSRF checks, safe fetch, extraction, dedupe, retry | Done | 30 URL safety cases and fetch logic as Rust unit tests; live import tested in HTTP suite |
| Hybrid search: BM25 + embeddings + RRF k=60, filters, pagination, explanations, fallback | Done | `search.test.mjs` with a test embedder; real model untested locally |
| Ask (Grok-style): retrieve, answer with citations, stream progress | Partial | Sources-only path tested over HTTP and in the desktop app. The written-answer path with Workers AI is implemented but untested, because Workers AI is not reachable from this environment |
| Desktop companion: tray, global hotkey, floating window, ask, clipboard share, save, keychain token | Done on Linux | Ran under a virtual display: sign-in, ask, Esc hide, hotkey summon. Not run on macOS or Windows |
| Web app | Done | Browser journey 14 of 14 against the Rust API |
| Document upload | Not started | |
| TaskContext, relevance gate, proactive suggestions | Not started | |
| Reading selected text from other apps | Not started | Needs OS accessibility permissions; opt-in design required |
| Platform integrations | Not started | |
| Billing | Not started | Plan limits enforced server-side |
| Retrieval evaluation harness | Not started | |
| Production deployment | Blocked | See Blockers |

## Test results (actual, this commit)

- Rust API unit tests: 26 passed (`cargo test --lib` in `api/`).
- Rust API HTTP suite: 43 passed against the release Worker build in workerd with a local D1 (`npm --prefix api run test:http`).
- Desktop Rust tests: 2 passed (`cargo test` in `desktop/src-tauri`).
- Browser journey against the Rust API: 14 of 14 steps passed.
- Desktop app run under Xvfb: window shown, sign-in succeeded, ask streamed status and sources, Esc hid the window, the global hotkey showed it again.

## Blockers needing the owner

1. Cloudflare access. Deploying needs a Cloudflare account login or API token, and this environment's network blocks `api.cloudflare.com`. Run the steps in `docs/PRODUCTION-DEPLOYMENT.md` from your machine.
2. Workers Paid plan ($5/month). Password hashing costs about 250 ms of CPU in WebAssembly (measured about 0.3 s per sign-up request locally). The Free plan allows 10 ms. Sign-in will fail on Free.
3. A domain (about $10/year) for verification and reset emails. Without it, production runs with email disabled.
4. Code signing for desktop installers (optional): Apple Developer Program $99/year; Windows certificates vary. Unsigned installers work but show OS warnings.
