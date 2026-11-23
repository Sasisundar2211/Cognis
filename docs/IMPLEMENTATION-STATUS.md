# Implementation Status

Last updated: 2026-11-23. Branch: `claude/repository-audit-ww81s4`.

## What changed in this checkpoint

Latest (2026-11-23):
- Deployed to Cloudflare's free plan: https://cognis.sasisundhar2211.workers.dev (Worker, D1, Workers AI, static assets, cron every 5 minutes).
- Passwords replaced by passkeys (WebAuthn, ES256 and RS256), with 10 single-use recovery codes. Reason: scrypt needed about 250 ms CPU and the free plan allows 10 ms. A passkey sign-in measured about 13 ms end to end locally.
- Desktop companion signs in with an 8-character pairing code made in the web app (Account, Desktop companion). Codes expire after 10 minutes and work once.
- Answer model changed to Mistral Small 3.1 24B (Apache 2.0), because Cloudflare deprecated Llama 3.1 8B on 2026-05-30.
- Reddit falls back to its oEmbed route (title and author) because Reddit returns 403 to Cloudflare servers. TikTok posts with no readable text now fail with `no_content` instead of saving an empty item.

Earlier (2026-11-22):
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
| Accounts with passkeys: sign-up, sign-in, sign-out, sessions, recovery codes, add and remove passkeys | Done, live | `auth.test.mjs` with a software authenticator (signature, challenge, origin, counter and tamper checks), browser journey locally and in production with a virtual authenticator |
| Email | Not used | Passkeys need no verification or reset email. Recovery codes replace password reset. `email.rs` and `password.rs` remain in the tree, unused |
| Desktop pairing and device tokens | Done, live | 10-minute single-use pairing code exchanged for a revocable Bearer token; tested over HTTP and against production |
| Revoke sessions, delete account | Done, live | Deletion needs a typed DELETE and a session under 15 minutes old; cascade deletion tested locally and in production |
| Knowledge CRUD, tags, collections, archive, provenance | Done | `items.test.mjs`, `tenant.test.mjs`, browser journey |
| Link import: SSRF checks, safe fetch, extraction, dedupe, retry | Done | 30 URL safety cases and fetch logic as Rust unit tests; the import lifecycle (pending to ready or failed with a stable code) is tested over HTTP; live sites are unreachable from this environment |
| Hybrid search: BM25 + embeddings + RRF k=60, filters, pagination, explanations, fallback | Done, live | `search.test.mjs` with a test embedder; production journey found an item by meaning with the real `bge-small-en-v1.5` |
| Ask (Grok-style): retrieve, answer with citations, stream progress | Done, live | Production: answer in about 1 s citing [1] correctly; streaming sends status, sources, delta and done; a question outside the library got "Nothing in your library covers this." Quality not measured beyond spot checks |
| Desktop companion: tray, global hotkey, floating window, ask, save, keychain token | Done on Linux | Ran under a virtual display: sign-in, ask, Esc hide, hotkey summon. Not run on macOS or Windows |
| Observe mode (WorkContext) and beside panel | Done on Linux X11 | Under Xvfb + openbox: panel appeared 3 s after a work window came to the front, focus not stolen, 1Password window not sent, ask kept the work context. Not run on macOS, Windows or Wayland. Has not had the independent security review the original brief requires before production |
| TaskContext (deterministic, from window titles) and relevance gate | Done | 5 unit tests for extraction and gate states; HTTP tests for suggest, cooldown, private windows, dedupe, feedback, Useful Intervention Rate |
| Saved posts and reels from links | Partial, live | Production results: X, YouTube, GitHub and articles (Wikipedia, 17,604 characters) ready with full text. Reddit ready with title and author only (oEmbed fallback). Instagram fails with `login_wall` until a Meta token is set. TikTok returns no readable text from Cloudflare and fails with `no_content` |
| Bulk link import and scheduled queue | Done | HTTP test: 7 links in, 4 queued, duplicate and unsafe links reported, cron run moves every item out of pending |
| Web app | Done, live | Browser journey passes locally and against production |
| Document upload | Not started | |
| Reading window contents or selected text | Not started | Deliberately out of scope for Observe v1 |
| Platform integrations | Not started | |
| Billing | Not started | Plan limits enforced server-side |
| Retrieval evaluation harness | Not started | |
| Production deployment | Done | https://cognis.sasisundhar2211.workers.dev on the Workers Free plan; `/api/v1/ready` reports database ok, embeddings configured, answers configured |

## Test results (actual, this commit)

- Rust API unit tests: 41 passed (`cargo test --lib` in `api/`), including WebAuthn parsing and signature checks.
- Rust API HTTP suite: 53 passed against the release Worker build in workerd with a local D1.
- Desktop Rust tests: 5 passed.
- Browser journey: all steps passed locally and against production (passkey sign-up, recovery codes, sign-out, passkey sign-in, save, tag filter, search by words and meaning, edit, collections, delete, export, mobile layout, account deletion).
- Live checks on production: cited answer, streaming answer, Observe suggestion at HIGH_CONFIDENCE, link import per platform (results above), cron processed every pending item.

## Open items needing the owner

1. Revoke the Cloudflare API token pasted in chat on 2026-11-23 (Cloudflare dashboard, My Profile, API Tokens), then create a new one only when you deploy again.
2. Instagram: a Meta developer app token (free) for Instagram's official oEmbed, saved with `npx wrangler secret put INSTAGRAM_OEMBED_TOKEN`. Without it Instagram links fail with `login_wall`.
3. Independent security review of Observe and passkey auth before inviting other users.
4. Code signing for desktop installers (optional): Apple Developer Program $99/year; Windows certificates vary. Unsigned installers work but show OS warnings.
5. Billing is not connected. Plans and limits exist; nobody can pay yet.
