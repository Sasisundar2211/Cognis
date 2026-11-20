import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { ftsQuery, queryTerms, rrf, search } from "../src/retrieval/search";
import { call, createText, newUser } from "./helpers";

type SearchBody = { results: { item: { id: string; title: string }; reason: string; snippet: string }[]; total: number; mode: string; degraded: boolean };

describe("query handling", () => {
  it("turns any input into quoted FTS terms so FTS syntax is inert", () => {
    expect(queryTerms('title:secret OR "x" NEAR(a b) * -- ; DROP TABLE')).toEqual(["title", "secret", "x", "near", "b", "drop", "table"]);
    expect(ftsQuery(["a1", "b"])).toBe('"a1" OR "b"');
    expect(queryTerms("the a of")).toEqual([]);
  });

  it("computes RRF with k=60", () => {
    const s = rrf([["a", "b"], ["b", "c"]]);
    expect(s.get("b")).toBeCloseTo(1 / 62 + 1 / 61);
    expect(s.get("a")).toBeCloseTo(1 / 61);
    expect([...s.entries()].sort((x, y) => y[1] - x[1])[0]![0]).toBe("b");
  });
});

describe("search API", () => {
  let cookie: string;
  let ids: Record<string, string>;

  beforeAll(async () => {
    cookie = (await newUser("search")).cookie;
    ids = {};
    const docs: [string, string, string[]][] = [
      ["reddit", "Reddit marketing strategy\nPost in niche subreddits, answer questions, share launch lessons.", ["marketing"]],
      ["linkedin", "LinkedIn positioning post\nState who you serve and the problem you solve in one sentence.", ["positioning"]],
      ["reel", "Instagram reel on content distribution\nRepurpose one long video into ten short clips.", ["marketing"]],
      ["recipe", "Banana bread recipe\nThree ripe bananas, flour, butter, bake for 60 minutes.", ["food"]],
    ];
    for (const [key, content, tags] of docs) ids[key] = (await createText(cookie, content, { tags })).body.item.id;
  });

  it("finds relevant items lexically with real evidence in the explanation", async () => {
    const r = (await (await call("/api/v1/search?q=reddit+marketing&mode=lexical", { cookie })).json()) as SearchBody;
    expect(r.results[0]!.item.id).toBe(ids.reddit);
    expect(r.results[0]!.reason).toMatch(/Contains/);
    expect(r.results.map((x) => x.item.id)).not.toContain(ids.recipe);
  });

  it("hybrid mode fuses lexical and semantic results", async () => {
    const r = (await (await call("/api/v1/search?q=marketing+strategy+for+subreddits", { cookie })).json()) as SearchBody;
    expect(r.mode).toBe("hybrid");
    expect(r.degraded).toBe(false);
    expect(r.results[0]!.item.id).toBe(ids.reddit);
  });

  it("semantic mode returns results without exact word matches being required", async () => {
    const r = (await (await call("/api/v1/search?q=subreddit&mode=semantic", { cookie })).json()) as SearchBody;
    expect(r.mode).toBe("semantic");
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0]!.reason).toMatch(/meaning/);
  });

  it("applies tag and source filters", async () => {
    const r = (await (await call("/api/v1/search?q=marketing+distribution+reddit&tag=marketing", { cookie })).json()) as SearchBody;
    const got = new Set(r.results.map((x) => x.item.id));
    expect(got.has(ids.linkedin!)).toBe(false);
    expect(got.has(ids.recipe!)).toBe(false);
    const none = (await (await call("/api/v1/search?q=reddit&source=github", { cookie })).json()) as SearchBody;
    expect(none.results).toHaveLength(0);
  });

  it("paginates fused results", async () => {
    const all = (await (await call("/api/v1/search?q=marketing+positioning+distribution+recipe&limit=50", { cookie })).json()) as SearchBody;
    const p1 = (await (await call("/api/v1/search?q=marketing+positioning+distribution+recipe&limit=2", { cookie })).json()) as SearchBody;
    const p2 = (await (await call("/api/v1/search?q=marketing+positioning+distribution+recipe&limit=2&offset=2", { cookie })).json()) as SearchBody;
    expect([...p1.results, ...p2.results].map((x) => x.item.id)).toEqual(all.results.slice(0, 4).map((x) => x.item.id));
  });

  it("survives hostile queries", async () => {
    for (const q of ['"', "*", "NEAR(", "title:x", "a".repeat(500), "😀 ∑ 日本語", "' OR 1=1 --"]) {
      const res = await call(`/api/v1/search?q=${encodeURIComponent(q)}`, { cookie });
      expect(res.status, q).toBe(200);
    }
    expect((await call(`/api/v1/search?q=${"a".repeat(501)}`, { cookie })).status).toBe(422);
    expect((await call("/api/v1/search?q=", { cookie })).status).toBe(422);
  });

  it("falls back to lexical and reports degraded mode when embeddings are unavailable", async () => {
    const me = (await (await call("/api/v1/me", { cookie })).json()) as { user: { id: string } };
    const res = await search({ db: env.DB, embedder: null, userId: me.user.id, query: "reddit marketing", mode: "hybrid", filters: {}, limit: 10, offset: 0 });
    expect(res.degraded).toBe(true);
    expect(res.modeUsed).toBe("lexical");
    expect(res.hits[0]!.id).toBe(ids.reddit);
    const failing = { model: "x", minSimilarity: 0.5, embed: async () => { throw new Error("down"); } };
    const res2 = await search({ db: env.DB, embedder: failing, userId: me.user.id, query: "reddit", mode: "semantic", filters: {}, limit: 10, offset: 0 });
    expect(res2.degraded).toBe(true);
    expect(res2.hits.length).toBeGreaterThan(0);
  });

  it("keeps the FTS index in sync on edit and delete", async () => {
    const id = (await createText(cookie, "zebra migration notes")).body.item.id;
    await call(`/api/v1/items/${id}`, { method: "PATCH", cookie, json: { content: "giraffe feeding notes", title: "giraffe" } });
    const old = (await (await call("/api/v1/search?q=zebra&mode=lexical", { cookie })).json()) as SearchBody;
    expect(old.results).toHaveLength(0);
    const fresh = (await (await call("/api/v1/search?q=giraffe&mode=lexical", { cookie })).json()) as SearchBody;
    expect(fresh.results[0]!.item.id).toBe(id);
    await call(`/api/v1/items/${id}`, { method: "DELETE", cookie });
    const gone = (await (await call("/api/v1/search?q=giraffe&mode=lexical", { cookie })).json()) as SearchBody;
    expect(gone.results).toHaveLength(0);
  });
});
