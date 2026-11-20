# Production deployment (Cloudflare)

Not yet deployed. These are the exact steps. Run them from a machine that can reach `api.cloudflare.com`.

## Before the first deploy, decide

1. Workers plan. Free plan CPU limit is 10 ms per request. Password hashing measured about 60 ms. Expect sign-up and sign-in failures (error 1102) on Free. Workers Paid is $5/month and raises the limit to 30 s.
2. Email. Without a domain, set `EMAIL_MODE=disabled`: accounts work without email verification and password reset is unavailable. With a domain (about $10/year at Cloudflare Registrar), verify it in Resend (free tier: 3,000 emails/month, 100/day) and set `EMAIL_MODE=resend`.

## Steps

```sh
npx wrangler login                                   # opens a browser, sign in with the owner account
cd worker
npx wrangler d1 create cognis                        # copy the database_id into wrangler.jsonc
npx wrangler d1 migrations apply cognis --remote
npx wrangler secret put BETTER_AUTH_SECRET           # paste output of: openssl rand -hex 32
npx wrangler secret put BETTER_AUTH_URL              # https://cognis.<your-subdomain>.workers.dev
# Only with a domain:
#   npx wrangler secret put RESEND_API_KEY
#   npx wrangler secret put EMAIL_FROM               # "Cognis <hello@yourdomain.com>"
#   and set EMAIL_MODE to "resend" in wrangler.jsonc vars
cd .. && npm run build -w web && cd worker
npx wrangler deploy
```

## Verify (smoke test)

```sh
curl -s https://<url>/api/v1/health      # {"status":"ok"}
curl -s https://<url>/api/v1/ready       # database ok, embeddings configured
COGNIS_URL=https://<url> node ../e2e/journey.cjs /tmp/prod-check
```

The journey script expects `EMAIL_MODE=disabled` (it signs in right after sign-up). It creates and then deletes one test account.

## Staging

Add an `env.staging` block to `wrangler.jsonc` with its own D1 database, then `npx wrangler deploy --env staging`. Deploy to staging first, run the journey, then deploy production.

## Rollback

```sh
npx wrangler deployments list
npx wrangler rollback <deployment-id>
```

Rollback restores code, not data. Migrations are additive; never ship a destructive migration in the same release as code that depends on it.

## CI

Not set up. Recommended: GitHub Actions running `npm ci && npm run typecheck && npm test -w worker` on every push, and `wrangler deploy` on main with a `CLOUDFLARE_API_TOKEN` repository secret (scopes: Workers Scripts Edit, D1 Edit, Workers AI Read).
