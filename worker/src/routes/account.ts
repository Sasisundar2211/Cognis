import { Hono } from "hono";
import type { AppBindings } from "../env";
import { PLAN_LIMITS } from "../lib/plans";
import { ITEM_COLUMNS, loadRelations, toPublic, type ItemRow } from "../knowledge/service";
import { audit } from "../lib/audit";

export const account = new Hono<AppBindings>();

account.get("/me", async (c) => {
  const user = c.get("user");
  const usage = await c.env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM knowledge_items WHERE user_id = ?1) AS items, (SELECT COUNT(*) FROM collections WHERE user_id = ?1) AS collections",
  ).bind(user.id).first<{ items: number; collections: number }>();
  return c.json({ user, usage: usage ?? { items: 0, collections: 0 }, limits: PLAN_LIMITS[user.plan] });
});

account.get("/tags", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    "SELECT t.name AS name, COUNT(it.item_id) AS count FROM tags t LEFT JOIN item_tags it ON it.tag_id = t.id AND it.user_id = t.user_id WHERE t.user_id = ? GROUP BY t.id ORDER BY t.name",
  ).bind(user.id).all<{ name: string; count: number }>();
  return c.json({ tags: results });
});

account.get("/sources", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    "SELECT source_platform AS source, COUNT(*) AS count FROM knowledge_items WHERE user_id = ? GROUP BY source_platform ORDER BY count DESC",
  ).bind(user.id).all<{ source: string; count: number }>();
  return c.json({ sources: results });
});

/** Full export of the user's own data as JSON. Embeddings are excluded (derived data, rebuilt on import). */
account.get("/export", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const { results } = await db.prepare(`SELECT ${ITEM_COLUMNS} FROM knowledge_items WHERE user_id = ? ORDER BY created_at`).bind(user.id).all<ItemRow>();
  const { tags, cols } = await loadRelations(db, user.id, results.map((r) => r.id));
  const collections = (await db.prepare("SELECT id, name, description, created_at FROM collections WHERE user_id = ?").bind(user.id).all()).results;
  await audit(db, user.id, "account.exported", { items: results.length });
  c.header("Content-Disposition", 'attachment; filename="cognis-export.json"');
  return c.json({
    exportedAt: new Date().toISOString(),
    format: "cognis-export/1",
    user: { id: user.id, email: user.email, name: user.name },
    collections,
    items: results.map((r) => toPublic(r, tags.get(r.id) ?? [], cols.get(r.id) ?? [])),
  });
});
