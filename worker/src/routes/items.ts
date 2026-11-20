import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { ApiError } from "../lib/errors";
import { idParam, parseJson, parseQuery } from "../lib/validate";
import { bodyLimit, rateLimit } from "../middleware";
import { buildFilterSql } from "../retrieval/filters";
import {
  createItem, deleteItem, getOwnedItem, ITEM_COLUMNS, loadRelations, processItem, publicItem, toPublic, updateItem,
  type ItemRow,
} from "../knowledge/service";
import { audit } from "../lib/audit";

const tagList = z.array(z.string().min(1).max(64)).max(20).optional();

const createSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: z.string().min(1).max(2048), title: z.string().max(300).optional(), note: z.string().max(20_000).optional(), tags: tagList }).strict(),
  z.object({
    kind: z.enum(["text", "note", "capture"]),
    content: z.string().min(1).max(100_000),
    title: z.string().max(300).optional(),
    sourceUrl: z.string().max(2048).optional(),
    tags: tagList,
  }).strict(),
]);

const patchSchema = z
  .object({
    title: z.string().max(300).optional(),
    content: z.string().max(100_000).optional(),
    description: z.string().max(1000).optional(),
    archived: z.boolean().optional(),
    tags: z.array(z.string().min(1).max(64)).max(20).optional(),
  })
  .strict();

const isoDate = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date");

export const listQuery = z.object({
  source: z.string().max(32).optional(),
  tag: z.string().max(64).optional(),
  collection: idParam.optional(),
  status: z.enum(["pending", "processing", "ready", "failed"]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  archived: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(80).optional(),
});

export const items = new Hono<AppBindings>();

items.post("/", bodyLimit(256_000), rateLimit("INGEST_LIMITER"), async (c) => {
  const user = c.get("user");
  const input = await parseJson(c, createSchema);
  const result = await createItem(c.env, user, input);
  let row = result.row;
  if (result.needsProcessing) {
    if (row.kind === "url") {
      // URL fetches run after the response so the user is not kept waiting on a slow site.
      c.executionCtx.waitUntil(processItem(c.env, user.id, row.id).catch(() => undefined));
    } else {
      row = await processItem(c.env, user.id, row.id);
    }
    await audit(c.env.DB, user.id, "item.created", { kind: row.kind });
  }
  return c.json({ item: await publicItem(c.env.DB, user.id, row), duplicate: result.duplicate }, result.duplicate ? 200 : 201);
});

items.get("/", async (c) => {
  const user = c.get("user");
  const q = parseQuery(c, listQuery);
  const flt = buildFilterSql("k", {
    source: q.source, tag: q.tag, collectionId: q.collection, status: q.status, from: q.from, to: q.to,
    includeArchived: q.archived === "true",
  });
  let cursorSql = "";
  const cursorParams: unknown[] = [];
  if (q.cursor) {
    const [createdAt, seq] = q.cursor.split("|");
    if (!createdAt || !seq || !/^\d+$/.test(seq)) throw new ApiError(422, "invalid_cursor", "Invalid page cursor.");
    cursorSql = " AND (k.created_at < ? OR (k.created_at = ? AND k.seq < ?))";
    cursorParams.push(createdAt, createdAt, Number(seq));
  }
  const archivedOnly = q.archived === "true" ? " AND k.archived = 1" : "";
  const sql = `SELECT ${ITEM_COLUMNS.split(", ").map((c) => `k.${c}`).join(", ")} FROM knowledge_items k
    WHERE k.user_id = ?${flt.sql}${archivedOnly}${cursorSql} ORDER BY k.created_at DESC, k.seq DESC LIMIT ?`;
  const { results } = await c.env.DB.prepare(sql).bind(user.id, ...flt.params, ...cursorParams, q.limit + 1).all<ItemRow>();
  const page = results.slice(0, q.limit);
  const { tags, cols } = await loadRelations(c.env.DB, user.id, page.map((r) => r.id));
  const last = page[page.length - 1];
  return c.json({
    items: page.map((r) => toPublic(r, tags.get(r.id) ?? [], cols.get(r.id) ?? [])),
    nextCursor: results.length > q.limit && last ? `${last.created_at}|${last.seq}` : null,
  });
});

items.get("/:id", async (c) => {
  const user = c.get("user");
  const id = idParam.safeParse(c.req.param("id"));
  if (!id.success) throw new ApiError(404, "not_found", "Item not found.");
  const row = await getOwnedItem(c.env.DB, user.id, id.data);
  return c.json({ item: await publicItem(c.env.DB, user.id, row) });
});

items.patch("/:id", bodyLimit(256_000), async (c) => {
  const user = c.get("user");
  const id = idParam.safeParse(c.req.param("id"));
  if (!id.success) throw new ApiError(404, "not_found", "Item not found.");
  const patch = await parseJson(c, patchSchema);
  const row = await updateItem(c.env, user.id, id.data, patch);
  return c.json({ item: await publicItem(c.env.DB, user.id, row) });
});

items.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = idParam.safeParse(c.req.param("id"));
  if (!id.success) throw new ApiError(404, "not_found", "Item not found.");
  await deleteItem(c.env.DB, user.id, id.data);
  await audit(c.env.DB, user.id, "item.deleted");
  return c.body(null, 204);
});

items.post("/:id/retry", rateLimit("INGEST_LIMITER"), async (c) => {
  const user = c.get("user");
  const id = idParam.safeParse(c.req.param("id"));
  if (!id.success) throw new ApiError(404, "not_found", "Item not found.");
  const row = await getOwnedItem(c.env.DB, user.id, id.data);
  if (row.status !== "failed") throw new ApiError(409, "not_failed", "Only failed items can be retried.");
  const updated = await processItem(c.env, user.id, row.id);
  if (updated.status === "failed" && updated.attempts >= 5) {
    throw new ApiError(409, "retry_exhausted", "This item failed too many times. Delete it and save the link again.");
  }
  return c.json({ item: await publicItem(c.env.DB, user.id, updated) });
});
