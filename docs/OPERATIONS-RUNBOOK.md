# Operations runbook

## Health

- `GET /api/v1/health`: process up.
- `GET /api/v1/ready`: database reachable, embeddings configured. Returns 503 when D1 fails.

## Logs

Workers Logs is enabled (`observability.enabled`). Every API request logs one JSON line: `requestId`, method, route pattern, status, latency in ms. Searches also log mode, degraded flag, hit count and latency. Logs never contain request bodies, queries, emails or item content.

```sh
npx wrangler tail cognis --format json
```

Every error response includes `requestId`. Ask users for it, then search logs for it.

## Signals to watch

| Signal | Where | Action |
|---|---|---|
| Error 1102 (CPU exceeded) | Workers dashboard | Move to Workers Paid |
| `degraded: true` in search logs | logs | Workers AI unavailable or daily free allocation used up |
| Many items with `status = failed` | `SELECT error_code, COUNT(*) FROM knowledge_items WHERE status='failed' GROUP BY 1` | Check for a site blocking the fetcher, or a parser regression |
| 429 rate | logs | Abuse, or limits too tight |

## Backups and restore

D1 Time Travel keeps point-in-time history (7 days on Free, 30 days on Paid).

```sh
npx wrangler d1 time-travel info cognis                      # current bookmark
npx wrangler d1 time-travel restore cognis --timestamp=<ISO>  # restore the whole database
```

Restore replaces the whole database. It also brings back data users deleted after that time. Prefer restoring into a new database and copying specific rows.

Weekly offline export (recommended once live):

```sh
npx wrangler d1 export cognis --remote --output backup-$(date +%F).sql
```

Note: D1 export does not support virtual tables. After importing a backup, rebuild the search index:

```sql
INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild');
```

## Incidents

1. Find the deployment that started it: `npx wrangler deployments list`.
2. If it correlates with a deploy, roll back: `npx wrangler rollback <id>`.
3. If data is affected, stop writes by deploying a maintenance build, then use Time Travel.
4. Record what happened, when, the impact and the fix.

## Rotating the auth secret

`wrangler secret put BETTER_AUTH_SECRET` with a new value signs out every user. Do it after any suspected leak.
