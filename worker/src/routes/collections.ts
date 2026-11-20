import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { ApiError } from "../lib/errors";
import { PLAN_LIMITS } from "../lib/plans";
import { newId, normalizeText, nowIso } from "../lib/util";
import { idParam, parseJson } from "../lib/validate";
import { getOwnedItem } from "../knowledge/service";

const body = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(500).optional() }).strict();
const patch = z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().max(500).optional() }).strict();

type CollectionRow = { id: string; name: string; description: string; created_at: string; updated_at: string; item_count: number };

const pub = (r: CollectionRow) => ({ id: r.id, name: r.name, description: r.description, itemCount: r.item_count, createdAt: r.created_at, updatedAt: r.updated_at });

async function owned(db: D1Database, userId: string, rawId: string) {
  const id = idParam.safeParse(rawId);
  if (!id.success) throw new ApiError(404, "not_found", "Collection not found.");
  const row = await db
    .prepare("SELECT c.*, (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id AND ci.user_id = c.user_id) AS item_count FROM collections c WHERE c.id = ? AND c.user_id = ?")
    .bind(id.data, userId)
    .first<CollectionRow>();
  if (!row) throw new ApiError(404, "not_found", "Collection not found.");
  return row;
}

function isUnique(e: unknown) {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

export const collections = new Hono<AppBindings>();

collections.get("/", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    "SELECT c.*, (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id AND ci.user_id = c.user_id) AS item_count FROM collections c WHERE c.user_id = ? ORDER BY c.name",
  ).bind(user.id).all<CollectionRow>();
  return c.json({ collections: results.map(pub) });
});

collections.post("/", async (c) => {
  const user = c.get("user");
  const input = await parseJson(c, body);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM collections WHERE user_id = ?").bind(user.id).first<{ n: number }>();
  const max = PLAN_LIMITS[user.plan].maxCollections;
  if ((count?.n ?? 0) >= max) throw new ApiError(403, "plan_limit_collections", `Your plan allows ${max} collections.`);
  const id = newId("col");
  const now = nowIso();
  try {
    await c.env.DB.prepare("INSERT INTO collections (id, user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, user.id, normalizeText(input.name, 80), normalizeText(input.description ?? "", 500), now, now)
      .run();
  } catch (e) {
    if (isUnique(e)) throw new ApiError(409, "collection_exists", "You already have a collection with that name.");
    throw e;
  }
  return c.json({ collection: pub(await owned(c.env.DB, user.id, id)) }, 201);
});

collections.get("/:id", async (c) => c.json({ collection: pub(await owned(c.env.DB, c.get("user").id, c.req.param("id"))) }));

collections.patch("/:id", async (c) => {
  const user = c.get("user");
  const row = await owned(c.env.DB, user.id, c.req.param("id"));
  const input = await parseJson(c, patch);
  try {
    await c.env.DB.prepare("UPDATE collections SET name = ?, description = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(input.name !== undefined ? normalizeText(input.name, 80) : row.name, input.description !== undefined ? normalizeText(input.description, 500) : row.description, nowIso(), row.id, user.id)
      .run();
  } catch (e) {
    if (isUnique(e)) throw new ApiError(409, "collection_exists", "You already have a collection with that name.");
    throw e;
  }
  return c.json({ collection: pub(await owned(c.env.DB, user.id, row.id)) });
});

collections.delete("/:id", async (c) => {
  const user = c.get("user");
  const row = await owned(c.env.DB, user.id, c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM collections WHERE id = ? AND user_id = ?").bind(row.id, user.id).run();
  return c.body(null, 204);
});

collections.put("/:id/items/:itemId", async (c) => {
  const user = c.get("user");
  const col = await owned(c.env.DB, user.id, c.req.param("id"));
  const itemId = idParam.safeParse(c.req.param("itemId"));
  if (!itemId.success) throw new ApiError(404, "not_found", "Item not found.");
  const item = await getOwnedItem(c.env.DB, user.id, itemId.data);
  await c.env.DB.prepare("INSERT INTO collection_items (user_id, collection_id, item_id, added_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(user.id, col.id, item.id, nowIso())
    .run();
  return c.body(null, 204);
});

collections.delete("/:id/items/:itemId", async (c) => {
  const user = c.get("user");
  const col = await owned(c.env.DB, user.id, c.req.param("id"));
  const itemId = idParam.safeParse(c.req.param("itemId"));
  if (!itemId.success) throw new ApiError(404, "not_found", "Item not found.");
  await c.env.DB.prepare("DELETE FROM collection_items WHERE user_id = ? AND collection_id = ? AND item_id = ?").bind(user.id, col.id, itemId.data).run();
  return c.body(null, 204);
});
