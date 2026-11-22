# Implementation Status

Last updated: 2026-11-22. Branch: `claude/repository-audit-ww81s4`.

## What changed in this checkpoint

Latest:
- Observe mode: the desktop companion watches the app and window title in front of you (opt-in) and a beside panel suggests saved items when they fit your work. The clipboard is no longer used anywhere.
- Saved posts and reels from a link: official routes for Reddit, X, YouTube, TikTok, Instagram (with a Meta token) and GitHub; bulk import of up to 50 links; a scheduled job works through the queue.

Earlier:

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
| Link import: SSRF checks, safe fetch, extraction, dedupe, retry | Done | 30 URL safety cases and fetch logic as Rust unit tests; the import lifecycle (pending to ready or failed with a stable code) is tested over HTTP; live sites are unreachable from this environment |
| Hybrid search: BM25 + embeddings + RRF k=60, filters, pagination, explanations, fallback | Done | `search.test.mjs` with a test embedder; real model untested locally |
| Ask (Grok-style): retrieve, answer with citations, stream progress | Partial | Sources-only path tested over HTTP and in the desktop app. The written-answer path with Workers AI is implemented but untested, because Workers AI is not reachable from this environment |
| Desktop companion: tray, global hotkey, floating window, ask, save, keychain token | Done on Linux | Ran under a virtual display: sign-in, ask, Esc hide, hotkey summon. Not run on macOS or Windows |
| Observe mode (WorkContext) and beside panel | Done on Linux X11 | Under Xvfb + openbox: panel appeared 3 s after a work window came to the front, focus not stolen, 1Password window not sent, ask kept the work context. Not run on macOS, Windows or Wayland. Has not had the independent security review the original brief requires before production |
| TaskContext (deterministic, from window titles) and relevance gate | Done | 5 unit tests for extraction and gate states; HTTP tests for suggest, cooldown, private windows, dedupe, feedback, Useful Intervention Rate |
| Saved posts and reels from links | Done in code, live extraction unverified | Parsers and routing unit-tested on documented response formats; this environment cannot reach Reddit, X, YouTube, TikTok or Instagram, so real responses are untested |
| Bulk link import and scheduled queue | Done | HTTP test: 7 links in, 4 queued, duplicate and unsafe links reported, cron run moves every item out of pending |
| Web app | Done | Browser journey 14 of 14 against the Rust API |
| Document upload | Not started | |
| Reading window contents or selected text | Not started | Deliberately out of scope for Observe v1 |
| Platform integrations | Not started | |
| Billing | Not started | Plan limits enforced server-side |
| Retrieval evaluation harness | Not started | |
| Production deployment | Blocked | See Blockers |

## Test results (actual, this commit)

- Rust API unit tests: 37 passed (`cargo test --lib` in `api/`).
- Rust API HTTP suite: 53 passed against the release Worker build in workerd with a local D1 (`npm --prefix api run test:http`).
- Desktop Rust tests: 5 passed (`cargo test` in `desktop/src-tauri`).
- Browser journey against the Rust API: 14 of 14 steps passed. Bulk link paste checked separately in the browser.
- Desktop app under Xvfb + openbox: sign-in, Observe on, beside panel shown for a matching work window without stealing focus, private window skipped, hotkey summon kept the work context, vague question found the right note.

## Blockers needing the owner

1. Cloudflare access. Deploying needs a Cloudflare account login or API token, and this environment's network blocks `api.cloudflare.com`. Run the steps in `docs/PRODUCTION-DEPLOYMENT.md` from your machine.
2. Workers Paid plan ($5/month). Password hashing costs about 250 ms of CPU in WebAssembly (measured about 0.3 s per sign-up request locally). The Free plan allows 10 ms. Sign-in will fail on Free.
3. A domain (about $10/year) for verification and reset emails. Without it, production runs with email disabled.
4. Instagram: a Meta developer app token (free) for Instagram's official oEmbed. Without it, Instagram links usually fail with `login_wall`.
5. Code signing for desktop installers (optional): Apple Developer Program $99/year; Windows certificates vary. Unsigned installers work but show OS warnings.
