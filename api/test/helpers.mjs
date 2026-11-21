// Black-box helpers for the Rust API. Target: `npm run serve:test` (http://localhost:8788).
export const BASE = process.env.COGNIS_TEST_URL || "http://localhost:8788";
export const ORIGIN = new URL(BASE).origin;
export const PASSWORD = "correct-horse-battery-9";

export async function call(path, { method = "GET", json, cookie, bearer, headers = {}, body, redirect = "manual" } = {}) {
  const h = new Headers(headers);
  if (!h.has("Origin") && !bearer) h.set("Origin", ORIGIN);
  if (cookie) h.set("Cookie", cookie);
  if (bearer) h.set("Authorization", `Bearer ${bearer}`);
  if (json !== undefined) {
    h.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  }
  return fetch(BASE + path, { method, headers: h, body, redirect });
}

export async function jsonOf(res) {
  return res.json();
}

export function cookieFrom(res) {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

export async function emailsTo(to) {
  const r = await (await call("/api/test/emails")).json();
  return r.emails.filter((m) => m.to === to);
}

let n = 0;
/** Sign up, follow the real emailed verification link, then return a session cookie. */
export async function newUser(label = "u") {
  const email = `${label.toLowerCase()}${++n}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const up = await call("/api/auth/sign-up", { method: "POST", json: { email, password: PASSWORD, name: label } });
  if (up.status !== 200) throw new Error(`sign-up ${up.status} ${await up.text()}`);
  const mail = (await emailsTo(email)).find((m) => m.subject.includes("Verify"));
  const link = new URL(mail.text.match(/https?:\/\/\S+/)[0]);
  const v = await call(link.pathname + link.search);
  if (v.status !== 302) throw new Error(`verify ${v.status}`);
  const cookie = cookieFrom(v);
  const me = await (await call("/api/v1/me", { cookie })).json();
  return { email, cookie, id: me.user.id };
}

export async function createText(cookie, content, extra = {}) {
  const res = await call("/api/v1/items", { method: "POST", cookie, json: { kind: "text", content, ...extra } });
  return { res, body: await res.json() };
}
