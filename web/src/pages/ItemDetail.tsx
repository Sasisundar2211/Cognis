import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, hostOf, ingestError, relativeTime, safeHref, sourceLabel, type Collection, type Item } from "../lib/api";
import { Button, Field, Input, Notice, SourceBadge, StatusBadge, Textarea } from "../components/ui";

export function ItemDetail() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const [item, setItem] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [showText, setShowText] = useState(false);

  useEffect(() => {
    let cancel = false;
    setItem(null);
    api
      .getItem(id)
      .then((r) => !cancel && setItem(r.item))
      .catch((e) => {
        if (cancel) return;
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setError(e instanceof ApiError ? e.message : "Could not load this item.");
      });
    api.collections().then((r) => !cancel && setCollections(r.collections)).catch(() => undefined);
    return () => {
      cancel = true;
    };
  }, [id]);

  useEffect(() => {
    if (item && (item.status === "pending" || item.status === "processing")) {
      const t = setTimeout(() => api.getItem(id).then((r) => setItem(r.item)).catch(() => undefined), 2500);
      return () => clearTimeout(t);
    }
  }, [item, id]);

  if (notFound) {
    return (
      <div className="py-10">
        <h1 className="text-[1.25rem] font-semibold text-ink">Item not found</h1>
        <p className="mt-1 text-ink-2">It may have been deleted.</p>
        <Link to="/app" className="mt-4 inline-block font-medium text-primary hover:underline">Back to library</Link>
      </div>
    );
  }
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!item) {
    return (
      <div aria-hidden="true">
        <div className="skeleton h-3 w-48" />
        <div className="skeleton mt-4 h-7 w-2/3" />
        <div className="skeleton mt-6 h-32 w-full" />
      </div>
    );
  }

  const href = safeHref(item.originalUrl);
  const host = hostOf(item.originalUrl);

  async function save() {
    if (!item) return;
    setSaving(true);
    try {
      const r = await api.updateItem(item.id, {
        title,
        ...(item.kind !== "url" ? { content } : {}),
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      });
      setItem(r.item);
      setEditing(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save changes.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleCollection(c: Collection, member: boolean) {
    if (!item) return;
    if (member) await api.removeFromCollection(c.id, item.id);
    else await api.addToCollection(c.id, item.id);
    const r = await api.getItem(item.id);
    setItem(r.item);
  }

  return (
    <article>
      <Link to="/app" className="text-[0.8125rem] text-ink-2 hover:text-ink">← Library</Link>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-[0.8125rem] text-ink-2">
        <SourceBadge source={sourceLabel(item.sourcePlatform)} />
        <time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>Saved {relativeTime(item.createdAt)}</time>
        <StatusBadge status={item.status} />
        {item.archived && <span className="rounded-md bg-panel px-1.5 text-[0.75rem]">Archived</span>}
      </div>

      {editing ? (
        <div className="mt-4 grid gap-4">
          <Field label="Title" htmlFor="title">
            <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
          </Field>
          {item.kind !== "url" && (
            <Field label="Text" htmlFor="content">
              <Textarea id="content" rows={10} value={content} onChange={(e) => setContent(e.target.value)} maxLength={100_000} />
            </Field>
          )}
          <Field label="Tags" htmlFor="tags" hint="Separate tags with commas.">
            <Input id="tags" value={tags} onChange={(e) => setTags(e.target.value)} maxLength={400} />
          </Field>
          <div className="flex gap-2">
            <Button variant="primary" loading={saving} onClick={save}>Save changes</Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <>
          <h1 className="mt-3 text-[1.625rem] leading-tight font-semibold text-ink">{item.title || host || "Untitled"}</h1>
          {href && (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="mt-2 inline-flex items-center gap-1 text-[0.875rem] font-medium text-primary hover:underline">
              Open original on {host} <span aria-hidden="true">↗</span>
            </a>
          )}
          {item.tags.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2" aria-label="Tags">
              {item.tags.map((t) => (
                <li key={t}>
                  <Link to={`/app?tag=${encodeURIComponent(t)}`} className="text-[0.8125rem] text-ink-2 hover:text-primary">#{t}</Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {item.status === "failed" && (
        <div className="mt-5">
          <Notice
            tone="error"
            action={
              <Button
                size="sm"
                loading={busy === "retry"}
                onClick={async () => {
                  setBusy("retry");
                  try {
                    setItem((await api.retryItem(item.id)).item);
                  } catch (e) {
                    setError(e instanceof ApiError ? e.message : "Retry failed.");
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Try again
              </Button>
            }
          >
            {ingestError(item.errorCode)} The link is saved, so it still shows up when you search for its title or your note.
          </Notice>
        </div>
      )}
      {(item.status === "pending" || item.status === "processing") && (
        <div className="mt-5">
          <Notice>Cognis is reading this page. This usually takes a few seconds.</Notice>
        </div>
      )}

      {!editing && (
        <div className="mt-6 grid gap-6">
          {item.description && <p className="max-w-[70ch] text-[1rem] text-ink-2">{item.description}</p>}
          {item.content && (
            <section aria-label={item.kind === "url" ? "Your note" : "Text"}>
              {item.kind === "url" && <h2 className="mb-1.5 text-[0.8125rem] font-medium text-ink-2">Your note</h2>}
              <p className="max-w-[70ch] whitespace-pre-wrap text-ink">{item.content}</p>
            </section>
          )}
          {item.extractedText && (
            <section>
              <button className="text-[0.8125rem] font-medium text-ink-2 hover:text-ink" aria-expanded={showText} onClick={() => setShowText((s) => !s)}>
                {showText ? "Hide page text" : `Show the page text Cognis saved (${item.extractedText.length.toLocaleString()} characters)`}
              </button>
              {showText && <p className="mt-2 max-h-[28rem] max-w-[70ch] overflow-auto rounded-xl bg-panel p-4 text-[0.875rem] whitespace-pre-wrap text-ink-2">{item.extractedText}</p>}
            </section>
          )}
        </div>
      )}

      {collections.length > 0 && (
        <section className="mt-8 border-t border-line pt-5">
          <h2 className="text-[0.875rem] font-semibold text-ink">Collections</h2>
          <ul className="mt-2 flex flex-wrap gap-2">
            {collections.map((c) => {
              const member = item.collections.includes(c.id);
              return (
                <li key={c.id}>
                  <button
                    onClick={() => void toggleCollection(c, member)}
                    aria-pressed={member}
                    className={`h-8 rounded-lg border px-3 text-[0.8125rem] transition-colors duration-150 ${member ? "border-primary bg-primary-soft text-primary-soft-ink" : "border-line text-ink-2 hover:border-line-strong hover:text-ink"}`}
                  >
                    {member ? "✓ " : "+ "}
                    {c.name}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-2 border-t border-line pt-5">
        {!editing && (
          <Button
            onClick={() => {
              setTitle(item.title);
              setContent(item.content);
              setTags(item.tags.join(", "));
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )}
        <Button
          loading={busy === "archive"}
          onClick={async () => {
            setBusy("archive");
            try {
              setItem((await api.updateItem(item.id, { archived: !item.archived })).item);
            } finally {
              setBusy(null);
            }
          }}
        >
          {item.archived ? "Restore from archive" : "Archive"}
        </Button>
        {confirmDelete ? (
          <span className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm delete">
            <span className="text-[0.875rem] text-ink">Delete permanently?</span>
            <Button
              variant="danger"
              loading={busy === "delete"}
              onClick={async () => {
                setBusy("delete");
                await api.deleteItem(item.id);
                nav("/app", { replace: true });
              }}
            >
              Delete
            </Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep it</Button>
          </span>
        ) : (
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete</Button>
        )}
      </div>
    </article>
  );
}
