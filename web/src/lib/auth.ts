import { useEffect, useSyncExternalStore } from "react";

/** Client for the Rust auth endpoints under /api/auth. Cookies are HttpOnly; this code never sees the token. */

export type SessionUser = { id: string; email: string; name: string; emailVerified: boolean; plan: string };
export type AuthError = { code: string; message: string; status: number };
type Result<T> = { data: T | null; error: AuthError | null };

async function post<T>(path: string, body?: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(`/api/auth/${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) return { data: null, error: { code: json?.error?.code ?? "error", message: json?.error?.message ?? "Something went wrong.", status: res.status } };
    return { data: json as T, error: null };
  } catch {
    return { data: null, error: { code: "network", message: "Cognis could not reach the server. Check your connection.", status: 0 } };
  }
}

// Tiny session store shared by every component.
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

export const authClient = {
  signIn: {
    email: async (b: { email: string; password: string }) => {
      const r = await post<{ user: SessionUser }>("sign-in", b);
      if (r.data) set({ user: r.data.user, isPending: false });
      return r;
    },
  },
  signUp: {
    email: async (b: { name: string; email: string; password: string }) => {
      const r = await post<{ user?: SessionUser; verificationRequired: boolean }>("sign-up", b);
      if (r.data?.user) set({ user: r.data.user, isPending: false });
      return r;
    },
  },
  signOut: async () => {
    const r = await post("sign-out");
    set({ user: null, isPending: false });
    return r;
  },
  sendVerificationEmail: (b: { email: string }) => post("resend-verification", b),
  requestPasswordReset: (b: { email: string }) => post("request-password-reset", b),
  resetPassword: (b: { token: string; newPassword: string }) => post("reset-password", b),
  changePassword: (b: { currentPassword: string; newPassword: string }) => post("change-password", b),
  revokeOtherSessions: () => post("revoke-other-sessions"),
  deleteUser: async (b: { password: string }) => {
    const r = await post("delete-account", b);
    if (!r.error) set({ user: null, isPending: false });
    return r;
  },
  listSessions: async () => {
    const res = await fetch("/api/auth/sessions", { credentials: "same-origin" });
    if (!res.ok) return [];
    return (await res.json()).sessions as { id: string; kind: "browser" | "device"; label: string; createdAt: string; lastUsedAt: string; current: boolean }[];
  },
  revokeSession: async (id: string) => (await fetch(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" })).ok,
};

/** Server messages are already written for people. Add a fallback for rate limits and network errors. */
export function authErrorMessage(err: AuthError | null | undefined): string {
  if (!err) return "";
  if (err.status === 429) return "Too many attempts. Wait a minute and try again.";
  return err.message || "Something went wrong. Try again.";
}
