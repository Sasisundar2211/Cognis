# Security

## Controls in place (tested)

| Area | Control | Test |
|---|---|---|
| Passwords | scrypt (N=2^14, r=16, p=1, 64-byte key, 16-byte salt), constant-time compare, versioned format, NFKC normalization | Rust unit tests |
| Timing | Unknown emails verify against a dummy hash; same error text for wrong password and unknown user | `auth.test.mjs` |
| Sessions | 256-bit random tokens; only SHA-256 stored; HttpOnly, SameSite=Lax cookie, `__Host-` prefix and Secure on HTTPS; 30-day expiry; server-side revocation | `auth.test.mjs` |
| Device tokens | Same token scheme, 365 days, labeled, listed and revocable in Account; Bearer only, never a cookie; stored in the OS keychain by the companion | `auth.test.mjs`, `tenant.test.mjs` |
| Email tokens | Hashed, single use (deleted in the reading statement), 24 h verify, 1 h reset; reset revokes all sessions | `auth.test.mjs` |
| Account enumeration | Sign-up with an existing email answers the same as a new one (when email is enabled) and notifies the owner; reset answers the same for unknown emails | `auth.test.mjs` |
| Brute force | D1 fixed-window limits: sign-in 10/min per IP and 5/min per email, sign-up 5/min, reset 3/5 min; API 120/min and ingest 20/min per user; asks per day by plan | config, code review |
| Mass assignment | Strict serde schemas (`deny_unknown_fields`); plan cannot be set by clients | `auth.test.mjs`, `items.test.mjs` |
| Tenant isolation | user_id on every query, composite foreign keys, cascade delete | `tenant.test.mjs` (cookie and device token, read, update, delete, retry, search 3 modes, ask, list, tags, sources, collection filter, cross-linking, sessions, export) |
| CSRF | Cookie requests: Origin must match, Sec-Fetch-Site cross-site rejected, bodies must be JSON. Bearer requests skip these (no ambient credential) | `items.test.mjs`, `auth.test.mjs` |
| SSRF | http(s) only, default ports, no credentials, no IP literals, private ranges (all IPv4 encodings), internal and reserved TLDs, every redirect re-validated, 3 redirects max, 8 s timeout, 1 MB cap, text types only | Rust unit tests (30 cases + fetch mocks) |
| Prompt injection | Sources and shared text go in delimited blocks; delimiters inside content are neutralized; the system prompt says to treat them as data; the model has no tools and can only produce text; history roles are forced to user or assistant; citations are checked against real sources | Rust unit tests in `ask.rs` |
| XSS | Extracted content is plain text; the web app and the companion render text nodes only and never inject raw HTML; only http(s) links open; strict CSP in both | code review, `ingest` tests |
| Injection | Bound parameters everywhere; FTS terms quoted | `search.test.mjs` |
| Error leakage | Stable codes and request ids; driver errors logged by category only | `items.test.mjs` |
| Logging | Method, coarse route (no ids), status, latency, counts. Never bodies, questions, emails or content | code review |
| Desktop | Web view has no network access (CSP `connect-src ipc:`); only Cognis commands and window hide are allowed; HTTPS-only servers (localhost excepted); no background capture; clipboard read only on explicit click with visible preview | `api.rs` tests, capability file |

## Known gaps

- No independent security review of this codebase yet.
- Rate limits for auth are per IP and email in D1; a distributed attacker can still try slow credential stuffing. Add Cloudflare Turnstile on sign-up and sign-in before launch.
- scrypt parameters are below OWASP's strongest recommendation because of Workers CPU cost. Raise N when moving to a larger CPU budget; the hash format supports it.
- The written-answer path of `/ask` has not run against the real model. Prompt-injection resistance of the model itself is not measured.
- Desktop installers are unsigned.
- `npm audit` lists advisories in dev-only tooling (wrangler, miniflare). Nothing from them ships.
- Audit events have no retention job yet.

## Reporting

Report vulnerabilities privately to the repository owner. Do not open public issues for security problems.
