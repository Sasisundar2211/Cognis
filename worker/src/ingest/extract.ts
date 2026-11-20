import { normalizeText } from "../lib/util";

export type Extracted = {
  title: string;
  description: string;
  siteName: string;
  text: string;
};

export const MAX_EXTRACTED_CHARS = 50_000;

const SKIP = "head, script, style, noscript, svg, template, iframe, nav, footer, header, form, aside, button, select";
const BLOCK = "p, div, li, h1, h2, h3, h4, h5, h6, br, tr, section, article, blockquote, pre";

/**
 * Extract readable text and metadata from HTML with the runtime's streaming HTMLRewriter.
 * Output is plain text. Markup, scripts and attributes are discarded, so stored
 * content stays inert data and never reaches a browser as HTML.
 */
export async function extractFromHtml(html: string): Promise<Extracted> {
  let title = "";
  let ogTitle = "";
  let description = "";
  let ogDescription = "";
  let siteName = "";
  let skipDepth = 0;
  let inTitle = false;
  const parts: string[] = [];
  let size = 0;

  const rewriter = new HTMLRewriter()
    .on("title", {
      element(el) {
        inTitle = true;
        el.onEndTag(() => {
          inTitle = false;
        });
      },
      text(t) {
        if (inTitle && title.length < 500) title += t.text;
      },
    })
    .on("meta", {
      element(el) {
        const name = (el.getAttribute("name") ?? el.getAttribute("property") ?? "").toLowerCase();
        const content = el.getAttribute("content") ?? "";
        if (name === "description" && !description) description = content;
        else if (name === "og:description" && !ogDescription) ogDescription = content;
        else if (name === "og:title" && !ogTitle) ogTitle = content;
        else if (name === "og:site_name" && !siteName) siteName = content;
      },
    })
    .on(SKIP, {
      element(el) {
        skipDepth++;
        try {
          el.onEndTag(() => {
            skipDepth--;
          });
        } catch {
          skipDepth--; // void element: no end tag
        }
      },
    })
    .on(BLOCK, {
      element() {
        if (skipDepth === 0) parts.push("\n");
      },
    })
    // Document-level text handler: works even when the page omits <html>/<body> tags.
    .onDocument({
      text(t) {
        if (skipDepth > 0 || inTitle || size > MAX_EXTRACTED_CHARS * 2) return;
        parts.push(t.text);
        size += t.text.length;
      },
    });

  await rewriter.transform(new Response(html, { headers: { "content-type": "text/html" } })).text();

  return {
    title: normalizeText(decodeEntities(ogTitle || title), 300),
    description: normalizeText(decodeEntities(ogDescription || description), 1000),
    siteName: normalizeText(decodeEntities(siteName), 100),
    text: normalizeText(decodeEntities(parts.join("")), MAX_EXTRACTED_CHARS),
  };
}

export function extractFromPlainText(body: string): Extracted {
  const text = normalizeText(body, MAX_EXTRACTED_CHARS);
  const firstLine = text.split("\n", 1)[0] ?? "";
  return { title: firstLine.slice(0, 200), description: "", siteName: "", text };
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Decode the common HTML entities HTMLRewriter leaves in text chunks. Result is still plain text. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8}|#39);/gi, (m, ent: string) => {
    const lower = ent.toLowerCase();
    if (lower in NAMED) return NAMED[lower]!;
    const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : lower.startsWith("#") ? parseInt(lower.slice(1), 10) : NaN;
    if (!Number.isFinite(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return m;
    return String.fromCodePoint(code);
  });
}
