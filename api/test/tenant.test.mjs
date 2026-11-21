import { before, test } from "node:test";
import assert from "node:assert/strict";
import { call, createText, newUser, PASSWORD } from "./helpers.mjs";

// User B must never read, change, search, list or link user A's data.
let a, b, itemA, colA, bToken;

before(async () => {
  a = await newUser("tenantA");
  b = await newUser("tenantB");
  itemA = (await createText(a.cookie, "Alpha confidential roadmap about kraken pricing", { tags: ["private-tag"] })).body.item.id;
  colA = (await (await call("/api/v1/collections", { method: "POST", cookie: a.cookie, json: { name: "A secrets" } })).json()).collection.id;
  await call(`/api/v1/collections/${colA}/items/${itemA}`, { method: "PUT", cookie: a.cookie });
  bToken = (await (await call("/api/auth/sign-in", { method: "POST", json: { email: b.email, password: PASSWORD, device: "B desktop" } })).json()).token;
});

test("B cannot read A's item by id (cookie or device token)", async () => {
  assert.equal((await call(`/api/v1/items/${itemA}`, { cookie: b.cookie })).status, 404);
  assert.equal((await call(`/api/v1/items/${itemA}`, { bearer: bToken })).status, 404);
});

test("B cannot update, delete or retry A's item", async () => {
  assert.equal((await call(`/api/v1/items/${itemA}`, { method: "PATCH", cookie: b.cookie, json: { title: "pwned" } })).status, 404);
  assert.equal((await call(`/api/v1/items/${itemA}`, { method: "DELETE", cookie: b.cookie })).status, 404);
  assert.equal((await call(`/api/v1/items/${itemA}/retry`, { method: "POST", cookie: b.cookie })).status, 404);
  const still = await (await call(`/api/v1/items/${itemA}`, { cookie: a.cookie })).json();
  assert.notEqual(still.item.title, "pwned");
});

test("B's search, ask, list, tags and sources never include A's data", async () => {
  for (const mode of ["lexical", "semantic", "hybrid"]) {
    const s = await (await call(`/api/v1/search?q=kraken+pricing&mode=${mode}`, { cookie: b.cookie })).json();
    assert.equal(s.results.length, 0, mode);
  }
  const ask = await (await call("/api/v1/ask", { method: "POST", bearer: bToken, json: { question: "what is the kraken pricing roadmap", stream: false } })).json();
  assert.equal(ask.sources.length, 0);
  assert.equal((await (await call("/api/v1/items", { cookie: b.cookie })).json()).items.length, 0);
  assert.equal((await (await call("/api/v1/items?tag=private-tag", { cookie: b.cookie })).json()).items.length, 0);
  assert.equal((await (await call("/api/v1/tags", { cookie: b.cookie })).json()).tags.length, 0);
  assert.equal((await (await call("/api/v1/sources", { cookie: b.cookie })).json()).sources.length, 0);
});

test("B cannot use A's collection id as a filter", async () => {
  assert.equal((await (await call(`/api/v1/items?collection=${colA}`, { cookie: b.cookie })).json()).items.length, 0);
  assert.equal((await (await call(`/api/v1/search?q=kraken&collection=${colA}`, { cookie: b.cookie })).json()).results.length, 0);
});

test("B cannot read, rename, delete or add to A's collection", async () => {
  assert.equal((await call(`/api/v1/collections/${colA}`, { cookie: b.cookie })).status, 404);
  assert.equal((await call(`/api/v1/collections/${colA}`, { method: "PATCH", cookie: b.cookie, json: { name: "x" } })).status, 404);
  assert.equal((await call(`/api/v1/collections/${colA}`, { method: "DELETE", cookie: b.cookie })).status, 404);
  const itemB = (await createText(b.cookie, "B owns this note")).body.item.id;
  assert.equal((await call(`/api/v1/collections/${colA}/items/${itemB}`, { method: "PUT", cookie: b.cookie })).status, 404);
});

test("B cannot put A's item into B's own collection", async () => {
  const colB = (await (await call("/api/v1/collections", { method: "POST", cookie: b.cookie, json: { name: "B col" } })).json()).collection.id;
  assert.equal((await call(`/api/v1/collections/${colB}/items/${itemA}`, { method: "PUT", cookie: b.cookie })).status, 404);
});

test("B cannot list or revoke A's sessions", async () => {
  const aSessions = (await (await call("/api/auth/sessions", { cookie: a.cookie })).json()).sessions;
  assert.equal((await call(`/api/auth/sessions/${aSessions[0].id}`, { method: "DELETE", cookie: b.cookie })).status, 404);
  assert.equal((await call("/api/v1/me", { cookie: a.cookie })).status, 200);
});

test("identical content from two users creates two items", async () => {
  const t = "Shared public quote that both users saved";
  const ra = await createText(a.cookie, t);
  const rb = await createText(b.cookie, t);
  assert.equal(ra.body.duplicate, false);
  assert.equal(rb.body.duplicate, false);
  assert.notEqual(ra.body.item.id, rb.body.item.id);
});

test("export contains only the caller's data", async () => {
  const ex = await (await call("/api/v1/export", { cookie: b.cookie })).json();
  assert.ok(!ex.items.some((i) => i.id === itemA));
  assert.ok(!ex.collections.some((c) => c.id === colA));
});
