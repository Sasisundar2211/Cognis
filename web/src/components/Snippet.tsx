/**
 * Renders a search snippet. The server wraps matched terms in \u0002 ... \u0003.
 * Content is rendered as React text nodes only, never as HTML.
 */
export function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\u0002[^\u0003]*\u0003)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("\u0002") ? (
          <mark key={i} className="rounded-sm bg-primary-soft px-0.5 text-primary-soft-ink">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}
