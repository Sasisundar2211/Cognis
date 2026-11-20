# Testing

## Worker tests

```sh
npm test -w worker
```

Tests run inside workerd (the real Workers runtime) through `@cloudflare/vitest-plugin`, with a real local D1 database. Migrations apply before the suites. Email goes to an in-memory capture sink (`EMAIL_MODE=capture`, test only), so verification and reset links are followed for real.

| Suite | Covers |
|---|---|
| `auth.test.ts` | Hashing, verification-required sign-in, full flow, wrong and short passwords, plan mass assignment, sign-out revocation, password reset with session revocation, foreign-origin rejection, account deletion cascade including FTS |
| `tenant.test.ts` | Two users. Read, update, delete, retry, search (3 modes), list, tag filter, collection filter, collection access and cross-linking, export |
| `items.test.ts` | CRUD, tags, archive, duplicates, cursor pagination, 10 invalid payloads, malformed JSON, oversized body, CSRF variants, control and bidi stripping, security headers, collections |
| `ingest.test.ts` | 29 URL safety cases, canonicalization, platform labels, redirect re-validation, redirect cap, content type, size cap, HTML extraction, full pipeline with failure and retry, attempt cap |
| `search.test.ts` | Query tokenization, RRF math, lexical, hybrid, semantic, filters, pagination, hostile queries, degraded fallback, FTS sync on edit and delete |

Semantic tests use `TestHashEmbedder` (character trigrams). It checks the code path, not search quality. Search quality with the real model needs the evaluation harness, which is not built yet.

## Browser journey

```sh
cd worker && npx wrangler dev -c wrangler.dev.jsonc   # terminal 1
node e2e/journey.cjs /tmp/shots                       # terminal 2
```

Steps: landing, sign-up validation, sign-up, onboarding save, library, tagged save, duplicate notice, tag filter, keyboard search with degraded notice, edit, collection create and assign, delete, export download and content check, phone layout without horizontal overflow, account deletion, sign-in rejected after deletion, dark mode.

## Last run (2026-11-20)

- Worker: 75 passed, 0 failed.
- Browser journey: 14 of 14 steps passed. One console error: the expected 401 from signing in to the deleted account.
