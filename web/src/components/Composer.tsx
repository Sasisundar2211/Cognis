import { useId, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type Item } from "../lib/api";
import { Button, Input, Notice, Textarea } from "./ui";

const URL_RE = /^https?:\/\/\S+$/i;

/**
 * One input for both kinds of saving: paste a link, or write a note.
 * The form decides which by looking at the text, and says so before you save.
 */
export function Composer({ onSaved }: { onSaved: (item: Item, duplicate: boolean) => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const trimmed = text.trim();
  const isLink = URL_RE.test(trimmed);

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
        placeholder="Paste a link or write a note you want to remember"
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
          {trimmed ? (isLink ? "Cognis will read this page and save its text." : "Saves as a note.") : "Links are read and indexed. Notes are saved as written."}
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setMore((m) => !m)} aria-expanded={more}>
            {more ? "Fewer options" : "Title and tags"}
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={busy}>
            {isLink ? "Save link" : "Save"}
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
