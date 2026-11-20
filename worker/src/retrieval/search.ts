import type { Embedder } from "./embed";
import { dot, fromBlob } from "./embed";
import { buildFilterSql, type ItemFilters } from "./filters";

export type SearchMode = "hybrid" | "lexical" | "semantic";

export const RRF_K = 60;
const CANDIDATES = 50;
/** Max items scanned for brute-force semantic search per query (newest first). See docs/KNOWN-LIMITATIONS.md. */
export const SEMANTIC_SCAN_LIMIT = 2000;

/** Markers wrapping highlighted terms in snippets. Control chars are stripped on ingest, so they cannot occur in content. */
export const HL_START = "\u0002";
export const HL_END = "\u0003";

export type SearchHit = {
  id: string;
  score: number;
  lexicalRank: number | null;
  semanticRank: number | null;
  similarity: number | null;
  matchedTerms: string[];
  snippet: string;
};

export type SearchResult = {
  hits: SearchHit[];
  total: number;
  modeUsed: SearchMode;
  degraded: boolean;
};

const STOPWORDS = new Set(
  "a an and are as at be but by for from has have how i in is it its of on or that the this to was what when where which who why with you your".split(" "),
);

/** Tokenize a free-text query into safe FTS5 terms. Each term is quoted, so FTS operators in user input are inert. */
export function queryTerms(q: string): string[] {
  const raw = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    if (t.length > 40 || STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

export function ftsQuery(terms: string[]): string {
  return terms.map((t) => `"${t}"`).join(" OR ");
}

async function lexical(db: D1Database, userId: string, terms: string[], f: ItemFilters) {
  if (terms.length === 0) return [];
  const flt = buildFilterSql("k", f);
  const sql = `SELECT k.id AS id,
      bm25(knowledge_fts, 4.0, 2.0, 1.0, 1.0) AS score,
      snippet(knowledge_fts, -1, '${HL_START}', '${HL_END}', '…', 16) AS snippet
    FROM knowledge_fts JOIN knowledge_items k ON k.seq = knowledge_fts.rowid
    WHERE knowledge_fts MATCH ? AND k.user_id = ?${flt.sql}
    ORDER BY score LIMIT ${CANDIDATES}`;
  const { results } = await db.prepare(sql).bind(ftsQuery(terms), userId, ...flt.params).all<{ id: string; score: number; snippet: string }>();
  return results;
}

async function semantic(db: D1Database, userId: string, qv: Float32Array, minSim: number, f: ItemFilters) {
  const flt = buildFilterSql("k", f);
  const sql = `SELECT k.id AS id, k.embedding AS embedding FROM knowledge_items k
    WHERE k.user_id = ? AND k.embedding IS NOT NULL${flt.sql}
    ORDER BY k.created_at DESC LIMIT ${SEMANTIC_SCAN_LIMIT}`;
  const { results } = await db.prepare(sql).bind(userId, ...flt.params).all<{ id: string; embedding: unknown }>();
  const scored: { id: string; sim: number }[] = [];
  for (const r of results) {
    const v = fromBlob(r.embedding);
    if (!v) continue;
    const sim = dot(qv, v);
    if (sim >= minSim) scored.push({ id: r.id, sim });
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, CANDIDATES);
}

/** Reciprocal Rank Fusion. score(d) = sum over retrievers of 1 / (k + rank), rank starting at 1. */
export function rrf(lists: string[][], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return scores;
}

export async function search(opts: {
  db: D1Database;
  embedder: Embedder | null;
  userId: string;
  query: string;
  mode: SearchMode;
  filters: ItemFilters;
  limit: number;
  offset: number;
}): Promise<SearchResult> {
  const { db, userId, query, filters } = opts;
  const terms = queryTerms(query);
  let mode = opts.mode;
  let degraded = false;

  let qv: Float32Array | null = null;
  if (mode !== "lexical") {
    if (opts.embedder) {
      try {
        qv = (await opts.embedder.embed([query.slice(0, 1000)]))[0] ?? null;
      } catch {
        qv = null;
      }
    }
    if (!qv) {
      // Graceful fallback: semantic unavailable, answer lexically and say so.
      degraded = true;
      mode = "lexical";
    }
  }

  const lex = mode === "semantic" ? [] : await lexical(db, userId, terms, filters);
  const sem = mode === "lexical" || !qv ? [] : await semantic(db, userId, qv, opts.embedder?.minSimilarity ?? 0.45, filters);

  const lexIds = lex.map((r) => r.id);
  const semIds = sem.map((r) => r.id);
  const fused = rrf([lexIds, semIds]);
  const lexRank = new Map(lexIds.map((id, i) => [id, i + 1]));
  const semRank = new Map(semIds.map((id, i) => [id, i + 1]));
  const sim = new Map(sem.map((r) => [r.id, r.sim]));
  const snippets = new Map(lex.map((r) => [r.id, r.snippet]));

  const ordered = [...fused.entries()].sort((a, b) => b[1] - a[1]);
  const page = ordered.slice(opts.offset, opts.offset + opts.limit);

  const hits: SearchHit[] = page.map(([id, score]) => {
    const snippet = snippets.get(id) ?? "";
    const matched = new Set<string>();
    const re = new RegExp(`${HL_START}([^${HL_END}]*)${HL_END}`, "g");
    for (const m of snippet.matchAll(re)) matched.add(m[1]!.toLowerCase());
    return {
      id,
      score,
      lexicalRank: lexRank.get(id) ?? null,
      semanticRank: semRank.get(id) ?? null,
      similarity: sim.get(id) ?? null,
      matchedTerms: [...matched].slice(0, 6),
      snippet,
    };
  });

  return { hits, total: ordered.length, modeUsed: mode, degraded };
}
