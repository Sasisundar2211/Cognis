# Pricing and operating costs

## User plans (proposed, not on sale)

| Plan | Price | Items | Link imports/day | Collections | Answers/day | Planned extras |
|---|---|---|---|---|---|---|
| Free | $0 | 500 | 50 | 10 | 30 | Desktop companion, search by words and meaning, export, deletion |
| Plus | $3/month | 10,000 | 500 | 200 | 200 | Context suggestions |
| Pro | $8/month | 50,000 | 2,000 | 1,000 | 1,000 | Platform imports, priority processing |

Limits are enforced in `api/src/plans.rs`. Plus and Pro extras are not built yet and are labeled as planned on the pricing page.

Payment provider: not connected. Polar (polar.sh) fits the open-source preference: open-source platform, merchant of record (handles sales tax), no monthly fee, about 4% + $0.40 per transaction. Stripe is the alternative. Connecting either needs an account in the owner's name.

## Operating costs (Cloudflare, as of 2026-11)

| Service | Free tier | Cognis use | Paid |
|---|---|---|---|
| Workers | 100k requests/day, 10 ms CPU | API + static assets | $5/month: 10M requests, 30 s CPU |
| D1 | 5 GB, 5M rows read/day, 100k rows written/day | All data, FTS, vectors | Included in $5 plan, then usage-based |
| Workers AI | 10,000 neurons/day | Embeddings on save and search | $0.011 per 1,000 neurons |
| Static assets | Free, unlimited | Web app | Free |
| Rate Limiting | Free | Abuse control | Free |
| Domain | none (workers.dev subdomain) | | ~$10/year |
| Resend email | 3,000/month, 100/day | Verification, reset | $20/month for 50k |

Check current limits on Cloudflare's pricing pages before launch; they change.

Realistic minimum for a working launch: $5/month (Workers Paid, required because password hashing needs about 250 ms CPU) plus about $10/year (domain, needed for email). Workers AI usage for answers is billed per neuron above the free daily allocation; measure it after launch before setting paid-plan answer limits. Optional: Apple Developer Program ($99/year) to sign the macOS companion.
