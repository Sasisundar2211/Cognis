import type { AuthUser, Env } from "../env";
import { ApiError } from "../lib/errors";
import { PLAN_LIMITS } from "../lib/plans";
import { newId, normalizeText, nowIso, sha256Hex } from "../lib/util";
import { assertFetchableUrl, canonicalizeUrl, detectPlatform, UnsafeUrlError } from "../ingest/url-safety";
import { FetchError, safeFetch } from "../ingest/fetch";
import { extractFromHtml, extractFromPlainText } from "../ingest/extract";
import { embeddingText, getEmbedder, toBlob } from "../retrieval/embed";

export const LIMITS = {
  title: 300,
  content: 100_000,
  description: 1000,
  tagName: 32,
  tagsPerItem: 20,
  maxAttempts: 5,
} as const;

export type ItemRow = {
  seq: number;
  id: string;
  user_id: string;
  kind: "url" | "text" | "note" | "capture";
  title: string;
  original_url: string | null;
  canonical_url: string | null;
  source_platform: string;
  description: string;
  content: string;
  extracted_text: string;
  content_hash: string | null;
  metadata: string;
  status: "pending" | "processing" | "ready" | "failed";
  error_code: string | null;
  attempts: number;
  archived: number;
  embedding_model: string | null;
  created_at: string;
  updated_at: string;
  ingested_at: string | null;
};

const ITEM_COLUMNS =
  "seq, id, user_id, kind, title, original_url, canonical_url, source_platform, description, content, extracted_text, content_hash, metadata, status, error_code, attempts, archived, embedding_model, created_at, updated_at, ingested_at";

export type PublicItem = ReturnType<typeof toPublic>;

export function toPublic(row: ItemRow, tags: string[] = [], collections: string[] = []) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    originalUrl: row.original_url,
    sourcePlatform: row.source_platform,
    description: row.description,
    content: row.content,
    extractedText: row.extracted_text,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    status: row.status,
    errorCode: row.error_code,
    archived: row.archived === 1,
    hasEmbedding: row.embedding_model !== null,
    tags,
    collections,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ingestedAt: row.ingested_at,
  };
}

/** Every read is scoped by user_id. There is no code path that loads an item by id alone. */
export async function getOwnedItem(db: D1Database, userId: string, id: string): Promise<ItemRow> {
  const row = await db
    .prepare(`SELECT ${ITEM_COLUMNS} FROM knowledge_items WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<ItemRow>();
  if (!row) throw new ApiError(404, "not_found", "Item not found.");
  return row;
}

export async function loadRelations(db: D1Database, userId: string, ids: string[]) {
  const tags = new Map<string, string[]>();
  const cols = new Map<string, string[]>();
  if (ids.length === 0) return { tags, cols };
  const ph = ids.map(() => "?").join(",");
  const [t, c] = await db.batch([
    db
      .prepare(`SELECT it.item_id AS item_id, t.name AS name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.user_id = ? AND it.item_id IN (${ph}) ORDER BY t.name`)
      .bind(userId, ...ids),
    db.prepare(`SELECT item_id, collection_id FROM collection_items WHERE user_id = ? AND item_id IN (${ph})`).bind(userId, ...ids),
  ]);
  for (const r of (t!.results as { item_id: string; name: string }[])) tags.set(r.item_id, [...(tags.get(r.item_id) ?? []), r.name]);
  for (const r of (c!.results as { item_id: string; collection_id: string }[]))
    cols.set(r.item_id, [...(cols.get(r.item_id) ?? []), r.collection_id]);
  return { tags, cols };
}

export async function publicItem(db: D1Database, userId: string, row: ItemRow) {
  const { tags, cols } = await loadRelations(db, userId, [row.id]);
  return toPublic(row, tags.get(row.id) ?? [], cols.get(row.id) ?? []);
}

export function normalizeTags(input: string[]): string[] {
  const out = new Set<string>();
  for (const raw of input) {
    const t = normalizeText(raw, LIMITS.tagName).toLowerCase().replace(/\s+/g, "-");
    if (t) out.add(t);
  }
  if (out.size > LIMITS.tagsPerItem) throw new ApiError(422, "too_many_tags", `An item can have at most ${LIMITS.tagsPerItem} tags.`);
  return [...out];
}

export async function setItemTags(db: D1Database, userId: string, itemId: string, names: string[]) {
  const tags = normalizeTags(names);
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [db.prepare("DELETE FROM item_tags WHERE user_id = ? AND item_id = ?").bind(userId, itemId)];
  for (const name of tags) {
    stmts.push(db.prepare("INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, name) DO NOTHING").bind(newId("tag"), userId, name, now));
    stmts.push(
      db
        .prepare("INSERT INTO item_tags (user_id, item_id, tag_id) SELECT ?, ?, id FROM tags WHERE user_id = ? AND name = ?")
        .bind(userId, itemId, userId, name),
    );
  }
  // Remove tags no longer used by any item, so deleted knowledge does not leave labels behind.
  stmts.push(db.prepare("DELETE FROM tags WHERE user_id = ? AND id NOT IN (SELECT tag_id FROM item_tags WHERE user_id = ?)").bind(userId, userId));
  await db.batch(stmts);
}

async function assertCapacity(db: D1Database, user: AuthUser, kind: string) {
  const limits = PLAN_LIMITS[user.plan] ?? PLAN_LIMITS.free;
  const total = await db.prepare("SELECT COUNT(*) AS n FROM knowledge_items WHERE user_id = ?").bind(user.id).first<{ n: number }>();
  if ((total?.n ?? 0) >= limits.maxItems) {
    throw new ApiError(403, "plan_limit_items", `Your plan stores up to ${limits.maxItems} items. Delete items or upgrade.`);
  }
  if (kind === "url") {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const today = await db
      .prepare("SELECT COUNT(*) AS n FROM knowledge_items WHERE user_id = ? AND kind = 'url' AND created_at >= ?")
      .bind(user.id, since)
      .first<{ n: number }>();
    if ((today?.n ?? 0) >= limits.maxUrlIngestPerDay) {
      throw new ApiError(429, "plan_limit_url_daily", `Your plan imports up to ${limits.maxUrlIngestPerDay} links per day.`);
    }
  }
}

export type CreateInput =
  | { kind: "url"; url: string; title?: string; note?: string; tags?: string[] }
  | { kind: "text" | "note" | "capture"; content: string; title?: string; sourceUrl?: string; tags?: string[] };

export type CreateResult = { row: ItemRow; duplicate: boolean; needsProcessing: boolean };

function isUniqueViolation(e: unknown) {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

export async function createItem(env: Env, user: AuthUser, input: CreateInput): Promise<CreateResult> {
  const db = env.DB;
  const now = nowIso();
  const id = newId("ki");

  if (input.kind === "url") {
    let url: URL;
    try {
      url = assertFetchableUrl(input.url);
    } catch (e) {
      throw new ApiError(422, "invalid_url", "Enter a public http or https link.", { reason: e instanceof UnsafeUrlError ? e.reason : "invalid_url" });
    }
    const canonical = canonicalizeUrl(url);
    const existing = await db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM knowledge_items WHERE user_id = ? AND canonical_url = ?`)
      .bind(user.id, canonical)
      .first<ItemRow>();
    if (existing) return { row: existing, duplicate: true, needsProcessing: false };
    await assertCapacity(db, user, "url");
    try {
      await db
        .prepare(
          `INSERT INTO knowledge_items (id, user_id, kind, title, original_url, canonical_url, source_platform, content, status, created_at, updated_at)
           VALUES (?, ?, 'url', ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .bind(id, user.id, normalizeText(input.title ?? "", LIMITS.title), url.toString(), canonical, detectPlatform(url), normalizeText(input.note ?? "", LIMITS.content), now, now)
        .run();
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const row = await db.prepare(`SELECT ${ITEM_COLUMNS} FROM knowledge_items WHERE user_id = ? AND canonical_url = ?`).bind(user.id, canonical).first<ItemRow>();
      return { row: row!, duplicate: true, needsProcessing: false };
    }
    if (input.tags?.length) await setItemTags(db, user.id, id, input.tags);
    return { row: await getOwnedItem(db, user.id, id), duplicate: false, needsProcessing: true };
  }

  const content = normalizeText(input.content, LIMITS.content);
  if (!content) throw new ApiError(422, "empty_content", "Add some text before saving.");
  let sourceUrl: string | null = null;
  let platform = input.kind === "capture" ? "browser" : "manual";
  if (input.sourceUrl) {
    try {
      const u = assertFetchableUrl(input.sourceUrl);
      sourceUrl = u.toString();
      platform = detectPlatform(u);
    } catch {
      sourceUrl = null; // provenance link is optional; an unsafe one is dropped, not stored
    }
  }
  const hash = await sha256Hex(`${input.kind}\n${sourceUrl ?? ""}\n${content}`);
  const existing = await db
    .prepare(`SELECT ${ITEM_COLUMNS} FROM knowledge_items WHERE user_id = ? AND canonical_url IS NULL AND content_hash = ?`)
    .bind(user.id, hash)
    .first<ItemRow>();
  if (existing) return { row: existing, duplicate: true, needsProcessing: false };
  await assertCapacity(db, user, input.kind);
  const title = normalizeText(input.title || content.split("\n", 1)[0]!, LIMITS.title);
  try {
    await db
      .prepare(
        `INSERT INTO knowledge_items (id, user_id, kind, title, original_url, source_platform, content, content_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(id, user.id, input.kind, title, sourceUrl, platform, content, hash, now, now)
      .run();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const row = await db.prepare(`SELECT ${ITEM_COLUMNS} FROM knowledge_items WHERE user_id = ? AND content_hash = ?`).bind(user.id, hash).first<ItemRow>();
    return { row: row!, duplicate: true, needsProcessing: false };
  }
  if (input.tags?.length) await setItemTags(db, user.id, id, input.tags);
  return { row: await getOwnedItem(db, user.id, id), duplicate: false, needsProcessing: true };
}

/**
 * Processing pipeline: fetch (URL items) -> extract -> embed -> mark ready.
 * Failures are recorded with a stable error code and can be retried.
 * Embedding failure is not fatal: the item stays searchable lexically.
 */
export async function processItem(env: Env, userId: string, itemId: string, fetcher: typeof fetch = fetch): Promise<ItemRow> {
  const db = env.DB;
  const claimed = await db
    .prepare(
      `UPDATE knowledge_items SET status = 'processing', attempts = attempts + 1, error_code = NULL, updated_at = ?
       WHERE id = ? AND user_id = ? AND attempts < ?
       AND (status IN ('pending','failed') OR (status = 'processing' AND updated_at < ?))`,
    )
    // A 'processing' row older than 5 minutes is treated as abandoned (the request that owned it died).
    .bind(nowIso(), itemId, userId, LIMITS.maxAttempts, new Date(Date.now() - 300_000).toISOString())
    .run();
  if (!claimed.meta.changes) return getOwnedItem(db, userId, itemId);
  const row = await getOwnedItem(db, userId, itemId);

  let title = row.title;
  let description = row.description;
  let extracted = row.extracted_text;
  let metadata = JSON.parse(row.metadata) as Record<string, unknown>;

  if (row.kind === "url" && row.original_url) {
    try {
      const page = await safeFetch(new URL(row.original_url), fetcher);
      const ex = page.contentType === "text/plain" ? extractFromPlainText(page.body) : await extractFromHtml(page.body);
      title = title || ex.title || page.finalUrl.hostname;
      description = ex.description;
      extracted = ex.text;
      metadata = { ...metadata, siteName: ex.siteName || undefined, finalUrl: page.finalUrl.toString(), contentType: page.contentType };
    } catch (e) {
      const code = e instanceof FetchError ? e.code : "extract_failed";
      await db
        .prepare("UPDATE knowledge_items SET status = 'failed', error_code = ?, title = CASE WHEN title = '' THEN ? ELSE title END, updated_at = ? WHERE id = ? AND user_id = ?")
        .bind(code, new URL(row.original_url).hostname, nowIso(), itemId, userId)
        .run();
      return getOwnedItem(db, userId, itemId);
    }
  }

  let blob: Uint8Array | null = null;
  let model: string | null = null;
  const embedder = getEmbedder(env);
  if (embedder) {
    try {
      const [v] = await embedder.embed([embeddingText({ title, description, content: row.content, extracted_text: extracted })]);
      if (v) {
        blob = toBlob(v);
        model = embedder.model;
      }
    } catch {
      metadata = { ...metadata, embeddingError: true };
    }
  }

  const now = nowIso();
  await db
    .prepare(
      `UPDATE knowledge_items SET title = ?, description = ?, extracted_text = ?, metadata = ?, embedding = ?, embedding_model = ?,
       status = 'ready', error_code = NULL, ingested_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    )
    .bind(title, description, extracted, JSON.stringify(metadata), blob, model, now, now, itemId, userId)
    .run();
  return getOwnedItem(db, userId, itemId);
}

export async function updateItem(env: Env, userId: string, id: string, patch: { title?: string; content?: string; description?: string; archived?: boolean; tags?: string[] }) {
  const db = env.DB;
  const row = await getOwnedItem(db, userId, id);
  const title = patch.title !== undefined ? normalizeText(patch.title, LIMITS.title) : row.title;
  const content = patch.content !== undefined ? normalizeText(patch.content, LIMITS.content) : row.content;
  const description = patch.description !== undefined ? normalizeText(patch.description, LIMITS.description) : row.description;
  const archived = patch.archived !== undefined ? (patch.archived ? 1 : 0) : row.archived;
  const textChanged = title !== row.title || content !== row.content || description !== row.description;

  let blob: Uint8Array | null | undefined;
  let model: string | null | undefined;
  if (textChanged) {
    const embedder = getEmbedder(env);
    blob = null;
    model = null;
    if (embedder) {
      try {
        const [v] = await embedder.embed([embeddingText({ title, description, content, extracted_text: row.extracted_text })]);
        if (v) {
          blob = toBlob(v);
          model = embedder.model;
        }
      } catch {
        /* keep lexical-only */
      }
    }
  }
  const now = nowIso();
  if (textChanged) {
    await db
      .prepare("UPDATE knowledge_items SET title = ?, content = ?, description = ?, archived = ?, embedding = ?, embedding_model = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(title, content, description, archived, blob ?? null, model ?? null, now, id, userId)
      .run();
  } else {
    await db.prepare("UPDATE knowledge_items SET archived = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(archived, now, id, userId).run();
  }
  if (patch.tags) await setItemTags(db, userId, id, patch.tags);
  return getOwnedItem(db, userId, id);
}

export async function deleteItem(db: D1Database, userId: string, id: string) {
  const res = await db.prepare("DELETE FROM knowledge_items WHERE id = ? AND user_id = ?").bind(id, userId).run();
  if (!res.meta.changes) throw new ApiError(404, "not_found", "Item not found.");
  await db.prepare("DELETE FROM tags WHERE user_id = ? AND id NOT IN (SELECT tag_id FROM item_tags WHERE user_id = ?)").bind(userId, userId).run();
}

export { ITEM_COLUMNS };
