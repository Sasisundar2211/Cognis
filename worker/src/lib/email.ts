import type { Env } from "../env";

export type OutgoingEmail = { to: string; subject: string; text: string };

/** Test-only sink. Populated only when EMAIL_MODE is "capture" and APP_ENV is "test". */
export const capturedEmails: OutgoingEmail[] = [];

export async function sendEmail(env: Env, msg: OutgoingEmail): Promise<void> {
  if (env.EMAIL_MODE === "capture") {
    if (env.APP_ENV !== "test") throw new Error("capture mode is test-only");
    capturedEmails.push(msg);
    return;
  }
  if (env.EMAIL_MODE === "resend") {
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error("email not configured");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text }),
    });
    if (!res.ok) throw new Error(`email provider status ${res.status}`);
    return;
  }
  // "disabled": no provider configured. Never log the message, it contains a secret link.
}
