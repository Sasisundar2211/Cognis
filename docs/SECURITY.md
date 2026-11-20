# Security

## Controls in place (tested)

| Area | Control | Test |
|---|---|---|
| Passwords | Native scrypt (N=16384, r=16, p=1), 16-byte salt, constant-time compare, versioned hash format | `auth.test.ts` |
| Sessions | Better Auth, HTTP-only cookie, SameSite=Lax, Secure on HTTPS, 30-day expiry, server-side revocation | sign-out and reset tests |
| Email verification | Required when email is enabled; sign-in blocked until verified | `auth.test.ts` |
| Password reset | One-hour token, revokes all sessions | `auth.test.ts` |
| Brute force | Better Auth rate limits in D1: sign-in and sign-up 5/min, reset 3/5min. API 120/min, ingest 20/min per user | config |
| Mass assignment | `plan` is `input: false`; strict Zod schemas reject unknown fields | `auth.test.ts`, `items.test.ts` |
| Tenant isolation | user_id on every query, composite FKs, cascade delete | `tenant.test.ts` (read, update, delete, retry, search in 3 modes, list, tag, collection filter, cross-linking, export) |
| CSRF | JSON-only bodies, Origin check, Sec-Fetch-Site check; Better Auth checks trusted origins | `items.test.ts`, `auth.test.ts` |
| SSRF | http(s) only, default ports, no credentials, no IP literals, private ranges blocked (including decimal/octal/hex IPv4), internal TLDs blocked, every redirect re-validated, 3 redirect max | `ingest.test.ts` (29 cases) |
| Resource limits | 256 KB JSON bodies, 100 KB text, 1 MB fetch, 8 s timeout, 50 KB extracted text, 12 query terms, 500-char queries, plan item caps | `items.test.ts`, `ingest.test.ts` |
| XSS | Extracted content is plain text; React renders it as text nodes only; the app never injects raw HTML; links rendered only for http(s); strict CSP on assets | `ingest.test.ts`, code review |
| Injection | Bound parameters everywhere; FTS terms individually quoted | `search.test.ts` |
| Error leakage | Structured errors with request id; internal messages and stacks never returned | `items.test.ts` |
| Logging | Logs route pattern, status, latency, counts. Never bodies, queries, emails or content | code review |
| Headers | nosniff, no-referrer, DENY framing, no-store on API; CSP, HSTS, Permissions-Policy on assets | `items.test.ts` |
| Telemetry | Better Auth telemetry disabled | config |

## Untrusted content

Everything a user saves, and every page Cognis fetches, is data. It is never executed, never rendered as HTML, and never passed to a model as instructions. There is no LLM in the request path today. When one is added, retrieved content goes in a delimited data field and model output is schema-validated and cannot call tools.

## Known gaps

- No independent security review has been done on this codebase.
- WorkContext and the extension are not built. The SP2-S1 security gate still applies before any context capture ships.
- No DNS-rebinding defense beyond hostname checks. Cloudflare Workers cannot reach private networks we own, which limits impact.
- `npm audit` reports advisories in dev-only tooling (undici inside wrangler/miniflare, zod inside the test plugin). None ship in the Worker bundle. Runtime zod is 4.6.7, which includes the fix.
- Rate limiting via the Workers Rate Limiting API is per-location and approximate.
- Audit events are retained indefinitely. They hold only event type, user id and timestamp. Set a retention job before launch.

## Reporting

Report vulnerabilities privately to the repository owner. Do not open public issues for security problems.
