import { useEffect, useSyncExternalStore } from "react";

/**
 * Client for the Cognis auth API. Sign-in uses passkeys (WebAuthn) through the browser's built-in
 * navigator.credentials API. No passwords. Cookies are HttpOnly; this code never sees the session token.
 */

export type SessionUser = { id: string; email: string; name: string; emailVerified: boolean; plan: string };
export type AuthError = { code: string; message: string; status: number };
type Result<T> = { data: T | null; error: AuthError | null };

async function send<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(`/api/auth/${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return { data: null, error: null };
    const json = await res.json().catch(() => null);
    if (!res.ok) return { data: null, error: { code: json?.error?.code ?? "error", message: json?.error?.message ?? "Something went wrong.", status: res.status } };
    return { data: json as T, error: null };
  } catch {
    return { data: null, error: { code: "network", message: "Cognis could not reach the server. Check your connection.", status: 0 } };
  }
}
const post = <T>(path: string, body?: unknown) => send<T>("POST", path, body ?? {});

// ---------- base64url <-> bytes ----------
const toBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const toB64 = (b: ArrayBuffer | null) => {
  if (!b) return "";
  let s = "";
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const passkeysSupported = () => typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;

type CreationJSON = { challenge: string; rp: PublicKeyCredentialRpEntity; user: { id: string; name: string; displayName: string }; pubKeyCredParams: PublicKeyCredentialParameters[]; authenticatorSelection: AuthenticatorSelectionCriteria; attestation: AttestationConveyancePreference; timeout: number; excludeCredentials: { type: "public-key"; id: string }[] };
type RequestJSON = { challenge: string; rpId: string; userVerification: UserVerificationRequirement; timeout: number; allowCredentials: { type: "public-key"; id: string }[] };

async function createCredential(challengeId: string, o: CreationJSON, name?: string) {
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...o,
      challenge: toBytes(o.challenge),
      user: { ...o.user, id: toBytes(o.user.id) },
      excludeCredentials: o.excludeCredentials.map((c) => ({ type: c.type, id: toBytes(c.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("cancelled");
  const r = cred.response as AuthenticatorAttestationResponse;
  return { challengeId, id: cred.id, clientDataJson: toB64(r.clientDataJSON), attestationObject: toB64(r.attestationObject), name };
}

/** Turn browser WebAuthn errors into plain messages. */
function passkeyError(e: unknown): AuthError {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError") return { code: "cancelled", message: "The passkey prompt was closed or timed out. Try again when you are ready.", status: 0 };
  if (name === "InvalidStateError") return { code: "exists", message: "This device already has a Cognis passkey for this account.", status: 0 };
  if (name === "SecurityError") return { code: "insecure", message: "Passkeys need a secure (https) address.", status: 0 };
  return { code: "passkey_failed", message: "Your device could not create or use a passkey. Try another device, or use a recovery code.", status: 0 };
}

// ---------- session store ----------
type State = { user: SessionUser | null; isPending: boolean };
let state: State = { user: null, isPending: true };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const set = (s: State) => {
  state = s;
  listeners.forEach((l) => l());
};

export function refreshSession(): Promise<void> {
  loading = fetch("/api/auth/session", { credentials: "same-origin" })
    .then(async (r) => set({ user: r.ok ? (((await r.json()).user as SessionUser | null) ?? null) : null, isPending: false }))
    .catch(() => set({ user: null, isPending: false }));
  return loading;
}

export function useSession() {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
  useEffect(() => {
    if (s.isPending && !loading) void refreshSession();
  }, [s.isPending]);
  return { data: s.user ? { user: s.user } : null, isPending: s.isPending };
}

export type Passkey = { id: string; name: string; createdAt: string; lastUsedAt: string | null };
export type Session = { id: string; kind: "browser" | "device"; label: string; createdAt: string; lastUsedAt: string; current: boolean };

export const authClient = {
  /** Sign up: email + name, then the device creates a passkey. Returns one-time recovery codes. */
  signUp: async (email: string, name: string): Promise<Result<{ user: SessionUser; recoveryCodes: string[] }>> => {
    const opts = await post<{ challengeId: string; publicKey: CreationJSON }>("passkey/register/options", { email, name });
    if (opts.error || !opts.data) return { data: null, error: opts.error };
    let body;
    try {
      body = await createCredential(opts.data.challengeId, opts.data.publicKey, deviceName());
    } catch (e) {
      return { data: null, error: passkeyError(e) };
    }
    const r = await post<{ user: SessionUser; recoveryCodes: string[] }>("passkey/register/verify", body);
    if (r.data) set({ user: r.data.user, isPending: false });
    return r;
  },

  /** Sign in with any passkey saved for Cognis on this device or a nearby phone. */
  signIn: async (): Promise<Result<{ user: SessionUser }>> => {
    const opts = await post<{ challengeId: string; publicKey: RequestJSON }>("passkey/login/options");
    if (opts.error || !opts.data) return { data: null, error: opts.error };
    let cred: PublicKeyCredential | null;
    try {
      const o = opts.data.publicKey;
      cred = (await navigator.credentials.get({ publicKey: { ...o, challenge: toBytes(o.challenge), allowCredentials: [] } })) as PublicKeyCredential | null;
    } catch (e) {
      return { data: null, error: passkeyError(e) };
    }
    if (!cred) return { data: null, error: passkeyError(null) };
    const r = cred.response as AuthenticatorAssertionResponse;
    const res = await post<{ user: SessionUser }>("passkey/login/verify", {
      challengeId: opts.data.challengeId,
      id: cred.id,
      clientDataJson: toB64(r.clientDataJSON),
      authenticatorData: toB64(r.authenticatorData),
      signature: toB64(r.signature),
      userHandle: toB64(r.userHandle),
    });
    if (res.data) set({ user: res.data.user, isPending: false });
    return res;
  },

  recover: async (email: string, code: string) => {
    const r = await post<{ user: SessionUser; recoveryCodesLeft: number }>("recovery", { email, code });
    if (r.data) set({ user: r.data.user, isPending: false });
    return r;
  },

  signOut: async () => {
    const r = await post("sign-out");
    set({ user: null, isPending: false });
    return r;
  },

  addPasskey: async (): Promise<Result<unknown>> => {
    const opts = await post<{ challengeId: string; publicKey: CreationJSON }>("passkey/add/options");
    if (opts.error || !opts.data) return { data: null, error: opts.error };
    try {
      return await post("passkey/add/verify", await createCredential(opts.data.challengeId, opts.data.publicKey, deviceName()));
    } catch (e) {
      return { data: null, error: passkeyError(e) };
    }
  },
  listPasskeys: () => send<{ passkeys: Passkey[]; recoveryCodesLeft: number }>("GET", "passkeys"),
  removePasskey: (id: string) => send("DELETE", `passkeys/${encodeURIComponent(id)}`),
  newRecoveryCodes: () => post<{ recoveryCodes: string[] }>("recovery-codes"),
  pairingCode: () => post<{ code: string; expiresAt: string }>("pairing"),
  listSessions: async () => (await send<{ sessions: Session[] }>("GET", "sessions")).data?.sessions ?? [],
  revokeSession: async (id: string) => !(await send("DELETE", `sessions/${encodeURIComponent(id)}`)).error,
  revokeOtherSessions: () => post("revoke-other-sessions"),
  deleteAccount: async () => {
    const r = await post("delete-account", { confirm: "DELETE" });
    if (!r.error) set({ user: null, isPending: false });
    return r;
  },
};

function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iPhone or iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
  return `${os} passkey`;
}

export function authErrorMessage(err: AuthError | null | undefined): string {
  if (!err) return "";
  if (err.status === 429) return "Too many attempts. Wait a minute and try again.";
  return err.message || "Something went wrong. Try again.";
}
