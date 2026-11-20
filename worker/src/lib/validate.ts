import type { Context } from "hono";
import { z } from "zod";
import { ApiError } from "./errors";

const MAX_JSON_BYTES = 256_000;

export async function parseJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const text = await c.req.text();
  if (text.length > MAX_JSON_BYTES) throw new ApiError(413, "payload_too_large", "That is too large to save.");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Request body is not valid JSON.");
  }
  const res = schema.safeParse(data);
  if (!res.success) {
    throw new ApiError(422, "validation_failed", "Some fields are invalid.", {
      fields: res.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return res.data;
}

export function parseQuery<T extends z.ZodType>(c: Context, schema: T): z.infer<T> {
  const res = schema.safeParse(c.req.query());
  if (!res.success) {
    throw new ApiError(422, "validation_failed", "Some query parameters are invalid.", {
      fields: res.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return res.data;
}

export const idParam = z.string().regex(/^[a-z]{2,4}_[0-9a-f]{32}$/);
