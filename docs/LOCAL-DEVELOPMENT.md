# Local development

Requirements: Rust 1.85+ with `wasm32-unknown-unknown`, `worker-build` 0.9, Node.js 22+, npm 10+.

```sh
rustup target add wasm32-unknown-unknown
cargo install worker-build@0.9.0
npm install                 # root .npmrc sets legacy-peer-deps (npm 10 peer resolution bug)
npm run build -w web        # the Worker serves web/dist
```

## API + web app

```sh
cd api
npx wrangler d1 migrations apply cognis-dev --local -c wrangler.dev.jsonc --persist-to .wrangler/dev
npx wrangler dev -c wrangler.dev.jsonc --persist-to .wrangler/dev     # builds the Rust Worker, serves http://localhost:8787
```

Use `localhost`, not `127.0.0.1`, in the browser (origin checks use `APP_URL`).

Local differences from production:

| Setting | Local | Production |
|---|---|---|
| `EMBEDDER` | `none`: search is lexical, the UI says so | `workers-ai` |
| Answers | Not available: `/ask` returns sources only | Workers AI LLM |
| `EMAIL_MODE` | `disabled`: no verification | `resend` once a domain exists |

## Desktop companion

```sh
cd desktop
npm run dev          # Tauri dev window; sign in with server http://localhost:8787
```

Linux needs the system packages listed in `docs/DESKTOP.md`.

## Tests

```sh
cd api
cargo test --lib                                     # 26 unit tests, native
npm run serve:test                                   # terminal 1: test Worker on :8788 (release build, test hooks)
npm run test:http                                    # terminal 2: 43 HTTP tests
cd ../desktop/src-tauri && cargo test                # desktop unit tests
node e2e/journey.cjs /tmp/shots                      # browser journey against :8787
```

## Migrations

Add `api/migrations/000N_name.sql`. Never edit an applied migration.
