export type Item = {
  id: string;
  kind: "url" | "text" | "note" | "capture";
  title: string;
  originalUrl: string | null;
  sourcePlatform: string;
  description: string;
  content: string;
  extractedText: string;
  metadata: Record<string, unknown>;
  status: "pending" | "processing" | "ready" | "failed";
  errorCode: string | null;
  archived: boolean;
  hasEmbedding: boolean;
  tags: string[];
  collections: string[];
  createdAt: string;
  updatedAt: string;
  ingestedAt: string | null;
};

export type Collection = { id: string; name: string; description: string; itemCount: number; createdAt: string; updatedAt: string };
export type SearchResult = { item: Item; snippet: string; reason: string };
export type Me = {
  user: { id: string; email: string; name: string; emailVerified: boolean; plan: "free" | "plus" | "pro" };
  usage: { items: number; collections: number };
  limits: { maxItems: number; maxCollections: number; maxUrlIngestPerDay: number };
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { ...init, headers, body, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "network", "Cognis could not reach the server. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string; details?: unknown } } | null;
  if (!res.ok) {
    if (res.status === 401 && !location.pathname.startsWith("/sign-in")) {
      location.assign(`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`);
    }
    throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.message ?? "Something went wrong.", data?.error?.details);
  }
  return data as T;
}

export const api = {
  me: () => request<Me>("/me"),
  listItems: (params: Record<string, string | undefined> = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return request<{ items: Item[]; nextCursor: string | null }>(`/items?${q}`);
  },
  getItem: (id: string) => request<{ item: Item }>(`/items/${encodeURIComponent(id)}`),
  createItem: (input: Record<string, unknown>) => request<{ item: Item; duplicate: boolean }>("/items", { method: "POST", json: input }),
  batch: (urls: string[], tags: string[] = []) =>
    request<{ queued: number; results: { url: string; itemId?: string; duplicate?: boolean; error?: { code: string; message: string } }[] }>("/items/batch", { method: "POST", json: { urls, tags } }),
  updateItem: (id: string, patch: Record<string, unknown>) => request<{ item: Item }>(`/items/${encodeURIComponent(id)}`, { method: "PATCH", json: patch }),
  deleteItem: (id: string) => request<void>(`/items/${encodeURIComponent(id)}`, { method: "DELETE" }),
  retryItem: (id: string) => request<{ item: Item }>(`/items/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  search: (params: Record<string, string | undefined>) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return request<{ results: SearchResult[]; total: number; mode: string; degraded: boolean }>(`/search?${q}`);
  },
  tags: () => request<{ tags: { name: string; count: number }[] }>("/tags"),
  sources: () => request<{ sources: { source: string; count: number }[] }>("/sources"),
  collections: () => request<{ collections: Collection[] }>("/collections"),
  createCollection: (name: string, description = "") => request<{ collection: Collection }>("/collections", { method: "POST", json: { name, description } }),
  updateCollection: (id: string, patch: { name?: string; description?: string }) => request<{ collection: Collection }>(`/collections/${id}`, { method: "PATCH", json: patch }),
  deleteCollection: (id: string) => request<void>(`/collections/${id}`, { method: "DELETE" }),
  addToCollection: (id: string, itemId: string) => request<void>(`/collections/${id}/items/${itemId}`, { method: "PUT" }),
  removeFromCollection: (id: string, itemId: string) => request<void>(`/collections/${id}/items/${itemId}`, { method: "DELETE" }),
  exportUrl: "/api/v1/export",
};

export const SOURCE_LABELS: Record<string, string> = {
  web: "Web", manual: "Note", browser: "Browser", reddit: "Reddit", github: "GitHub", youtube: "YouTube",
  linkedin: "LinkedIn", x: "X", substack: "Substack", instagram: "Instagram", medium: "Medium",
};

export function sourceLabel(s: string) {
  return SOURCE_LABELS[s] ?? s;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export function relativeTime(iso: string): string {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return "just now";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), "month");
  return rtf.format(Math.round(diff / (86400 * 365)), "year");
}

export function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Only http(s) links become clickable. Stored URLs are validated server-side; this is defense in depth. */
export function safeHref(url: string | null): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export const ERROR_TEXT: Record<string, string> = {
  fetch_timeout: "The site took too long to respond.",
  fetch_failed: "Cognis could not reach the site.",
  unsupported_content_type: "This link is not a web page Cognis can read (for example a PDF or image).",
  too_many_redirects: "The link redirected too many times.",
  extract_failed: "Cognis could not read the page content.",
  http_403: "The site refused the request. It may block automated reading.",
  http_404: "The page was not found.",
  http_429: "The site is rate limiting requests. Cognis will retry automatically.",
  login_wall: "This platform only shows the post to signed-in visitors, so Cognis could not read it. The link is saved; add a note with what it said.",
  parse_failed: "The platform answered in an unexpected format.",
};

export function ingestError(code: string | null): string {
  if (!code) return "";
  if (ERROR_TEXT[code]) return ERROR_TEXT[code]!;
  if (code.startsWith("redirect_")) return "The link redirected to an address Cognis will not open.";
  if (code.startsWith("http_5")) return "The site had a server error. Try again later.";
  if (code.startsWith("http_")) return `The site answered with error ${code.slice(5)}.`;
  return "Cognis could not import this link.";
}
