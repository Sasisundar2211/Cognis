import { exports } from "cloudflare:workers";
import { capturedEmails } from "../src/lib/email";

export const ORIGIN = "http://localhost";

export function call(path: string, init: RequestInit & { cookie?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  headers.set("Origin", ORIGIN);
  if (init.cookie) headers.set("Cookie", init.cookie);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers, body }));
}

export function cookieFrom(res: Response): string {
  const all = res.headers.getSetCookie();
  return all.map((c) => c.split(";")[0]).join("; ");
}

let counter = 0;
export const PASSWORD = "correct-horse-battery-9";

/** Sign up, verify email through the real emailed link, sign in. Returns the session cookie. */
export async function newUser(label = "u"): Promise<{ cookie: string; email: string }> {
  const email = `${label.toLowerCase()}${++counter}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const signUp = await call("/api/auth/sign-up/email", { method: "POST", json: { email, password: PASSWORD, name: label } });
  if (signUp.status !== 200) throw new Error(`sign-up failed ${signUp.status} ${await signUp.text()}`);
  const mail = [...capturedEmails].reverse().find((m) => m.to === email && /Verify/.test(m.subject));
  if (!mail) throw new Error("no verification email");
  const link = mail.text.match(/https?:\/\/\S+/)![0];
  const u = new URL(link);
  const verify = await call(u.pathname + u.search, { method: "GET", redirect: "manual" });
  if (verify.status >= 400) throw new Error(`verify failed ${verify.status}`);
  const signIn = await call("/api/auth/sign-in/email", { method: "POST", json: { email, password: PASSWORD } });
  if (signIn.status !== 200) throw new Error(`sign-in failed ${signIn.status} ${await signIn.text()}`);
  return { cookie: cookieFrom(signIn), email };
}

export async function createText(cookie: string, content: string, extra: Record<string, unknown> = {}) {
  const res = await call("/api/v1/items", { method: "POST", cookie, json: { kind: "text", content, ...extra } });
  const body = (await res.json()) as { item: { id: string; status: string; tags: string[] }; duplicate: boolean };
  return { res, body };
}
