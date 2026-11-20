import type { Context } from "hono";

/** Structured API error. `code` is stable and machine-readable; `message` is safe to show users. */
export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 502 | 503,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function errorResponse(c: Context, err: unknown) {
  const requestId = (c.get("requestId") as string | undefined) ?? "unknown";
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details, requestId } }, err.status);
  }
  // Never echo internal error messages or stack traces: they can contain user content.
  console.error(JSON.stringify({ level: "error", requestId, kind: err instanceof Error ? err.name : typeof err }));
  return c.json({ error: { code: "internal_error", message: "Something went wrong.", requestId } }, 500);
}
