# Architecture

## Topology

One Cloudflare Worker serves everything from one origin:

```
Browser ──HTTPS──> Worker (cognis)
                    ├─ /api/auth/*  -> Better Auth
                    ├─ /api/v1/*    -> Hono API (requires session)
                    └─ everything else -> static assets (React SPA)
                   Bindings: D1 (DB), Workers AI (AI), Rate Limiting (API_LIMITER, INGEST_LIMITER)
```

One origin means no CORS, first-party `SameSite=Lax` cookies, and one deploy. No microservices.

## Code layout

```
worker/
  migrations/          D1 schema, versioned SQL
  src/index.ts         routes, middleware order
  src/auth.ts          Better Auth config
  src/middleware.ts    request id, security headers, CSRF guard, session, rate limits
  src/routes/          items, search, collections, account (me, tags, sources, export)
  src/knowledge/       KnowledgeObject service: create, process, update, delete, tags
  src/ingest/          URL safety (SSRF), safe fetch, HTML extraction
  src/retrieval/       embedder interface, filters, hybrid search + RRF
  test/                Vitest suites run inside workerd with a real D1
web/
  src/pages/           screens
  src/components/      shell, composer, item rows, UI primitives
  public/_headers      CSP and security headers for static assets
e2e/journey.cjs        Playwright browser journey
```

## Data model

`knowledge_items` is the KnowledgeObject. Key fields: `id` (public), `seq` (stable integer rowid for FTS), `user_id`, `kind` (url, text, note, capture), `title`, `original_url`, `canonical_url`, `source_platform`, `description`, `content` (user text), `extracted_text` (page text), `content_hash`, `metadata` (JSON), `status` (pending, processing, ready, failed), `error_code`, `attempts`, `archived`, `embedding` (Float32 BLOB), `embedding_model`, timestamps.

Tenant isolation is enforced at three layers:
1. Every query filters by `user_id` from the session. No code path loads a row by id alone.
2. Join tables (`item_tags`, `collection_items`) carry `user_id` with composite foreign keys `(user_id, id)`, so the database rejects links between objects of different users.
3. `ON DELETE CASCADE` from `user` removes all owned rows when an account is deleted.

Deduplication: unique `(user_id, canonical_url)` for links, unique `(user_id, content_hash)` for text.

## Ingestion pipeline

Receive -> validate (Zod, strict schemas) -> sanitize (strip control and bidi characters, NFC) -> normalize URL (canonical form, tracking params removed) -> dedupe -> store (status pending) -> fetch (SSRF-checked, every redirect re-validated, 1 MB cap, 8 s timeout, HTML or text only) -> extract (HTMLRewriter, text only) -> embed -> index (FTS5 triggers) -> status ready.

Text items process in the request. URL items process after the response in `waitUntil`. Failures store a stable `error_code` and can be retried up to 5 attempts.

## Retrieval

- Lexical: FTS5 with Porter stemming, BM25 with column weights title 4, description 2, content 1, page text 1. Query terms are tokenized and individually quoted, so FTS syntax in user input is inert.
- Semantic: query embedded with bge-small-en-v1.5, cosine against stored item vectors for the user's newest 2,000 items, floor 0.45 (uncalibrated starting value).
- Hybrid: Reciprocal Rank Fusion, `score = sum(1 / (60 + rank))`.
- Fallback: if the embedder is missing or fails, search answers lexically and the response sets `degraded: true`; the UI says so.
- Explanations come only from retrieval evidence: which retriever matched and which terms FTS highlighted.

Why brute-force vectors in D1 instead of Vectorize: Vectorize's free tier stores 5M dimensions in total (about 13,000 vectors at 384 dims across all users). D1's free tier holds 5 GB. Brute force over 2,000 vectors per user is cheap. Move to Vectorize with per-user namespaces when libraries outgrow the scan limit; the `search.ts` semantic function is the single swap point.
