# Local development

Requirements: Node.js 22+, npm 10+.

```sh
npm install                      # root .npmrc sets legacy-peer-deps (works around an npm 10 peer resolution bug)
npm run build -w web             # builds the SPA into web/dist, which the Worker serves
cd worker
npx wrangler d1 migrations apply cognis-dev --local -c wrangler.dev.jsonc
echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)" > .dev.vars
npx wrangler dev -c wrangler.dev.jsonc   # http://localhost:8787
```

Use `localhost`, not `127.0.0.1`, in the browser. Auth checks the origin against `BETTER_AUTH_URL`.

For frontend hot reload, keep `wrangler dev` running and in another terminal run `npm run dev -w web` (Vite on :5173 proxies `/api` to :8787). Set `BETTER_AUTH_URL` to `http://localhost:5173` in `wrangler.dev.jsonc` while doing so.

## Local differences from production

| Setting | Local (`wrangler.dev.jsonc`) | Production (`wrangler.jsonc`) |
|---|---|---|
| Embeddings | `EMBEDDER=none`: search runs lexical only and shows a notice | Workers AI |
| Email | `EMAIL_MODE=disabled`: no verification | `resend` once a domain exists |
| Database | Local SQLite under `.wrangler/` | D1 |

## Commands

```sh
npm test -w worker          # 75 tests in the Workers runtime
npm run typecheck           # worker + web
node e2e/journey.cjs /tmp   # browser journey against a running wrangler dev
```

## Adding a migration

Create `worker/migrations/000N_name.sql`. Never edit an applied migration. Apply locally with the command above; tests apply all migrations automatically.
