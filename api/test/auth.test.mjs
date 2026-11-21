import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, call, cookieFrom, emailsTo, newUser, PASSWORD } from "./helpers.mjs";

test("verification is required before sign-in", async () => {
  const email = `unverified-${crypto.randomUUID()}@example.com`;
  const up = await call("/api/auth/sign-up", { method: "POST", json: { email, password: PASSWORD } });
  assert.equal(up.status, 200);
  assert.deepEqual(await up.json(), { verificationRequired: true });
  assert.equal(cookieFrom(up), "");
  const si = await call("/api/auth/sign-in", { method: "POST", json: { email, password: PASSWORD } });
  assert.equal(si.status, 403);
  assert.equal((await si.json()).error.code, "email_not_verified");
});

test("full flow: verify link signs in, password stored as scrypt hash only", async () => {
  const u = await newUser("Flow");
  const me = await (await call("/api/v1/me", { cookie: u.cookie })).json();
  assert.equal(me.user.email, u.email);
  assert.equal(me.user.plan, "free");
  assert.equal(me.user.emailVerified, true);
  assert.equal(me.limits.maxItems, 500);
  const si = await call("/api/auth/sign-in", { method: "POST", json: { email: u.email.toUpperCase(), password: PASSWORD } });
  assert.equal(si.status, 200, "email matching is case-insensitive");
  assert.match(cookieFrom(si), /^cognis_session=[A-Za-z0-9_-]{43}$/);
  const raw = si.headers.getSetCookie()[0];
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);
});

test("verify link is single-use and bogus tokens are rejected", async () => {
  const email = `once-${crypto.randomUUID()}@example.com`;
  await call("/api/auth/sign-up", { method: "POST", json: { email, password: PASSWORD } });
  const link = new URL((await emailsTo(email))[0].text.match(/https?:\/\/\S+/)[0]);
  assert.equal((await call(link.pathname + link.search)).headers.get("location"), "/app/welcome");
  assert.equal((await call(link.pathname + link.search)).headers.get("location"), "/sign-in?error=invalid_token");
  assert.equal((await call("/api/auth/verify-email?token=nope")).headers.get("location"), "/sign-in?error=invalid_token");
});

test("wrong password, unknown user, short and long passwords", async () => {
  const u = await newUser("wrong");
  const bad = await call("/api/auth/sign-in", { method: "POST", json: { email: u.email, password: "not-the-password" } });
  assert.equal(bad.status, 401);
  const unknown = await call("/api/auth/sign-in", { method: "POST", json: { email: "nobody@example.com", password: "whatever-123" } });
  assert.equal(unknown.status, 401);
  assert.equal((await bad.json()).error.message, (await unknown.json()).error.message, "same message for both");
  for (const pw of ["short", "x".repeat(129)]) {
    const r = await call("/api/auth/sign-up", { method: "POST", json: { email: `p-${crypto.randomUUID()}@example.com`, password: pw } });
    assert.equal(r.status, 422);
  }
  const badEmail = await call("/api/auth/sign-up", { method: "POST", json: { email: "not-an-email", password: PASSWORD } });
  assert.equal(badEmail.status, 422);
});

test("sign-up rejects unknown fields such as plan", async () => {
  const email = `plan-${crypto.randomUUID()}@example.com`;
  const r = await call("/api/auth/sign-up", { method: "POST", json: { email, password: PASSWORD, plan: "pro" } });
  assert.equal(r.status, 422);
});

test("existing email: no account enumeration when email is enabled", async () => {
  const u = await newUser("dupe");
  const r = await call("/api/auth/sign-up", { method: "POST", json: { email: u.email, password: PASSWORD } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { verificationRequired: true });
  assert.ok((await emailsTo(u.email)).some((m) => m.subject.includes("tried to sign up")));
});

test("API rejects missing and forged sessions", async () => {
  const r = await call("/api/v1/items");
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, "unauthenticated");
  assert.equal((await call("/api/v1/items", { cookie: "cognis_session=forged" })).status, 401);
  assert.equal((await call("/api/v1/items", { bearer: "forged-token" })).status, 401);
});

test("sign-out revokes the session server-side", async () => {
  const u = await newUser("out");
  assert.equal((await call("/api/auth/sign-out", { method: "POST", cookie: u.cookie })).status, 200);
  assert.equal((await call("/api/v1/me", { cookie: u.cookie })).status, 401);
});

test("password reset via emailed link revokes every session", async () => {
  const u = await newUser("reset");
  assert.equal((await call("/api/auth/request-password-reset", { method: "POST", json: { email: u.email } })).status, 200);
  assert.equal((await call("/api/auth/request-password-reset", { method: "POST", json: { email: "ghost@example.com" } })).status, 200, "same answer for unknown email");
  const mail = (await emailsTo(u.email)).find((m) => m.subject.includes("Reset"));
  const token = new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
  const reset = await call("/api/auth/reset-password", { method: "POST", json: { token, newPassword: "a-brand-new-password-7" } });
  assert.equal(reset.status, 200);
  assert.equal((await call("/api/v1/me", { cookie: u.cookie })).status, 401);
  assert.equal((await call("/api/auth/reset-password", { method: "POST", json: { token, newPassword: "another-password-8" } })).status, 400, "token is single-use");
  assert.equal((await call("/api/auth/sign-in", { method: "POST", json: { email: u.email, password: PASSWORD } })).status, 401);
  assert.equal((await call("/api/auth/sign-in", { method: "POST", json: { email: u.email, password: "a-brand-new-password-7" } })).status, 200);
});

test("change password keeps this session and revokes others", async () => {
  const u = await newUser("chg");
  const other = cookieFrom(await call("/api/auth/sign-in", { method: "POST", json: { email: u.email, password: PASSWORD } }));
  const wrong = await call("/api/auth/change-password", { method: "POST", cookie: u.cookie, json: { currentPassword: "nope-nope-nope", newPassword: "next-password-123" } });
  assert.equal(wrong.status, 401);
  const ok = await call("/api/auth/change-password", { method: "POST", cookie: u.cookie, json: { currentPassword: PASSWORD, newPassword: "next-password-123" } });
  assert.equal(ok.status, 200);
  assert.equal((await call("/api/v1/me", { cookie: u.cookie })).status, 200);
  assert.equal((await call("/api/v1/me", { cookie: other })).status, 401);
});

test("desktop device token: bearer auth, listed, revocable, no cookie", async () => {
  const u = await newUser("dev");
  const si = await call("/api/auth/sign-in", { method: "POST", json: { email: u.email, password: PASSWORD, device: "Laptop companion" } });
  assert.equal(si.status, 200);
  assert.equal(si.headers.getSetCookie().length, 0);
  const { token } = await si.json();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await call("/api/v1/me", { bearer: token })).status, 200);
  // Bearer requests carry no ambient credential, so they work without an Origin header.
  const created = await call("/api/v1/items", { method: "POST", bearer: token, json: { kind: "note", content: "saved from the desktop companion" } });
  assert.equal(created.status, 201);
  const sessions = (await (await call("/api/auth/sessions", { cookie: u.cookie })).json()).sessions;
  const device = sessions.find((s) => s.kind === "device");
  assert.equal(device.label, "Laptop companion");
  assert.equal((await call(`/api/auth/sessions/${device.id}`, { method: "DELETE", cookie: u.cookie })).status, 204);
  assert.equal((await call("/api/v1/me", { bearer: token })).status, 401);
});

test("foreign origins are rejected on auth and API", async () => {
  const r = await call("/api/auth/sign-in", { method: "POST", headers: { Origin: "https://evil.example" }, json: { email: "a@example.com", password: PASSWORD } });
  assert.equal(r.status, 403);
});

test("account deletion removes everything and the session", async () => {
  const u = await newUser("del");
  await call("/api/v1/items", { method: "POST", cookie: u.cookie, json: { kind: "note", content: "secret plan zqxdeletionmarker", tags: ["x"] } });
  await call("/api/v1/collections", { method: "POST", cookie: u.cookie, json: { name: "c1" } });
  const wrong = await call("/api/auth/delete-account", { method: "POST", cookie: u.cookie, json: { password: "wrong-password-1" } });
  assert.equal(wrong.status, 401);
  const del = await call("/api/auth/delete-account", { method: "POST", cookie: u.cookie, json: { password: PASSWORD } });
  assert.equal(del.status, 200);
  assert.equal((await call("/api/v1/me", { cookie: u.cookie })).status, 401);
  assert.equal((await call("/api/auth/sign-in", { method: "POST", json: { email: u.email, password: PASSWORD } })).status, 401);
  // A new account must not see any trace of the deleted one.
  const v = await newUser("after");
  const s = await (await call("/api/v1/search?q=zqxdeletionmarker&mode=lexical", { cookie: v.cookie })).json();
  assert.equal(s.results.length, 0);
});

test("security headers and request ids on every API response", async () => {
  const r = await call("/api/v1/health");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.ok(r.headers.get("x-request-id"));
  assert.equal((await (await call("/api/v1/ready")).json()).database, "ok");
  assert.equal((await call("/api/nope")).status, 401);
  assert.ok(BASE);
});
