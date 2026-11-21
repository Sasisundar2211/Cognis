import { before, test } from "node:test";
import assert from "node:assert/strict";
import { call, createText, newUser } from "./helpers.mjs";

let cookie;
const ids = {};

before(async () => {
  cookie = (await newUser("search")).cookie;
  const docs = [
    ["reddit", "Reddit marketing strategy\nPost in niche subreddits, answer questions, share launch lessons.", ["marketing"]],
    ["linkedin", "LinkedIn positioning post\nState who you serve and the problem you solve in one sentence.", ["positioning"]],
    ["reel", "Instagram reel on content distribution\nRepurpose one long video into ten short clips.", ["marketing"]],
    ["recipe", "Banana bread recipe\nThree ripe bananas, flour, butter, bake for 60 minutes.", ["food"]],
  ];
  for (const [k, content, tags] of docs) ids[k] = (await createText(cookie, content, { tags })).body.item.id;
});

const get = async (q) => (await call(`/api/v1/search?${q}`, { cookie })).json();

test("lexical search with evidence-based reasons", async () => {
  const r = await get("q=reddit+marketing&mode=lexical");
  assert.equal(r.results[0].item.id, ids.reddit);
  assert.match(r.results[0].reason, /^Contains "/);
  assert.match(r.results[0].snippet, /\u0002/);
  assert.ok(!r.results.some((x) => x.item.id === ids.recipe));
});

test("hybrid fuses lexical and semantic", async () => {
  const r = await get("q=marketing+strategy+for+subreddits");
  assert.equal(r.mode, "hybrid");
  assert.equal(r.degraded, false);
  assert.equal(r.results[0].item.id, ids.reddit);
  assert.match(r.results[0].reason, /close in meaning/);
});

test("semantic mode", async () => {
  const r = await get("q=subreddit&mode=semantic");
  assert.equal(r.mode, "semantic");
  assert.ok(r.results.length > 0);
  assert.match(r.results[0].reason, /meaning/);
});

test("tag and source filters", async () => {
  const r = await get("q=marketing+distribution+reddit&tag=marketing");
  const got = new Set(r.results.map((x) => x.item.id));
  assert.ok(!got.has(ids.linkedin) && !got.has(ids.recipe));
  assert.equal((await get("q=reddit&source=github")).results.length, 0);
});

test("fused pagination is consistent", async () => {
  const q = "q=marketing+positioning+distribution+recipe";
  const all = await get(`${q}&limit=50`);
  const p1 = await get(`${q}&limit=2`);
  const p2 = await get(`${q}&limit=2&offset=2`);
  assert.deepEqual([...p1.results, ...p2.results].map((x) => x.item.id), all.results.slice(0, 4).map((x) => x.item.id));
});

test("hostile queries never error; limits enforced", async () => {
  for (const q of ['"', "*", "NEAR(", "title:x", "a".repeat(500), "😀 ∑ 日本語", "' OR 1=1 --", "\u0002\u0003"]) {
    assert.equal((await call(`/api/v1/search?q=${encodeURIComponent(q)}`, { cookie })).status, 200, q);
  }
  assert.equal((await call(`/api/v1/search?q=${"a".repeat(501)}`, { cookie })).status, 422);
  assert.equal((await call("/api/v1/search?q=", { cookie })).status, 422);
  assert.equal((await call("/api/v1/search?q=x&mode=magic", { cookie })).status, 422);
});

test("FTS index stays in sync on edit and delete", async () => {
  const id = (await createText(cookie, "zebra migration notes")).body.item.id;
  await call(`/api/v1/items/${id}`, { method: "PATCH", cookie, json: { content: "giraffe feeding notes", title: "giraffe" } });
  assert.equal((await get("q=zebra&mode=lexical")).results.length, 0);
  assert.equal((await get("q=giraffe&mode=lexical")).results[0].item.id, id);
  await call(`/api/v1/items/${id}`, { method: "DELETE", cookie });
  assert.equal((await get("q=giraffe&mode=lexical")).results.length, 0);
});

test("ask: without a language model returns cited-ready sources and says so", async () => {
  const r = await (await call("/api/v1/ask", { method: "POST", cookie, json: { question: "how should I market on reddit?", stream: false } })).json();
  assert.equal(r.answer, null);
  assert.equal(r.degraded, true);
  assert.equal(r.sources[0].item.id, ids.reddit);
  assert.equal(r.sources[0].n, 1);
});

test("ask: streaming emits status, sources and done events", async () => {
  const res = await call("/api/v1/ask", { method: "POST", cookie, json: { question: "positioning advice", context: { selectedText: "who do we serve?", appName: "Notes" } } });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const text = await res.text();
  const events = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
  assert.deepEqual(events, ["status", "sources", "done"]);
  assert.match(text, new RegExp(ids.linkedin));
});

test("ask: validation", async () => {
  assert.equal((await call("/api/v1/ask", { method: "POST", cookie, json: { question: "" } })).status, 422);
  assert.equal((await call("/api/v1/ask", { method: "POST", cookie, json: { question: "x", context: { cookies: "steal" } } })).status, 422);
  assert.equal((await call("/api/v1/ask", { method: "POST", cookie, json: { question: "x", history: Array.from({ length: 21 }, () => ({ role: "user", content: "a" })) } })).status, 422);
});
