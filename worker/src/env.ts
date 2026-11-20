export interface Env {
  DB: D1Database;
  AI?: Ai;
  ASSETS?: Fetcher;
  API_LIMITER?: RateLimit;
  INGEST_LIMITER?: RateLimit;
  APP_ENV: "production" | "staging" | "development" | "test";
  /** "disabled": no email sent, verification not required. "resend": send via Resend. "capture": tests only. */
  EMAIL_MODE: "disabled" | "resend" | "capture";
  /** "workers-ai": Cloudflare Workers AI bge-small-en-v1.5. "test-hash": deterministic test double. "none": lexical only. */
  EMBEDDER: "workers-ai" | "test-hash" | "none";
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}

export type AuthUser = { id: string; email: string; name: string; emailVerified: boolean; plan: Plan };
export type Plan = "free" | "plus" | "pro";

export type AppBindings = { Bindings: Env; Variables: { user: AuthUser; requestId: string } };
