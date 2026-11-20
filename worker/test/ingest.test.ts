import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { assertFetchableUrl, canonicalizeUrl, detectPlatform, UnsafeUrlError } from "../src/ingest/url-safety";
import { extractFromHtml } from "../src/ingest/extract";
import { FETCH_LIMITS, safeFetch } from "../src/ingest/fetch";
import { createItem, processItem } from "../src/knowledge/service";
import { call, newUser } from "./helpers";

function reason(u: string): string | null {
  try {
    assertFetchableUrl(u);
    return null;
  } catch (e) {
    return e instanceof UnsafeUrlError ? e.reason : "other";
  }
}

describe("URL safety (SSRF)", () => {
  it.each([
    ["http://localhost/", "single_label_host"],
    ["http://localhost./", "single_label_host"],
    ["http://foo.localhost/", "internal_host"],
    ["http://127.0.0.1/", "private_address"],
    ["http://2130706433/", "private_address"],
    ["http://0x7f.0.0.1/", "private_address"],
    ["http://0177.0.0.1/", "private_address"],
    ["http://10.1.2.3/", "private_address"],
    ["http://172.16.0.1/", "private_address"],
    ["http://192.168.1.1/", "private_address"],
    ["http://169.254.169.254/", "private_address"],
    ["http://100.64.0.1/", "private_address"],
    ["http://0.0.0.0/", "private_address"],
    ["http://8.8.8.8/", "ip_literal"],
    ["http://[::1]/", "ip_literal"],
    ["http://[::ffff:127.0.0.1]/", "ip_literal"],
    ["http://user:pw@example.com/", "credentials_in_url"],
    ["http://example.com:8080/", "non_default_port"],
    ["https://example.com:443/", null],
    ["ftp://example.com/", "unsupported_scheme"],
    ["file:///etc/passwd", "unsupported_scheme"],
    ["javascript:alert(1)", "unsupported_scheme"],
    ["data:text/html,hi", "unsupported_scheme"],
    ["http://metadata.google.internal/", "internal_host"],
    ["http://printer.local/", "internal_host"],
    ["not a url", "invalid_url"],
    ["https://" + "a".repeat(3000) + ".com", "invalid_url"],
    ["https://example.com/path?q=1", null],
    ["https://sub.example.co.uk/", null],
  ])("%s -> %s", (u, expected) => {
    expect(reason(u)).toBe(expected);
  });

  it("canonicalizes for dedup without merging distinct pages", () => {
    const c = (s: string) => canonicalizeUrl(new URL(s));
    expect(c("https://WWW.Example.com/a/?utm_source=x&b=2&a=1#frag")).toBe("https://example.com/a?a=1&b=2");
    expect(c("https://example.com/a")).toBe(c("https://www.example.com/a/"));
    expect(c("https://example.com/a?id=1")).not.toBe(c("https://example.com/a?id=2"));
  });

  it("labels platforms by hostname", () => {
    expect(detectPlatform(new URL("https://old.reddit.com/r/x"))).toBe("reddit");
    expect(detectPlatform(new URL("https://youtu.be/abc"))).toBe("youtube");
    expect(detectPlatform(new URL("https://notreddit.com/"))).toBe("web");
    expect(detectPlatform(new URL("https://reddit.com.evil.io/"))).toBe("web");
  });
});

const page = (html: string, headers: Record<string, string> = {}) =>
  new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

describe("safe fetch", () => {
  it("re-validates every redirect hop and refuses redirects to private hosts", async () => {
    const fetcher = (async (u: string) =>
      u.startsWith("https://public.example.com")
        ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } })
        : page("<p>secret</p>")) as unknown as typeof fetch;
    await expect(safeFetch(new URL("https://public.example.com/"), fetcher)).rejects.toMatchObject({ code: "redirect_private_address" });
  });

  it("follows a bounded number of public redirects", async () => {
    let n = 0;
    const fetcher = (async () => new Response(null, { status: 301, headers: { location: `https://example.com/${++n}` } })) as unknown as typeof fetch;
    await expect(safeFetch(new URL("https://example.com/"), fetcher)).rejects.toMatchObject({ code: "too_many_redirects" });
    expect(n).toBe(FETCH_LIMITS.maxRedirects + 1);
  });

  it("rejects non-text content types and truncates large bodies", async () => {
    const bin = (async () => new Response("x", { headers: { "content-type": "application/octet-stream" } })) as unknown as typeof fetch;
    await expect(safeFetch(new URL("https://example.com/"), bin)).rejects.toMatchObject({ code: "unsupported_content_type" });
    const big = (async () => page("a".repeat(FETCH_LIMITS.maxBytes + 5000))) as unknown as typeof fetch;
    const res = await safeFetch(new URL("https://example.com/"), big);
    expect(res.body.length).toBe(FETCH_LIMITS.maxBytes);
  });
});

describe("HTML extraction", () => {
  it("keeps readable text and drops scripts, styles, nav and markup", async () => {
    const ex = await extractFromHtml(`<!doctype html><html><head><title>Fallback</title>
      <meta property="og:title" content="Audience Building &amp; Distribution">
      <meta name="description" content="How to grow">
      <script>alert('x'); window.evil = 1</script><style>.a{color:red}</style></head>
      <body><nav>Home About</nav><header>Site header</header>
      <article><h1>Grow</h1><p>Post every day on <b>three</b> channels.</p><p>Measure &lt;replies&gt;.</p>
      <img src=x onerror="alert(1)"><br><form><input value="secret"></form></article>
      <footer>Copyright</footer><svg><text>svgtext</text></svg></body></html>`);
    expect(ex.title).toBe("Audience Building & Distribution");
    expect(ex.description).toBe("How to grow");
    expect(ex.text).toContain("Post every day on three channels.");
    expect(ex.text).toContain("Measure <replies>.");
    for (const bad of ["alert", "color:red", "Home About", "Site header", "Copyright", "svgtext", "onerror", "secret"]) {
      expect(ex.text).not.toContain(bad);
    }
  });
});

describe("URL ingestion pipeline", () => {
  it("fetches, extracts, embeds and marks ready; failures are recorded and retryable", async () => {
    const { cookie } = await newUser("ingest");
    const me = (await (await call("/api/v1/me", { cookie })).json()) as { user: { id: string; email: string; name: string; emailVerified: boolean; plan: "free" } };
    const user = me.user;

    const ok = await createItem(env, user, { kind: "url", url: "https://blog.example.com/post?utm_source=tw" });
    const fetcherOk = (async () => page("<title>Reddit growth playbook</title><p>Use subreddits for launch feedback.</p>")) as unknown as typeof fetch;
    const done = await processItem(env, user.id, ok.row.id, fetcherOk);
    expect(done.status).toBe("ready");
    expect(done.title).toBe("Reddit growth playbook");
    expect(done.extracted_text).toContain("subreddits");
    expect(done.embedding_model).toBe("test-hash-trigram");

    const dup = await createItem(env, user, { kind: "url", url: "https://www.blog.example.com/post/" });
    expect(dup.duplicate).toBe(true);

    const bad = await createItem(env, user, { kind: "url", url: "https://down.example.com/" });
    const fetcher500 = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const failed = await processItem(env, user.id, bad.row.id, fetcher500);
    expect(failed.status).toBe("failed");
    expect(failed.error_code).toBe("http_503");
    const retried = await processItem(env, user.id, bad.row.id, fetcherOk);
    expect(retried.status).toBe("ready");
  });

  it("stops retrying after the attempt limit", async () => {
    const { cookie } = await newUser("retry");
    const me = (await (await call("/api/v1/me", { cookie })).json()) as { user: { id: string; email: string; name: string; emailVerified: boolean; plan: "free" } };
    const r = await createItem(env, me.user, { kind: "url", url: "https://flaky.example.com/" });
    const f = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    for (let i = 0; i < 7; i++) await processItem(env, me.user.id, r.row.id, f);
    const row = await env.DB.prepare("SELECT attempts, status FROM knowledge_items WHERE id = ?").bind(r.row.id).first<{ attempts: number; status: string }>();
    expect(row).toEqual({ attempts: 5, status: "failed" });
  });
});
