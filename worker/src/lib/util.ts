export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return `${prefix}_${s}`;
}

export const nowIso = () => new Date().toISOString();

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Collapse whitespace and strip control characters (keeps \n). */
export function normalizeText(input: string, maxLen: number): string {
  return input
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLen);
}
