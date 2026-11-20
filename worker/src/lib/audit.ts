import { newId, nowIso } from "./util";

/** Record a security-relevant event. Never pass content, emails, IPs or tokens in `detail`. */
export async function audit(db: D1Database, userId: string | null, event: string, detail: Record<string, string | number | boolean> = {}) {
  await db
    .prepare("INSERT INTO audit_events (id, user_id, event, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(newId("evt"), userId, event, JSON.stringify(detail), nowIso())
    .run();
}
