# Production deployment (Cloudflare)

Not yet deployed. Run these steps from a machine that can reach `api.cloudflare.com`.

## Decide first

1. Workers Paid ($5/month). Required: password hashing uses about 250 ms CPU per sign-in; the Free plan allows 10 ms.
2. Email. Without a domain, keep `EMAIL_MODE=disabled` (no verification, no password reset). With a domain (about $10/year), verify it in Resend (free: 3,000 emails/month) and set `EMAIL_MODE=resend`.

## Steps

```sh
rustup target add wasm32-unknown-unknown
cargo install worker-build@0.9.0
npm install && npm run build -w web
cd api
npx wrangler login
npx wrangler d1 create cognis                  # paste database_id into api/wrangler.jsonc
npx wrangler d1 migrations apply cognis --remote
npx wrangler secret put APP_URL                # https://cognis.<your-subdomain>.workers.dev
# with a domain only:
#   npx wrangler secret put RESEND_API_KEY
#   npx wrangler secret put EMAIL_FROM         # Cognis <hello@yourdomain.com>
#   set "EMAIL_MODE": "resend" in api/wrangler.jsonc
npx wrangler deploy
```

## Smoke test

```sh
curl -s https://<url>/api/v1/health     # {"status":"ok"}
curl -s https://<url>/api/v1/ready      # database ok, embeddings configured, answers configured
COGNIS_URL=https://<url> node e2e/journey.cjs /tmp/prod-check
```

The journey creates and deletes one account and expects `EMAIL_MODE=disabled`.

Then sign in with the desktop companion using `https://<url>` and ask a question. This is the first run of the real answer path.

## Desktop installers

```sh
cd desktop && npm run build     # on each OS: .deb/.AppImage on Linux, .msi/.exe on Windows, .dmg/.app on macOS
```

Tauri cannot cross-compile installers; build on each OS, or use a GitHub Actions matrix (`tauri-apps/tauri-action`).

## Staging, rollback, CI

- Staging: add `env.staging` to `api/wrangler.jsonc` with its own D1, deploy with `--env staging`, run the journey, then deploy production.
- Rollback: `npx wrangler deployments list` then `npx wrangler rollback <id>`. Code only; migrations must stay additive.
- CI (not set up): on push run `cargo test --lib`, build the test Worker, run the HTTP suite, `npm run build -w web`. Deploy on main with a `CLOUDFLARE_API_TOKEN` secret.
