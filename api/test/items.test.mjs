import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, call, createText, newUser } from "./helpers.mjs";

test("create, read, edit, tag, archive, delete", async () => {
  const { cookie } = await newUser("crud");
  const { res, body } = await createText(cookie, "First line title\nBody about distribution channels", { tags: ["Marketing", "marketing", "growth ideas"] });
  assert.equal(res.status, 201);
  assert.equal(body.item.status, "ready");
  assert.deepEqual(body.item.tags.sort(), ["growth-ideas", "marketing"]);
  const id = body.item.id;
  const got = await (await call(`/api/v1/items/${id}`, { cookie })).json();
  assert.equal(got.item.title, "First line title");
  assert.equal(got.item.hasEmbedding, true);
  const patched = await (await call(`/api/v1/items/${id}`, { method: "PATCH", cookie, json: { title: "Renamed", tags: ["seo"] } })).json();
  assert.equal(patched.item.title, "Renamed");
  assert.deepEqual(patched.item.tags, ["seo"]);
  assert.deepEqual((await (await call("/api/v1/tags", { cookie })).json()).tags.map((t) => t.name), ["seo"], "unused tags pruned");
  await call(`/api/v1/items/${id}`, { method: "PATCH", cookie, json: { archived: true } });
  assert.equal((await (await call("/api/v1/items", { cookie })).json()).items.length, 0);
  assert.equal((await (await call("/api/v1/items?archived=true", { cookie })).json()).items.length, 1);
  assert.equal((await call(`/api/v1/items/${id}`, { method: "DELETE", cookie })).status, 204);
  assert.equal((await call(`/api/v1/items/${id}`, { cookie })).status, 404);
});

test("duplicates are detected idempotently", async () => {
  const { cookie } = await newUser("dup");
  const one = await createText(cookie, "Same   content\n\n\n\nhere");
  const two = await createText(cookie, "Same content\n\nhere");
  assert.equal(one.res.status, 201);
  assert.equal(two.res.status, 200);
  assert.equal(two.body.duplicate, true);
  assert.equal(two.body.item.id, one.body.item.id);
});

test("stable cursor pagination", async () => {
  const { cookie } = await newUser("page");
  for (let i = 0; i < 5; i++) await createText(cookie, `pagination note number ${i}`);
  const p1 = await (await call("/api/v1/items?limit=2", { cookie })).json();
  const p2 = await (await call(`/api/v1/items?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`, { cookie })).json();
  const p3 = await (await call(`/api/v1/items?limit=2&cursor=${encodeURIComponent(p2.nextCursor)}`, { cookie })).json();
  assert.equal(new Set([...p1.items, ...p2.items, ...p3.items].map((i) => i.id)).size, 5);
  assert.equal(p3.nextCursor, null);
});

test("invalid input gives structured errors without internals", async () => {
  const { cookie } = await newUser("val");
  const cases = [
    { kind: "text" }, { kind: "text", content: "" }, { kind: "text", content: "   \n\t " }, { kind: "bogus", content: "x" },
    { kind: "text", content: "x", extra: "smuggled" }, { kind: "url", url: "javascript:alert(1)" }, { kind: "url", url: "http://127.0.0.1/admin" },
    { kind: "url", url: "http://169.254.169.254/latest/meta-data" }, { kind: "url", url: "file:///etc/passwd" }, [1, 2, 3],
    { kind: "text", content: "x", tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, { kind: "url", url: "https://example.com", content: "smuggle" },
  ];
  for (const json of cases) {
    const res = await call("/api/v1/items", { method: "POST", cookie, json });
    assert.equal(res.status, 422, JSON.stringify(json));
    const b = await res.json();
    assert.ok(b.error.code && b.error.requestId);
    assert.doesNotMatch(JSON.stringify(b), /sqlite|D1_|panicked|stack|\.rs:/i);
  }
  const bad = await call("/api/v1/items", { method: "POST", cookie, headers: { "Content-Type": "application/json" }, body: "{not json" });
  assert.equal(bad.status, 400);
  assert.equal((await call("/api/v1/items/not-an-id", { cookie })).status, 404);
  assert.equal((await call("/api/v1/items?limit=100000", { cookie })).status, 422);
  assert.equal((await call("/api/v1/items?from=yesterday", { cookie })).status, 422);
  assert.equal((await call("/api/v1/items?cursor=garbage", { cookie })).status, 422);
});

test("oversized body is rejected before parsing", async () => {
  const { cookie } = await newUser("big");
  const res = await call("/api/v1/items", { method: "POST", cookie, json: { kind: "text", content: "a".repeat(300_000) } });
  assert.equal(res.status, 413);
});

test("CSRF: foreign origin, non-JSON body, cross-site fetch are blocked for cookie sessions", async () => {
  const { cookie } = await newUser("csrf");
  const evil = await fetch(BASE + "/api/v1/items", { method: "POST", headers: { Origin: "https://evil.example", Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "text", content: "csrf" }) });
  assert.equal(evil.status, 403);
  const plain = await fetch(BASE + "/api/v1/items", { method: "POST", headers: { Cookie: cookie, "Content-Type": "text/plain" }, body: JSON.stringify({ kind: "text", content: "csrf" }) });
  assert.equal(plain.status, 415);
  const site = await fetch(BASE + "/api/v1/items/ki_00000000000000000000000000000000", { method: "DELETE", headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" } });
  assert.equal(site.status, 403);
});

test("control and bidi characters are stripped", async () => {
  const { cookie } = await newUser("ctl");
  const { body } = await createText(cookie, "safe\u0000text‮with​hidden\u0002marks");
  assert.equal(body.item.content, "safetextwithhiddenmarks");
});

test("unsafe source links on notes are dropped, safe ones kept with platform", async () => {
  const { cookie } = await newUser("prov");
  const a = await createText(cookie, "from reddit", { kind: "capture", sourceUrl: "https://www.reddit.com/r/startups/x" });
  assert.equal(a.body.item.sourcePlatform, "reddit");
  assert.equal(a.body.item.originalUrl, "https://www.reddit.com/r/startups/x");
  const b = await createText(cookie, "from localhost", { kind: "capture", sourceUrl: "http://127.0.0.1/" });
  assert.equal(b.body.item.originalUrl, null);
  assert.equal(b.body.item.sourcePlatform, "browser");
});

test("URL items: unsafe rejected, safe ones queued and leave pending", async () => {
  const { cookie } = await newUser("url");
  const r = await call("/api/v1/items", { method: "POST", cookie, json: { kind: "url", url: "https://site.invalid/" } });
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error.details.reason, "internal_host");
  const ok = await call("/api/v1/items", { method: "POST", cookie, json: { kind: "url", url: "https://example.com/?utm_source=x", note: "test link" } });
  assert.equal(ok.status, 201);
  const id = (await ok.json()).item.id;
  const dup = await call("/api/v1/items", { method: "POST", cookie, json: { kind: "url", url: "https://www.example.com/" } });
  assert.equal((await dup.json()).duplicate, true);
  let item;
  for (let i = 0; i < 40; i++) {
    item = (await (await call(`/api/v1/items/${id}`, { cookie })).json()).item;
    if (item.status === "ready" || item.status === "failed") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  // Network access depends on the environment; either outcome is valid, but never stuck or internal.
  assert.ok(["ready", "failed"].includes(item.status), item.status);
  if (item.status === "failed") assert.match(item.errorCode, /^(fetch_|http_|redirect_|unsupported_|too_)/);
  if (item.status === "ready") assert.ok(item.extractedText.length > 0);
});

test("collections: create, assign, filter, remove, delete keeps items", async () => {
  const { cookie } = await newUser("col");
  const col = (await (await call("/api/v1/collections", { method: "POST", cookie, json: { name: "Launch" } })).json()).collection.id;
  assert.equal((await call("/api/v1/collections", { method: "POST", cookie, json: { name: "Launch" } })).status, 409);
  const i1 = (await createText(cookie, "in the collection")).body.item.id;
  await createText(cookie, "not in the collection");
  assert.equal((await call(`/api/v1/collections/${col}/items/${i1}`, { method: "PUT", cookie })).status, 204);
  assert.deepEqual((await (await call(`/api/v1/items?collection=${col}`, { cookie })).json()).items.map((i) => i.id), [i1]);
  assert.equal((await (await call("/api/v1/collections", { cookie })).json()).collections[0].itemCount, 1);
  const renamed = await (await call(`/api/v1/collections/${col}`, { method: "PATCH", cookie, json: { name: "Launch plan" } })).json();
  assert.equal(renamed.collection.name, "Launch plan");
  assert.equal((await call(`/api/v1/collections/${col}/items/${i1}`, { method: "DELETE", cookie })).status, 204);
  assert.equal((await call(`/api/v1/collections/${col}`, { method: "DELETE", cookie })).status, 204);
  assert.equal((await call(`/api/v1/items/${i1}`, { cookie })).status, 200);
});
