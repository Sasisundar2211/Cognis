import { describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { call, createText, newUser } from "./helpers";

describe("knowledge items", () => {
  it("creates, reads, edits, tags, archives and deletes a note", async () => {
    const { cookie } = await newUser("crud");
    const { res, body } = await createText(cookie, "First line title\nBody about distribution channels", { tags: ["Marketing", "marketing", "growth ideas"] });
    expect(res.status).toBe(201);
    expect(body.item.status).toBe("ready");
    expect(body.item.tags.sort()).toEqual(["growth-ideas", "marketing"]);
    const id = body.item.id;

    const got = (await (await call(`/api/v1/items/${id}`, { cookie })).json()) as { item: { title: string; hasEmbedding: boolean } };
    expect(got.item.title).toBe("First line title");
    expect(got.item.hasEmbedding).toBe(true);

    const patched = await call(`/api/v1/items/${id}`, { method: "PATCH", cookie, json: { title: "Renamed", tags: ["seo"] } });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { item: { title: string; tags: string[] } }).item).toMatchObject({ title: "Renamed", tags: ["seo"] });

    const tags = (await (await call("/api/v1/tags", { cookie })).json()) as { tags: { name: string }[] };
    expect(tags.tags.map((t) => t.name)).toEqual(["seo"]); // unused tags are cleaned up

    await call(`/api/v1/items/${id}`, { method: "PATCH", cookie, json: { archived: true } });
    const active = (await (await call("/api/v1/items", { cookie })).json()) as { items: unknown[] };
    expect(active.items).toHaveLength(0);
    const archived = (await (await call("/api/v1/items?archived=true", { cookie })).json()) as { items: unknown[] };
    expect(archived.items).toHaveLength(1);

    expect((await call(`/api/v1/items/${id}`, { method: "DELETE", cookie })).status).toBe(204);
    expect((await call(`/api/v1/items/${id}`, { cookie })).status).toBe(404);
  });

  it("detects duplicates idempotently", async () => {
    const { cookie } = await newUser("dup");
    const one = await createText(cookie, "Same   content\n\n\n\nhere");
    const two = await createText(cookie, "Same content\n\nhere");
    expect(one.res.status).toBe(201);
    expect(two.res.status).toBe(200);
    expect(two.body.duplicate).toBe(true);
    expect(two.body.item.id).toBe(one.body.item.id);
  });

  it("paginates with a stable cursor", async () => {
    const { cookie } = await newUser("page");
    for (let i = 0; i < 5; i++) await createText(cookie, `pagination note number ${i}`);
    const p1 = (await (await call("/api/v1/items?limit=2", { cookie })).json()) as { items: { id: string }[]; nextCursor: string };
    const p2 = (await (await call(`/api/v1/items?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`, { cookie })).json()) as { items: { id: string }[]; nextCursor: string };
    const p3 = (await (await call(`/api/v1/items?limit=2&cursor=${encodeURIComponent(p2.nextCursor)}`, { cookie })).json()) as { items: { id: string }[]; nextCursor: string | null };
    const all = [...p1.items, ...p2.items, ...p3.items].map((i) => i.id);
    expect(new Set(all).size).toBe(5);
    expect(p3.nextCursor).toBeNull();
  });

  it("validates input and returns structured errors without leaking internals", async () => {
    const { cookie } = await newUser("val");
    const cases: [unknown, number][] = [
      [{ kind: "text" }, 422],
      [{ kind: "text", content: "" }, 422],
      [{ kind: "text", content: "   \n\t " }, 422],
      [{ kind: "bogus", content: "x" }, 422],
      [{ kind: "text", content: "x", extra: "smuggled" }, 422],
      [{ kind: "url", url: "javascript:alert(1)" }, 422],
      [{ kind: "url", url: "http://127.0.0.1/admin" }, 422],
      [{ kind: "url", url: "http://169.254.169.254/latest/meta-data" }, 422],
      [{ kind: "url", url: "file:///etc/passwd" }, 422],
      [[1, 2, 3], 422],
    ];
    for (const [json, status] of cases) {
      const res = await call("/api/v1/items", { method: "POST", cookie, json });
      expect(res.status, JSON.stringify(json)).toBe(status);
      const body = (await res.json()) as { error: { code: string; requestId: string } };
      expect(body.error.code).toBeTruthy();
      expect(body.error.requestId).toBeTruthy();
      expect(JSON.stringify(body)).not.toMatch(/at \w+ \(|sqlite|D1_|stack/i);
    }
    const bad = await call("/api/v1/items", { method: "POST", cookie, headers: { "Content-Type": "application/json" }, body: "{not json" });
    expect(bad.status).toBe(400);
    expect((await call("/api/v1/items/not-an-id", { cookie })).status).toBe(404);
    expect((await call("/api/v1/items?limit=100000", { cookie })).status).toBe(422);
  });

  it("rejects oversized bodies", async () => {
    const { cookie } = await newUser("big");
    const res = await call("/api/v1/items", { method: "POST", cookie, json: { kind: "text", content: "a".repeat(300_000) } });
    expect(res.status).toBe(413);
  });

  it("blocks cross-site and non-JSON state changes (CSRF)", async () => {
    const { cookie } = await newUser("csrf");
    const evil = await exports.default.fetch(
      new Request("http://localhost/api/v1/items", {
        method: "POST",
        headers: { Origin: "https://evil.example", Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "text", content: "csrf" }),
      }),
    );
    expect(evil.status).toBe(403);
    const form = await exports.default.fetch(
      new Request("http://localhost/api/v1/items", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "text/plain" },
        body: JSON.stringify({ kind: "text", content: "csrf" }),
      }),
    );
    expect(form.status).toBe(415);
    const fetchSite = await exports.default.fetch(
      new Request("http://localhost/api/v1/items/ki_00000000000000000000000000000000", {
        method: "DELETE",
        headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" },
      }),
    );
    expect(fetchSite.status).toBe(403);
  });

  it("strips control and bidi characters from stored text", async () => {
    const { cookie } = await newUser("ctl");
    const { body } = await createText(cookie, "safe\u0000text‮with​hidden\u0002marks");
    const item = (await (await call(`/api/v1/items/${body.item.id}`, { cookie })).json()) as { item: { content: string } };
    expect(item.item.content).toBe("safetextwithhiddenmarks");
  });

  it("sets security headers on API responses", async () => {
    const res = await call("/api/v1/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect((await call("/api/v1/ready")).status).toBe(200);
  });
});

describe("collections", () => {
  it("creates collections, adds and removes items, filters by collection", async () => {
    const { cookie } = await newUser("col");
    const col = ((await (await call("/api/v1/collections", { method: "POST", cookie, json: { name: "Launch" } })).json()) as { collection: { id: string } }).collection.id;
    expect((await call("/api/v1/collections", { method: "POST", cookie, json: { name: "Launch" } })).status).toBe(409);
    const i1 = (await createText(cookie, "in the collection")).body.item.id;
    await createText(cookie, "not in the collection");
    expect((await call(`/api/v1/collections/${col}/items/${i1}`, { method: "PUT", cookie })).status).toBe(204);
    const filtered = (await (await call(`/api/v1/items?collection=${col}`, { cookie })).json()) as { items: { id: string }[] };
    expect(filtered.items.map((i) => i.id)).toEqual([i1]);
    const list = (await (await call("/api/v1/collections", { cookie })).json()) as { collections: { itemCount: number }[] };
    expect(list.collections[0]!.itemCount).toBe(1);
    expect((await call(`/api/v1/collections/${col}/items/${i1}`, { method: "DELETE", cookie })).status).toBe(204);
    expect((await call(`/api/v1/collections/${col}`, { method: "DELETE", cookie })).status).toBe(204);
    expect((await call(`/api/v1/items/${i1}`, { cookie })).status).toBe(200); // item survives collection deletion
  });
});
