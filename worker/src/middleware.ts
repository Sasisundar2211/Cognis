import type { MiddlewareHandler } from "hono";
import type { AppBindings, AuthUser, Plan } from "./env";
import { createAuth } from "./auth";
import { ApiError } from "./lib/errors";

export const requestId: MiddlewareHandler<AppBindings> = async (c, next) => {
  const incoming = c.req.header("cf-ray");
  c.set("requestId", incoming ?? crypto.randomUUID());
  const started = Date.now();
  await next();
  c.header("X-Request-Id", c.get("requestId"));
  // Structured access log: route pattern and status only. No query strings, bodies or user content.
  console.log(JSON.stringify({ level: "info", requestId: c.get("requestId"), method: c.req.method, route: c.req.routePath, status: c.res.status, ms: Date.now() - started }));
};

export const securityHeaders: MiddlewareHandler<AppBindings> = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  c.header("X-Frame-Options", "DENY");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
};

/**
 * CSRF defense for cookie-authenticated API calls.
 * 1. State-changing requests with a body must be application/json, which forces a CORS preflight cross-site.
 * 2. Reject requests the browser marks as cross-site, and any Origin that is not ours.
 */
export const csrfGuard: MiddlewareHandler<AppBindings> = async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  const expected = new URL(c.env.BETTER_AUTH_URL).origin;
  const origin = c.req.header("origin");
  if (origin && origin !== expected) throw new ApiError(403, "bad_origin", "Request origin not allowed.");
  if (c.req.header("sec-fetch-site") === "cross-site") throw new ApiError(403, "bad_origin", "Request origin not allowed.");
  const len = Number(c.req.header("content-length") ?? "0");
  const hasBody = len > 0 || c.req.header("transfer-encoding") !== undefined;
  if (hasBody && !(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "Send JSON.");
  }
  return next();
};

export const requireUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new ApiError(401, "unauthenticated", "Sign in to continue.");
  const u = session.user as typeof session.user & { plan?: string };
  const plan: Plan = u.plan === "plus" || u.plan === "pro" ? u.plan : "free";
  const user: AuthUser = { id: u.id, email: u.email, name: u.name, emailVerified: u.emailVerified, plan };
  c.set("user", user);
  return next();
};

export function rateLimit(binding: "API_LIMITER" | "INGEST_LIMITER"): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const limiter = c.env[binding];
    if (limiter) {
      const { success } = await limiter.limit({ key: `${binding}:${c.get("user").id}` });
      if (!success) throw new ApiError(429, "rate_limited", "Too many requests. Wait a minute and try again.");
    }
    return next();
  };
}

/** Reject oversized bodies before parsing. */
export function bodyLimit(maxBytes: number): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const len = Number(c.req.header("content-length") ?? "0");
    if (len > maxBytes) throw new ApiError(413, "payload_too_large", "That is too large to save.");
    return next();
  };
}
