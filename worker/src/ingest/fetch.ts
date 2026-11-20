import { assertFetchableUrl, UnsafeUrlError } from "./url-safety";

export const FETCH_LIMITS = {
  maxBytes: 1_000_000,
  timeoutMs: 8_000,
  maxRedirects: 3,
} as const;

const ALLOWED_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

export class FetchError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export type FetchedPage = { finalUrl: URL; contentType: string; body: string };

/**
 * Fetch a public web page safely.
 * Every redirect hop is re-validated, so a public URL cannot bounce us to a private one.
 * The body is read as a stream and cut off at maxBytes.
 */
export async function safeFetch(startUrl: URL, fetcher: typeof fetch = fetch): Promise<FetchedPage> {
  let url = startUrl;
  for (let hop = 0; hop <= FETCH_LIMITS.maxRedirects; hop++) {
    let res: Response;
    try {
      res = await fetcher(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_LIMITS.timeoutMs),
        headers: {
          "User-Agent": "CognisBot/0.1 (+personal knowledge import; fetches only links a user saved)",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
        },
      });
    } catch (e) {
      throw new FetchError(e instanceof Error && e.name === "TimeoutError" ? "fetch_timeout" : "fetch_failed");
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel();
      if (!loc) throw new FetchError("redirect_without_location");
      try {
        url = assertFetchableUrl(new URL(loc, url).toString());
      } catch (e) {
        throw new FetchError(e instanceof UnsafeUrlError ? `redirect_${e.reason}` : "redirect_invalid");
      }
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel();
      throw new FetchError(`http_${res.status}`);
    }

    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!ALLOWED_TYPES.includes(contentType)) {
      await res.body?.cancel();
      throw new FetchError("unsupported_content_type");
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > FETCH_LIMITS.maxBytes * 4) {
      await res.body?.cancel();
      throw new FetchError("too_large");
    }

    const body = await readCapped(res, FETCH_LIMITS.maxBytes);
    return { finalUrl: url, contentType, body };
  }
  throw new FetchError("too_many_redirects");
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    if (value.byteLength >= room) {
      chunks.push(value.subarray(0, room));
      total += room;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}
