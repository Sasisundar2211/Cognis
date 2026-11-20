import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { capturedEmails } from "../src/lib/email";
import { hashPassword, verifyPassword } from "../src/lib/password";
import { call, cookieFrom, newUser, PASSWORD } from "./helpers";

describe("password hashing", () => {
  it("produces salted scrypt hashes that verify and reject wrong passwords", async () => {
    const a = await hashPassword("a-long-password-1");
    const b = await hashPassword("a-long-password-1");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt:16384:16:1:")).toBe(true);
    expect(await verifyPassword({ hash: a, password: "a-long-password-1" })).toBe(true);
    expect(await verifyPassword({ hash: a, password: "a-long-password-2" })).toBe(false);
  });

  it("rejects malformed or hostile hash strings without throwing", async () => {
    for (const h of ["", "bcrypt:x", "scrypt:99999999:16:1:00:00", "scrypt:16384:16:1:zz:zz", "scrypt:16384:16:1"]) {
      expect(await verifyPassword({ hash: h, password: "x" })).toBe(false);
    }
  });

});

describe("registration, verification, sign-in", () => {
  it("requires email verification before sign-in", async () => {
    const email = `unverified-${crypto.randomUUID()}@example.com`;
    const up = await call("/api/auth/sign-up/email", { method: "POST", json: { email, password: PASSWORD, name: "x" } });
    expect(up.status).toBe(200);
    expect(cookieFrom(up)).not.toContain("session_token=");
    const signIn = await call("/api/auth/sign-in/email", { method: "POST", json: { email, password: PASSWORD } });
    expect(signIn.status).toBe(403);
  });

  it("completes the full flow and stores no plaintext password", async () => {
    const { cookie, email } = await newUser("flow");
    const me = await call("/api/v1/me", { cookie });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { email: string; plan: string; emailVerified: boolean } };
    expect(body.user.email).toBe(email);
    expect(body.user.plan).toBe("free");
    expect(body.user.emailVerified).toBe(true);
    const row = await env.DB.prepare('SELECT a.password FROM account a JOIN "user" u ON u.id = a.userId WHERE u.email = ?').bind(email).first<{ password: string }>();
    expect(row!.password).not.toContain(PASSWORD);
    expect(row!.password.startsWith("scrypt:")).toBe(true);
  });

  it("rejects wrong passwords and short passwords", async () => {
    const { email } = await newUser("wrong");
    const bad = await call("/api/auth/sign-in/email", { method: "POST", json: { email, password: "not-the-password" } });
    expect(bad.status).toBe(401);
    const short = await call("/api/auth/sign-up/email", { method: "POST", json: { email: `s-${crypto.randomUUID()}@example.com`, password: "short", name: "s" } });
    expect(short.status).toBe(400);
  });

  it("does not let sign-up set the plan field", async () => {
    const email = `plan-${crypto.randomUUID()}@example.com`;
    const res = await call("/api/auth/sign-up/email", { method: "POST", json: { email, password: PASSWORD, name: "p", plan: "pro" } });
    // Better Auth either rejects or ignores input:false fields. Either is safe; the stored plan must stay "free".
    expect([200, 400]).toContain(res.status);
    const row = await env.DB.prepare('SELECT plan FROM "user" WHERE email = ?').bind(email).first<{ plan: string }>();
    if (row) expect(row.plan).toBe("free");
  });

  it("rejects API calls without a session", async () => {
    const res = await call("/api/v1/items");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthenticated");
  });

  it("sign-out revokes the session server-side", async () => {
    const { cookie } = await newUser("out");
    const out = await call("/api/auth/sign-out", { method: "POST", cookie, json: {} });
    expect(out.status).toBe(200);
    const me = await call("/api/v1/me", { cookie });
    expect(me.status).toBe(401);
  });

  it("resets a password through the emailed link and revokes old sessions", async () => {
    const { cookie, email } = await newUser("reset");
    const req = await call("/api/auth/request-password-reset", { method: "POST", json: { email, redirectTo: "/reset-password" } });
    expect(req.status).toBe(200);
    const mail = [...capturedEmails].reverse().find((m) => m.to === email && /Reset/.test(m.subject))!;
    const link = new URL(mail.text.match(/https?:\/\/\S+/)![0]);
    const landing = await call(link.pathname + link.search, { redirect: "manual" });
    const token = new URL(landing.headers.get("location")!, "http://localhost").searchParams.get("token");
    expect(token).toBeTruthy();
    const reset = await call("/api/auth/reset-password", { method: "POST", json: { token, newPassword: "a-brand-new-password-7" } });
    expect(reset.status).toBe(200);
    expect((await call("/api/v1/me", { cookie })).status).toBe(401);
    const oldPw = await call("/api/auth/sign-in/email", { method: "POST", json: { email, password: PASSWORD } });
    expect(oldPw.status).toBe(401);
    const newPw = await call("/api/auth/sign-in/email", { method: "POST", json: { email, password: "a-brand-new-password-7" } });
    expect(newPw.status).toBe(200);
  });

  it("rejects auth requests from a foreign origin", async () => {
    const res = await call("/api/auth/sign-in/email", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
      json: { email: "a@example.com", password: PASSWORD },
    });
    // helper sets our Origin first; override explicitly:
    const evil = await (await import("cloudflare:workers")).exports.default.fetch(
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: { Origin: "https://evil.example", "Content-Type": "application/json", Cookie: "x=1" },
        body: JSON.stringify({ email: "a@example.com", password: PASSWORD }),
      }),
    );
    expect(res.status).not.toBe(500);
    expect(evil.status).toBe(403);
  });
});

describe("account deletion", () => {
  it("deletes the user and every item, tag and collection they owned", async () => {
    const { cookie } = await newUser("del");
    const me = (await (await call("/api/v1/me", { cookie })).json()) as { user: { id: string } };
    const uid = me.user.id;
    await call("/api/v1/items", { method: "POST", cookie, json: { kind: "note", content: "secret plan zqxdeletionmarker", tags: ["x"] } });
    await call("/api/v1/collections", { method: "POST", cookie, json: { name: "c1" } });
    const del = await call("/api/auth/delete-user", { method: "POST", cookie, json: { password: PASSWORD } });
    expect(del.status).toBe(200);
    for (const table of ["knowledge_items", "tags", "collections", "item_tags", "collection_items"]) {
      const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).bind(uid).first<{ n: number }>();
      expect(r!.n, table).toBe(0);
    }
    const fts = await env.DB.prepare("SELECT COUNT(*) AS n FROM knowledge_fts WHERE knowledge_fts MATCH ?").bind('"zqxdeletionmarker"').first<{ n: number }>();
    expect(fts!.n).toBe(0);
    expect((await call("/api/v1/me", { cookie })).status).toBe(401);
  });
});
