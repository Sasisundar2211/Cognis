import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, ApiError, sourceLabel, type Collection, type Item } from "../lib/api";
import { Composer } from "../components/Composer";
import { ItemListSkeleton, ItemRow } from "../components/ItemRow";
import { PageHeader } from "../components/Shell";
import { Button, Notice } from "../components/ui";

const selectCls =
  "h-8 rounded-lg border border-line bg-raised px-2 text-[0.8125rem] text-ink focus:border-primary focus:outline-none focus:ring-3 focus:ring-primary/20";

export function Library() {
  const [params, setParams] = useSearchParams();
  const filters = {
    source: params.get("source") ?? undefined,
    tag: params.get("tag") ?? undefined,
    collection: params.get("collection") ?? undefined,
    status: params.get("status") ?? undefined,
    archived: params.get("archived") === "true" ? "true" : undefined,
  };
  const key = JSON.stringify(filters);

  const [items, setItems] = useState<Item[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [sources, setSources] = useState<{ source: string; count: number }[]>([]);
  const [tags, setTags] = useState<{ name: string; count: number }[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const polls = useRef(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.listItems(filters);
      setItems(res.items);
      setCursor(res.nextCursor);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load your library.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const loadFacets = useCallback(() => {
    api.sources().then((r) => setSources(r.sources)).catch(() => undefined);
    api.tags().then((r) => setTags(r.tags)).catch(() => undefined);
    api.collections().then((r) => setCollections(r.collections)).catch(() => undefined);
  }, []);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);
  useEffect(loadFacets, [loadFacets]);

  // Links import in the background. Re-check a few times while any item is still importing.
  useEffect(() => {
    if (!items?.some((i) => i.status === "pending" || i.status === "processing")) {
      polls.current = 0;
      return;
    }
    if (polls.current > 20) return;
    const t = setTimeout(() => {
      polls.current++;
      void load();
    }, 2500);
    return () => clearTimeout(t);
  }, [items, load]);

  function setFilter(name: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  }

  const activeCollection = collections.find((c) => c.id === filters.collection);
  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <>
      <PageHeader
        title={activeCollection ? activeCollection.name : filters.archived ? "Archive" : "Library"}
        description={activeCollection?.description || (filters.archived ? "Items you archived. They stay out of search until you restore them." : "Everything you have saved, newest first.")}
      />
      {!filters.archived && (
        <div className="mb-6">
          <Composer
            onBatch={(r) => {
              const parts = [`Importing ${r.queued} link${r.queued === 1 ? "" : "s"}. They fill in as each one finishes.`];
              if (r.duplicates) parts.push(`${r.duplicates} already saved.`);
              if (r.failed.length) parts.push(`${r.failed.length} skipped: ${r.failed.slice(0, 3).map((f) => f.message).join(" ")}`);
              setFlash(parts.join(" "));
              void load();
              loadFacets();
            }}
            onSaved={(item, duplicate) => {
              setFlash(duplicate ? "You already saved this. Showing the existing item." : item.kind === "url" ? "Saved. Cognis is reading the page now." : "Saved.");
              void load();
              loadFacets();
            }}
          />
          {flash && (
            <div className="mt-3">
              <Notice tone="success" action={<button className="text-[0.8125rem] underline" onClick={() => setFlash(null)}>Dismiss</button>}>
                {flash}
              </Notice>
            </div>
          )}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
        <label className="sr-only" htmlFor="f-source">Source</label>
        <select id="f-source" className={selectCls} value={filters.source ?? ""} onChange={(e) => setFilter("source", e.target.value)}>
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s.source} value={s.source}>
              {sourceLabel(s.source)} ({s.count})
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="f-tag">Tag</label>
        <select id="f-tag" className={selectCls} value={filters.tag ?? ""} onChange={(e) => setFilter("tag", e.target.value)}>
          <option value="">All tags</option>
          {tags.map((t) => (
            <option key={t.name} value={t.name}>
              #{t.name} ({t.count})
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="f-col">Collection</label>
        <select id="f-col" className={selectCls} value={filters.collection ?? ""} onChange={(e) => setFilter("collection", e.target.value)}>
          <option value="">All collections</option>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.itemCount})
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="f-status">Import status</label>
        <select id="f-status" className={selectCls} value={filters.status ?? ""} onChange={(e) => setFilter("status", e.target.value)}>
          <option value="">Any status</option>
          <option value="ready">Ready</option>
          <option value="pending">Queued</option>
          <option value="processing">Importing</option>
          <option value="failed">Failed</option>
        </select>
        <Button size="sm" variant="ghost" onClick={() => setFilter("archived", filters.archived ? "" : "true")} aria-pressed={!!filters.archived}>
          {filters.archived ? "Back to library" : "View archive"}
        </Button>
        {hasFilters && (
          <Button size="sm" variant="ghost" onClick={() => setParams({}, { replace: true })}>
            Clear filters
          </Button>
        )}
      </div>

      {error && (
        <Notice tone="error" action={<Button size="sm" onClick={() => void load()}>Retry</Button>}>
          {error}
        </Notice>
      )}
      {!items && !error && <ItemListSkeleton />}
      {items && items.length === 0 && (
        <EmptyLibrary filtered={hasFilters} />
      )}
      {items && items.length > 0 && (
        <>
          <ul className="-mx-4 grid gap-0.5" aria-label="Saved items">
            {items.map((i) => (
              <ItemRow key={i.id} item={i} />
            ))}
          </ul>
          {cursor && (
            <div className="mt-4 flex justify-center">
              <Button
                loading={loadingMore}
                onClick={async () => {
                  setLoadingMore(true);
                  try {
                    const res = await api.listItems({ ...filters, cursor });
                    setItems((prev) => [...(prev ?? []), ...res.items]);
                    setCursor(res.nextCursor);
                  } finally {
                    setLoadingMore(false);
                  }
                }}
              >
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function EmptyLibrary({ filtered }: { filtered: boolean }) {
  if (filtered) {
    return (
      <div className="rounded-2xl border border-dashed border-line-strong px-6 py-10 text-center">
        <p className="font-medium text-ink">Nothing matches these filters.</p>
        <p className="mt-1 text-[0.875rem] text-ink-2">Clear a filter or two to see more of your library.</p>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-dashed border-line-strong px-6 py-10">
      <p className="font-medium text-ink">Your library is empty.</p>
      <p className="mt-1 max-w-[60ch] text-[0.875rem] text-ink-2">
        Paste a link you saved somewhere else, like a Reddit thread or a Substack post, into the box above. Cognis reads the page, keeps the source, and makes it findable by words and by meaning.
      </p>
      <p className="mt-3 text-[0.875rem]">
        <Link to="/help" className="font-medium text-primary hover:underline">How Cognis works</Link>
      </p>
    </div>
  );
}
