import { test } from "node:test";
import assert from "node:assert/strict";
import { Authenticator, BASE, call, cookieFrom, deviceToken, newUser, signIn } from "./helpers.mjs";

test("sign up with a passkey: session, recovery codes, no password stored", async () => {
  const u = await newUser("Flow");
  assert.equal(u.recoveryCodes.length, 8);
  assert.match(u.recoveryCodes[0], /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const me = await (await call("/api/v1/me", { cookie: u.cookie })).json();
  assert.equal(me.user.email, u.email);
  assert.equal(me.user.plan, "free");
  assert.match(u.cookie, /^cognis_session=[A-Za-z0-9_-]{43}$/);
});

test("sign in with the passkey; counter and signature are enforced", async () => {
  const u = await newUser("login");
  const { res, cookie } = await signIn(u.auth);
  assert.equal(res.status, 200);
  assert.equal((await call("/api/v1/me", { cookie })).status, 200);
  const raw = res.headers.getSetCookie()[0];
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);

  // Tampered signature
  const o1 = await (await call("/api/auth/passkey/login/options", { method: "POST", json: {} })).json();
  const bad = await call("/api/auth/passkey/login/verify", { method: "POST", json: u.auth.get(o1, { tamper: true }) });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.details.reason, "bad_signature");

  // Cloned authenticator: counter goes backwards
  const o2 = await (await call("/api/auth/passkey/login/options", { method: "POST", json: {} })).json();
  u.auth.count = 0;
  const cloned = await call("/api/auth/passkey/login/verify", { method: "POST", json: u.auth.get(o2) });
  assert.equal((await cloned.json()).error.details.reason, "counter_regressed");
});

test("challenges are single use and bound to the purpose", async () => {
  const u = await newUser("replay");
  const opts = await (await call("/api/auth/passkey/login/options", { method: "POST", json: {} })).json();
  u.auth.count = 100;
  const resp = u.auth.get(opts);
  assert.equal((await call("/api/auth/passkey/login/verify", { method: "POST", json: resp })).status, 200);
  const again = await call("/api/auth/passkey/login/verify", { method: "POST", json: resp });
  assert.equal(again.status, 400);
  assert.equal((await again.json()).error.code, "invalid_challenge");
  const reg = await (await call("/api/auth/passkey/register/options", { method: "POST", json: { email: `p-${crypto.randomUUID()}@example.com` } })).json();
  const wrongPurpose = await call("/api/auth/passkey/login/verify", { method: "POST", json: u.auth.get(reg) });
  assert.equal((await wrongPurpose.json()).error.code, "invalid_challenge");
});

test("a passkey made for another site or origin is rejected", async () => {
  for (const [origin, rpId, reason] of [["https://evil.example", "localhost", "wrong_origin"], [new URL(BASE).origin, "evil.example", "wrong_rp"]]) {
    const a = new Authenticator({ origin, rpId });
    const opts = await (await call("/api/auth/passkey/register/options", { method: "POST", json: { email: `x-${crypto.randomUUID()}@example.com` } })).json();
    const r = await call("/api/auth/passkey/register/verify", { method: "POST", json: a.create(opts) });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.details.reason, reason);
  }
});

test("unknown passkeys, duplicate emails and bad input", async () => {
  const stranger = new Authenticator();
  stranger.userHandle = "abc";
  const opts = await (await call("/api/auth/passkey/login/options", { method: "POST", json: {} })).json();
  const r = await call("/api/auth/passkey/login/verify", { method: "POST", json: stranger.get(opts) });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, "unknown_passkey");
  const u = await newUser("dupe");
  const d = await call("/api/auth/passkey/register/options", { method: "POST", json: { email: u.email.toUpperCase() } });
  assert.equal(d.status, 409);
  assert.equal((await call("/api/auth/passkey/register/options", { method: "POST", json: { email: "not-an-email" } })).status, 422);
  assert.equal((await call("/api/auth/passkey/register/options", { method: "POST", json: { email: "a@b.co", plan: "pro" } })).status, 422);
  assert.equal((await call("/api/auth/passkey/login/verify", { method: "POST", json: { challengeId: "nope", id: "x", clientDataJson: "x", authenticatorData: "x", signature: "x" } })).status, 400);
});

test("recovery codes sign in once each", async () => {
  const u = await newUser("recover");
  const r1 = await call("/api/auth/recovery", { method: "POST", json: { email: u.email, code: u.recoveryCodes[0].toLowerCase().replaceAll("-", " ") } });
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).recoveryCodesLeft, 7);
  assert.equal((await call("/api/v1/me", { cookie: cookieFrom(r1) })).status, 200);
  const again = await call("/api/auth/recovery", { method: "POST", json: { email: u.email, code: u.recoveryCodes[0] } });
  assert.equal(again.status, 401);
  const other = await newUser("recover2");
  assert.equal((await call("/api/auth/recovery", { method: "POST", json: { email: other.email, code: u.recoveryCodes[1] } })).status, 401, "codes are bound to their account");
  const regen = await (await call("/api/auth/recovery-codes", { method: "POST", cookie: u.cookie })).json();
  assert.equal(regen.recoveryCodes.length, 8);
  assert.equal((await call("/api/auth/recovery", { method: "POST", json: { email: u.email, code: u.recoveryCodes[2] } })).status, 401, "old codes revoked");
});

test("add a second passkey, list, and never remove the last one", async () => {
  const u = await newUser("keys");
  const second = new Authenticator();
  const opts = await (await call("/api/auth/passkey/add/options", { method: "POST", cookie: u.cookie })).json();
  assert.equal(opts.publicKey.excludeCredentials.length, 1);
  assert.equal(opts.publicKey.user.id, u.auth.userHandle, "same user handle for all passkeys");
  assert.equal((await call("/api/auth/passkey/add/verify", { method: "POST", cookie: u.cookie, json: { ...second.create(opts), name: "Phone" } })).status, 200);
  assert.equal((await signIn(second)).res.status, 200);
  const list = await (await call("/api/auth/passkeys", { cookie: u.cookie })).json();
  assert.equal(list.passkeys.length, 2);
  assert.equal(list.recoveryCodesLeft, 8);
  assert.equal((await call(`/api/auth/passkeys/${list.passkeys[0].id}`, { method: "DELETE", cookie: u.cookie })).status, 204);
  const last = await call(`/api/auth/passkeys/${list.passkeys[1].id}`, { method: "DELETE", cookie: u.cookie });
  assert.equal(last.status, 409);
  // Another user's challenge cannot be used to attach a passkey.
  const v = await newUser("keys2");
  const vopts = await (await call("/api/auth/passkey/add/options", { method: "POST", cookie: v.cookie })).json();
  assert.equal((await call("/api/auth/passkey/add/verify", { method: "POST", cookie: u.cookie, json: new Authenticator().create(vopts) })).status, 400);
});

test("desktop pairing: one code, one device token, revocable", async () => {
  const u = await newUser("pair");
  const { code, expiresAt } = await (await call("/api/auth/pairing", { method: "POST", cookie: u.cookie })).json();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(new Date(expiresAt) > new Date());
  const r = await call("/api/auth/pair", { method: "POST", headers: { Origin: "" }, json: { code: code.toLowerCase(), device: "Laptop companion" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.getSetCookie().length, 0);
  const { token } = await r.json();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await call("/api/v1/me", { bearer: token })).status, 200);
  assert.equal((await call("/api/auth/pair", { method: "POST", json: { code } })).status, 400, "single use");
  assert.equal((await call("/api/auth/pair", { method: "POST", json: { code: "AAAA-AAAA" } })).status, 400);
  assert.equal((await call("/api/auth/pairing", { method: "POST", bearer: token })).status, 403, "devices cannot mint pairing codes");
  const device = (await (await call("/api/auth/sessions", { cookie: u.cookie })).json()).sessions.find((s) => s.kind === "device");
  assert.equal(device.label, "Laptop companion");
  assert.equal((await call(`/api/auth/sessions/${device.id}`, { method: "DELETE", cookie: u.cookie })).status, 204);
  assert.equal((await call("/api/v1/me", { bearer: token })).status, 401);
});

test("missing and forged sessions are rejected", async () => {
  const r = await call("/api/v1/items");
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, "unauthenticated");
  assert.equal((await call("/api/v1/items", { cookie: "cognis_session=forged" })).status, 401);
  assert.equal((await call("/api/v1/items", { bearer: "forged-token" })).status, 401);
  assert.deepEqual(await (await call("/api/auth/session")).json(), { user: null });
});

test("sign-out revokes the session server-side", async () => {
  const u = await newUser("out");
  assert.equal((await call("/api/auth/sign-out", { method: "POST", cookie: u.cookie })).status, 200);
  assert.equal((await call("/api/v1/me", { cookie: u.cookie })).status, 401);
});

test("foreign origins are rejected on auth and API", async () => {
  const r = await call("/api/auth/passkey/login/options", { method: "POST", headers: { Origin: "https://evil.example" }, json: {} });
  assert.equal(r.status, 403);
});

test("account deletion: typed confirmation, fresh session, removes everything", async () => {
  const u = await newUser("del");
  await call("/api/v1/items", { method: "POST", cookie: u.cookie, json: { kind: "note", content: "secret plan zqxdeletionmarker", tags: ["x"] } });
  const token = await deviceToken(u.cookie);
  assert.equal((await call("/api/auth/delete-account", { method: "POST", cookie: u.cookie, json: { confirm: "yes" } })).status, 422);
  assert.equal((await call("/api/auth/delete-account", { method: "POST", bearer: token, json: { confirm: "DELETE" } })).status, 403, "a device token cannot delete the account");
  const del = await call("/api/auth/delete-account", { method: "POST", cookie: u.cookie, json: { confirm: "DELETE" } });
  assert.equal(del.status, 200);
  assert.equal((await call("/api/v1/me", { cookie: u.cookie })).status, 401);
  assert.equal((await call("/api/v1/me", { bearer: token })).status, 401);
  assert.equal((await signIn(u.auth)).res.status, 401, "passkey removed with the account");
  const v = await newUser("after");
  assert.equal((await (await call("/api/v1/search?q=zqxdeletionmarker&mode=lexical", { cookie: v.cookie })).json()).results.length, 0);
});

test("security headers and request ids on every API response", async () => {
  const r = await call("/api/v1/health");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.ok(r.headers.get("x-request-id"));
  assert.equal((await (await call("/api/v1/ready")).json()).database, "ok");
});
