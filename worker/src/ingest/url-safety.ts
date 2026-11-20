/**
 * URL validation and canonicalization for user-submitted links.
 *
 * SSRF defense in depth. Cloudflare Workers cannot reach private networks of
 * our own (we run none), but we still refuse anything that is not a public
 * http(s) URL on a default port, so the code stays safe if the runtime changes.
 */

export class UnsafeUrlError extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

const MAX_URL_LENGTH = 2048;
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet", ".arpa"];
const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src|_hsenc|_hsmi|yclid)$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4ToInt(host: string): number | null {
  const m = host.match(IPV4_RE);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function inRange(ip: number, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const baseInt = ipv4ToInt(base!)!;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

const PRIVATE_V4 = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15",
  "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
];

/**
 * Validate a URL for server-side fetching. Rejects:
 * non-http(s) schemes, credentials, non-default ports, IP literals
 * (all IPv6 and private/reserved IPv4), single-label and internal hostnames.
 * The WHATWG URL parser normalizes decimal, octal and hex IPv4 forms
 * (http://2130706433/ becomes 127.0.0.1), so those are caught as IPv4.
 */
export function assertFetchableUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    throw new UnsafeUrlError("invalid_url");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError("invalid_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeUrlError("unsupported_scheme");
  if (url.username || url.password) throw new UnsafeUrlError("credentials_in_url");
  if (url.port !== "") throw new UnsafeUrlError("non_default_port");

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || host.includes(":")) throw new UnsafeUrlError("ip_literal");
  const v4 = ipv4ToInt(host);
  if (v4 !== null) {
    if (PRIVATE_V4.some((c) => inRange(v4, c))) throw new UnsafeUrlError("private_address");
    throw new UnsafeUrlError("ip_literal");
  }
  if (!host.includes(".")) throw new UnsafeUrlError("single_label_host");
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrlError("internal_host");
  }
  if (!/^[a-z0-9.-]+$/.test(host)) throw new UnsafeUrlError("invalid_host");
  return url;
}

/** Canonical form used for duplicate detection. Drops fragment and tracking params, sorts the query. */
export function canonicalizeUrl(url: URL): string {
  const u = new URL(url.toString());
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  return u.toString();
}

/** Best-effort platform label from the hostname. Used for filtering, never for trust decisions. */
export function detectPlatform(url: URL): string {
  const h = url.hostname.toLowerCase().replace(/^www\./, "");
  const map: [RegExp, string][] = [
    [/(^|\.)reddit\.com$/, "reddit"],
    [/(^|\.)github\.com$/, "github"],
    [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube"],
    [/(^|\.)linkedin\.com$/, "linkedin"],
    [/(^|\.)(x\.com|twitter\.com)$/, "x"],
    [/(^|\.)substack\.com$/, "substack"],
    [/(^|\.)instagram\.com$/, "instagram"],
    [/(^|\.)medium\.com$/, "medium"],
  ];
  for (const [re, name] of map) if (re.test(h)) return name;
  return "web";
}
