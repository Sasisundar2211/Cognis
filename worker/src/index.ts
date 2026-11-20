import { Hono } from "hono";
import type { AppBindings, Env } from "./env";
import { createAuth } from "./auth";
import { ApiError, errorResponse } from "./lib/errors";
import { csrfGuard, rateLimit, requestId, requireUser, securityHeaders } from "./middleware";
import { items } from "./routes/items";
import { searchRoute } from "./routes/search";
import { collections } from "./routes/collections";
import { account } from "./routes/account";

export const app = new Hono<AppBindings>();

app.use("/api/*", requestId, securityHeaders);
app.onError((err, c) => errorResponse(c, err));

app.get("/api/v1/health", (c) => c.json({ status: "ok" }));
app.get("/api/v1/ready", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1 FROM knowledge_items LIMIT 1").first();
    return c.json({ status: "ready", database: "ok", embeddings: c.env.EMBEDDER !== "none" && (c.env.AI !== undefined || c.env.EMBEDDER === "test-hash") ? "configured" : "unavailable" });
  } catch {
    return c.json({ status: "not_ready", database: "error" }, 503);
  }
});

// Better Auth owns /api/auth/*. It performs its own origin checks against trustedOrigins.
app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));

const v1 = new Hono<AppBindings>();
v1.use("*", csrfGuard, requireUser, rateLimit("API_LIMITER"));
v1.route("/items", items);
v1.route("/search", searchRoute);
v1.route("/collections", collections);
v1.route("/", account);
app.route("/api/v1", v1);

app.all("/api/*", (c) => errorResponse(c, new ApiError(404, "not_found", "No such endpoint.")));

// Everything else is the single-page app, served from static assets.
app.all("*", async (c) => {
  if (!c.env.ASSETS) return c.text("Not found", 404);
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
} satisfies ExportedHandler<Env>;
