// Black-box helpers for the Rust API. Target: `npm run serve:test` (http://localhost:8788).
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

export const BASE = process.env.COGNIS_TEST_URL || "http://localhost:8788";
export const ORIGIN = new URL(BASE).origin;
export const RP_ID = new URL(BASE).hostname;

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

export function cookieFrom(res) {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

// ---------- minimal CBOR encoder (maps, ints, text, bytes) ----------
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}
export function cbor(v) {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("unsupported cbor value");
}

const b64u = (b) => Buffer.from(b).toString("base64url");
const sha256 = (b) => createHash("sha256").update(b).digest();

/** A software passkey authenticator (ES256), like a phone or laptop would provide. */
export class Authenticator {
  constructor({ origin = ORIGIN, rpId = RP_ID } = {}) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
    this.credId = randomBytes(32);
    this.count = 0;
    this.origin = origin;
    this.rpId = rpId;
    this.userHandle = null;
  }

  /** Response to navigator.credentials.create(). */
  create(options) {
    this.userHandle = options.publicKey.user.id;
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.publicKey.challenge, origin: this.origin, crossOrigin: false }));
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credId.length);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, this.credId, this.cose]);
    const att = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return { challengeId: options.challengeId, id: b64u(this.credId), clientDataJson: b64u(clientData), attestationObject: b64u(att) };
  }

  /** Response to navigator.credentials.get(). */
  get(options, { tamper = false } = {}) {
    this.count += 1;
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.publicKey.challenge, origin: this.origin, crossOrigin: false }));
    const cnt = Buffer.alloc(4);
    cnt.writeUInt32BE(this.count);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x05]), cnt]);
    const sig = sign("sha256", Buffer.concat([authData, sha256(clientData)]), { key: this.key, dsaEncoding: "der" });
    if (tamper) sig[sig.length - 1] ^= 1;
    return { challengeId: options.challengeId, id: b64u(this.credId), clientDataJson: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig), userHandle: this.userHandle };
  }
}

let n = 0;
/** Sign up with a fresh passkey. Returns the session cookie, recovery codes and the authenticator. */
export async function newUser(label = "u") {
  const email = `${label.toLowerCase()}${++n}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const auth = new Authenticator();
  const opts = await (await call("/api/auth/passkey/register/options", { method: "POST", json: { email, name: label } })).json();
  if (!opts.challengeId) throw new Error(`register options failed: ${JSON.stringify(opts)}`);
  const res = await call("/api/auth/passkey/register/verify", { method: "POST", json: auth.create(opts) });
  if (res.status !== 200) throw new Error(`register ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { email, cookie: cookieFrom(res), id: body.user.id, recoveryCodes: body.recoveryCodes, auth };
}

/** Sign in with an existing passkey. */
export async function signIn(auth) {
  const opts = await (await call("/api/auth/passkey/login/options", { method: "POST", json: {} })).json();
  const res = await call("/api/auth/passkey/login/verify", { method: "POST", json: auth.get(opts) });
  return { res, cookie: cookieFrom(res) };
}

/** Pair a desktop companion: create a code in the web session, exchange it for a device token. */
export async function deviceToken(cookie, device = "Test desktop") {
  const { code } = await (await call("/api/auth/pairing", { method: "POST", cookie })).json();
  const res = await call("/api/auth/pair", { method: "POST", headers: { Origin: "" }, json: { code, device } });
  return (await res.json()).token;
}

export async function createText(cookie, content, extra = {}) {
  const res = await call("/api/v1/items", { method: "POST", cookie, json: { kind: "text", content, ...extra } });
  return { res, body: await res.json() };
}
