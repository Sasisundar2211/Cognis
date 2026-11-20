import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { idParam, parseQuery } from "../lib/validate";
import { getEmbedder } from "../retrieval/embed";
import { search } from "../retrieval/search";
import { ITEM_COLUMNS, loadRelations, toPublic, type ItemRow } from "../knowledge/service";

const isoDate = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date");

const searchQuery = z.object({
  q: z.string().trim().min(1).max(500),
  mode: z.enum(["hybrid", "lexical", "semantic"]).default("hybrid"),
  source: z.string().max(32).optional(),
  tag: z.string().max(64).optional(),
  collection: idParam.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(450).default(0),
});

/**
 * Plain-language reason a result matched. Built only from retrieval evidence
 * (which retriever found it and which terms matched), never invented.
 */
function explain(hit: { lexicalRank: number | null; semanticRank: number | null; matchedTerms: string[] }): string {
  const parts: string[] = [];
  if (hit.lexicalRank !== null && hit.matchedTerms.length) parts.push(`Contains ${hit.matchedTerms.map((t) => `"${t}"`).join(", ")}`);
  else if (hit.lexicalRank !== null) parts.push("Contains words from your search");
  if (hit.semanticRank !== null) parts.push(parts.length ? "and is close in meaning" : "Close in meaning to your search");
  return parts.join(" ");
}

export const searchRoute = new Hono<AppBindings>();

searchRoute.get("/", async (c) => {
  const user = c.get("user");
  const q = parseQuery(c, searchQuery);
  const started = Date.now();
  const result = await search({
    db: c.env.DB,
    embedder: getEmbedder(c.env),
    userId: user.id,
    query: q.q,
    mode: q.mode,
    filters: { source: q.source, tag: q.tag, collectionId: q.collection, from: q.from, to: q.to },
    limit: q.limit,
    offset: q.offset,
  });
  const ids = result.hits.map((h) => h.id);
  let rows: ItemRow[] = [];
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    rows = (await c.env.DB.prepare(`SELECT ${ITEM_COLUMNS} FROM knowledge_items WHERE user_id = ? AND id IN (${ph})`).bind(user.id, ...ids).all<ItemRow>()).results;
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const { tags, cols } = await loadRelations(c.env.DB, user.id, ids);
  console.log(JSON.stringify({ level: "info", requestId: c.get("requestId"), metric: "search", mode: result.modeUsed, degraded: result.degraded, hits: result.total, ms: Date.now() - started }));
  return c.json({
    results: result.hits
      .filter((h) => byId.has(h.id))
      .map((h) => ({
        item: toPublic(byId.get(h.id)!, tags.get(h.id) ?? [], cols.get(h.id) ?? []),
        snippet: h.snippet,
        reason: explain(h),
      })),
    total: result.total,
    mode: result.modeUsed,
    degraded: result.degraded,
  });
});
