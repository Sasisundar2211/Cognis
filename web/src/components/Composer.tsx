import { useId, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type Item } from "../lib/api";
import { Button, Input, Notice, Textarea } from "./ui";

const URL_RE = /^https?:\/\/\S+$/i;

/**
 * One input for both kinds of saving: paste a link, or write a note.
 * The form decides which by looking at the text, and says so before you save.
 */
export type BatchResult = { queued: number; duplicates: number; failed: { url: string; message: string }[] };

export function Composer({ onSaved, onBatch }: { onSaved: (item: Item, duplicate: boolean) => void; onBatch?: (r: BatchResult) => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const trimmed = text.trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const links = tokens.filter((t) => URL_RE.test(t));
  const isBatch = links.length > 1 && links.length === tokens.length;
  const isLink = !isBatch && URL_RE.test(trimmed);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!trimmed) {
      setError("Paste a link or write something first.");
      ref.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
    try {
      if (isBatch) {
        if (links.length > 50) throw new ApiError(422, "too_many", "Paste up to 50 links at a time.");
        const r = await api.batch(links, tagList);
        setText("");
        setTags("");
        onBatch?.({
          queued: r.queued,
          duplicates: r.results.filter((x) => x.duplicate).length,
          failed: r.results.filter((x) => x.error).map((x) => ({ url: x.url, message: x.error!.message })),
        });
        return;
      }
      const res = await api.createItem(
        isLink
          ? { kind: "url", url: trimmed, title: title || undefined, tags: tagList }
          : { kind: "note", content: trimmed, title: title || undefined, tags: tagList },
      );
      setText("");
      setTitle("");
      setTags("");
      setMore(false);
      onSaved(res.item, res.duplicate);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-line bg-raised p-3 shadow-raised" aria-label="Save to Cognis">
      <label htmlFor={`${id}-text`} className="sr-only">
        Paste a link or write a note
      </label>
      <Textarea
        id={`${id}-text`}
        ref={ref}
        rows={trimmed.length > 80 || trimmed.includes("\n") ? 5 : 2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e);
        }}
        placeholder="Paste saved post or reel links (one per line), or write a note"
        className="resize-none border-transparent bg-transparent px-2 text-[0.9375rem] focus:border-transparent focus:ring-0"
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-mode`}
        maxLength={100_000}
      />
      {more && (
        <div className="grid gap-2 px-2 pb-1 sm:grid-cols-2">
          <Input aria-label="Title (optional)" placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
          <Input aria-label="Tags, separated by commas" placeholder="Tags, separated by commas" value={tags} onChange={(e) => setTags(e.target.value)} maxLength={400} />
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-line px-2 pt-2.5">
        <p id={`${id}-mode`} className="text-[0.8125rem] text-ink-2" aria-live="polite">
          {trimmed
            ? isBatch
              ? `${links.length} links. Cognis imports each post, reel or page with its source.`
              : isLink
                ? "Cognis will read this link and save its content."
                : "Saves as a note."
            : "Paste a link, many links (one per line), or a note."}
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setMore((m) => !m)} aria-expanded={more}>
            {more ? "Fewer options" : "Title and tags"}
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={busy}>
            {isBatch ? `Import ${links.length} links` : isLink ? "Save link" : "Save"}
          </Button>
        </div>
      </div>
      {error && (
        <div className="mt-2 px-2">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </form>
  );
}
