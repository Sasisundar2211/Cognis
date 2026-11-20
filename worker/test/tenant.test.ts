import { beforeAll, describe, expect, it } from "vitest";
import { call, createText, newUser } from "./helpers";

/**
 * Cross-tenant isolation. User B must never read, change, search, list, or link
 * user A's data by guessing or replaying IDs, URLs or parameters.
 */
describe("tenant isolation", () => {
  let a: { cookie: string };
  let b: { cookie: string };
  let itemA: string;
  let colA: string;

  beforeAll(async () => {
    a = await newUser("tenantA");
    b = await newUser("tenantB");
    itemA = (await createText(a.cookie, "Alpha confidential roadmap about kraken pricing", { tags: ["private-tag"] })).body.item.id;
    const col = await call("/api/v1/collections", { method: "POST", cookie: a.cookie, json: { name: "A secrets" } });
    colA = ((await col.json()) as { collection: { id: string } }).collection.id;
    await call(`/api/v1/collections/${colA}/items/${itemA}`, { method: "PUT", cookie: a.cookie });
  });

  it("B cannot read A's item by id", async () => {
    expect((await call(`/api/v1/items/${itemA}`, { cookie: b.cookie })).status).toBe(404);
  });

  it("B cannot update, delete or retry A's item", async () => {
    expect((await call(`/api/v1/items/${itemA}`, { method: "PATCH", cookie: b.cookie, json: { title: "pwned" } })).status).toBe(404);
    expect((await call(`/api/v1/items/${itemA}`, { method: "DELETE", cookie: b.cookie })).status).toBe(404);
    expect((await call(`/api/v1/items/${itemA}/retry`, { method: "POST", cookie: b.cookie })).status).toBe(404);
    const stillThere = await call(`/api/v1/items/${itemA}`, { cookie: a.cookie });
    expect(stillThere.status).toBe(200);
    expect(((await stillThere.json()) as { item: { title: string } }).item.title).not.toBe("pwned");
  });

  it("B's search, list and tag views never include A's data", async () => {
    for (const mode of ["lexical", "semantic", "hybrid"]) {
      const s = (await (await call(`/api/v1/search?q=kraken+pricing&mode=${mode}`, { cookie: b.cookie })).json()) as { results: unknown[] };
      expect(s.results, mode).toHaveLength(0);
    }
    const list = (await (await call("/api/v1/items", { cookie: b.cookie })).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(0);
    const byTag = (await (await call("/api/v1/items?tag=private-tag", { cookie: b.cookie })).json()) as { items: unknown[] };
    expect(byTag.items).toHaveLength(0);
    const tags = (await (await call("/api/v1/tags", { cookie: b.cookie })).json()) as { tags: unknown[] };
    expect(tags.tags).toHaveLength(0);
  });

  it("B cannot filter by A's collection id to reveal A's items", async () => {
    const list = (await (await call(`/api/v1/items?collection=${colA}`, { cookie: b.cookie })).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(0);
    const s = (await (await call(`/api/v1/search?q=kraken&collection=${colA}`, { cookie: b.cookie })).json()) as { results: unknown[] };
    expect(s.results).toHaveLength(0);
  });

  it("B cannot read, rename, delete or add to A's collection", async () => {
    expect((await call(`/api/v1/collections/${colA}`, { cookie: b.cookie })).status).toBe(404);
    expect((await call(`/api/v1/collections/${colA}`, { method: "PATCH", cookie: b.cookie, json: { name: "x" } })).status).toBe(404);
    expect((await call(`/api/v1/collections/${colA}`, { method: "DELETE", cookie: b.cookie })).status).toBe(404);
    const itemB = (await createText(b.cookie, "B owns this note")).body.item.id;
    expect((await call(`/api/v1/collections/${colA}/items/${itemB}`, { method: "PUT", cookie: b.cookie })).status).toBe(404);
  });

  it("B cannot put A's item into B's own collection", async () => {
    const col = await call("/api/v1/collections", { method: "POST", cookie: b.cookie, json: { name: "B col" } });
    const colB = ((await col.json()) as { collection: { id: string } }).collection.id;
    expect((await call(`/api/v1/collections/${colB}/items/${itemA}`, { method: "PUT", cookie: b.cookie })).status).toBe(404);
  });

  it("identical content saved by two users creates two separate items", async () => {
    const text = "Shared public quote that both users saved";
    const ra = await createText(a.cookie, text);
    const rb = await createText(b.cookie, text);
    expect(ra.body.duplicate).toBe(false);
    expect(rb.body.duplicate).toBe(false);
    expect(ra.body.item.id).not.toBe(rb.body.item.id);
  });

  it("export contains only the caller's data", async () => {
    const ex = (await (await call("/api/v1/export", { cookie: b.cookie })).json()) as { items: { id: string }[] };
    expect(ex.items.map((i) => i.id)).not.toContain(itemA);
  });
});
