# Production deployment (Cloudflare)

Live: https://cognis.sasisundhar2211.workers.dev (Workers Free plan, deployed 2026-11-23).

Costs nothing on the free plan. Passkey sign-in fits the free plan's 10 ms CPU limit. No email or domain is needed.

The API token needs these permissions: Account, Workers Scripts, Edit; Account, D1, Edit; Account, Workers AI, Read; User, Memberships, Read; User, User Details, Read.

## Steps

```sh
rustup target add wasm32-unknown-unknown
cargo install worker-build@0.9.0
npm install && npm run build -w web
cd api
npx wrangler login
npx wrangler d1 create cognis                  # first time only: paste database_id into api/wrangler.jsonc
npx wrangler d1 migrations apply cognis --remote
# APP_URL in api/wrangler.jsonc must equal the public URL: passkeys are bound to that origin.
# for Instagram posts and reels (optional, free Meta developer app with oEmbed Read):
#   npx wrangler secret put INSTAGRAM_OEMBED_TOKEN   # app id|client token
npx wrangler deploy
```

## Smoke test

```sh
curl -s https://<url>/api/v1/health     # {"status":"ok"}
curl -s https://<url>/api/v1/ready      # database ok, embeddings configured, answers configured
COGNIS_URL=https://<url> node e2e/journey.cjs /tmp/prod-check
```

The journey creates a passkey account with a virtual authenticator, runs every main flow and deletes the account.

Last production run (2026-11-23, version dc61aa95): every journey step passed; health ok; ready reports database ok, embeddings configured, answers configured.

Changing the URL (for example a custom domain later) invalidates existing passkeys, because they are bound to the domain. Users would sign in with a recovery code and add a new passkey.

## Desktop installers

```sh
cd desktop && npm run build     # on each OS: .deb/.AppImage on Linux, .msi/.exe on Windows, .dmg/.app on macOS
```

Tauri cannot cross-compile installers; build on each OS, or use a GitHub Actions matrix (`tauri-apps/tauri-action`).

## Staging, rollback, CI

- Staging: add `env.staging` to `api/wrangler.jsonc` with its own D1, deploy with `--env staging`, run the journey, then deploy production.
- Rollback: `npx wrangler deployments list` then `npx wrangler rollback <id>`. Code only; migrations must stay additive.
- CI (not set up): on push run `cargo test --lib`, build the test Worker, run the HTTP suite, `npm run build -w web`. Deploy on main with a `CLOUDFLARE_API_TOKEN` secret.
