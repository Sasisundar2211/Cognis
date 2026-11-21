# Testing

## Layers

| Layer | Command | Count | Runs against |
|---|---|---|---|
| Rust unit (API pure logic) | `cd api && cargo test --lib` | 26 | native |
| HTTP black-box (API contract) | `cd api && npm run serve:test` then `npm run test:http` | 43 | release Worker build in workerd, local D1 |
| Desktop unit | `cd desktop/src-tauri && cargo test` | 2 | native |
| Browser journey | `node e2e/journey.cjs <dir>` | 14 steps | `wrangler dev` with the Rust API |
| Desktop run | manual script under Xvfb (see below) | 5 checks | the real app binary |

The test Worker is built with the `test-hooks` Cargo feature, which adds `GET /api/test/emails` (captured verification and reset emails). Production builds do not compile it.

## What each suite covers

- Unit: URL safety (30 cases), canonicalization, platform labels, safe fetch (private redirect, redirect cap, content types, size cap, relative redirects), HTML extraction, entity decoding, query tokenization, RRF math, explanations, embeddings, password hashing and hostile hashes, ISO dates, text normalization, prompt delimiters, history caps, citation checks, model stream parsing.
- `auth.test.mjs`: verification gate, full flow, single-use links, wrong and unknown credentials with identical messages, password length, unknown fields, no enumeration, forged sessions, sign-out, reset with revocation, change password, device tokens, foreign origins, account deletion, headers.
- `tenant.test.mjs`: two users with cookies and device tokens across items, search, ask, tags, sources, collections, sessions, export.
- `items.test.mjs`: CRUD, duplicates, cursors, 12 invalid payloads, malformed JSON, bad params, oversized body, CSRF, control characters, provenance links, URL import lifecycle, collections.
- `search.test.mjs`: lexical, hybrid, semantic, filters, pagination, hostile queries, FTS sync, ask without a model, ask streaming events, ask validation.

Semantic tests use a trigram-hash test embedder. It checks the code path, not search quality.

## Desktop run (last result)

Under Xvfb with xdotool: the window appeared, sign-in with a device token succeeded, an ask streamed "Searching your library", "Read 1 saved item", "Done" and listed the source, Esc hid the window, Ctrl+Shift+Space showed it again.

## Not tested

- The written-answer path of `/ask` with the real Workers AI model.
- Search quality with the real embedding model.
- The desktop app on macOS and Windows; global hotkeys on Wayland.
- Production deployment.

## Last run: 2026-11-21

Unit 26 passed. HTTP 43 passed. Desktop unit 2 passed. Journey 14 of 14 passed.
