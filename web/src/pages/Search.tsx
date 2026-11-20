import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { api, ApiError, sourceLabel, type SearchResult } from "../lib/api";
import { ItemListSkeleton, ItemRow } from "../components/ItemRow";
import { PageHeader } from "../components/Shell";
import { Button, Notice } from "../components/ui";

const PAGE = 20;

export function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q")?.trim() ?? "";
  const source = params.get("source") ?? "";
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [total, setTotal] = useState(0);
  const [degraded, setDegraded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [sources, setSources] = useState<{ source: string; count: number }[]>([]);

  useEffect(() => {
    api.sources().then((r) => setSources(r.sources)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!q) return;
    let cancelled = false;
    setResults(null);
    setError(null);
    setOffset(0);
    api
      .search({ q, source: source || undefined, limit: String(PAGE) })
      .then((r) => {
        if (cancelled) return;
        setResults(r.results);
        setTotal(r.total);
        setDegraded(r.degraded);
      })
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : "Search failed. Try again."));
    return () => {
      cancelled = true;
    };
  }, [q, source]);

  if (!q) {
    return (
      <>
        <PageHeader title="Search" />
        <p className="max-w-[60ch] text-ink-2">
          Type in the search box above. Describe what you remember, not only exact words: "how to price a developer tool" finds a saved thread about pricing even if it never uses that phrase.
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={`Results for "${q}"`}
        description={results ? (total === 0 ? undefined : `${total} saved ${total === 1 ? "item matches" : "items match"}.`) : undefined}
        actions={
          sources.length > 1 ? (
            <select
              aria-label="Filter by source"
              className="h-8 rounded-lg border border-line bg-raised px-2 text-[0.8125rem] text-ink"
              value={source}
              onChange={(e) => {
                const n = new URLSearchParams(params);
                if (e.target.value) n.set("source", e.target.value);
                else n.delete("source");
                setParams(n, { replace: true });
              }}
            >
              <option value="">All sources</option>
              {sources.map((s) => (
                <option key={s.source} value={s.source}>{sourceLabel(s.source)}</option>
              ))}
            </select>
          ) : undefined
        }
      />
      {degraded && (
        <div className="mb-4">
          <Notice tone="warn">Meaning-based search is unavailable right now, so these results match exact words only.</Notice>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {!results && !error && <ItemListSkeleton />}
      {results && results.length === 0 && (
        <div className="rounded-2xl border border-dashed border-line-strong px-6 py-10">
          <p className="font-medium text-ink">No saved items match "{q}".</p>
          <p className="mt-1 max-w-[60ch] text-[0.875rem] text-ink-2">
            Try fewer words, or describe the idea differently. Archived items are not searched.
          </p>
        </div>
      )}
      {results && results.length > 0 && (
        <>
          <ul className="-mx-4 grid gap-0.5" aria-label="Search results">
            {results.map((r) => (
              <ItemRow key={r.item.id} item={r.item} snippet={r.snippet || undefined} reason={r.reason} />
            ))}
          </ul>
          {offset + PAGE < total && (
            <div className="mt-4 flex justify-center">
              <Button
                loading={more}
                onClick={async () => {
                  setMore(true);
                  const next = offset + PAGE;
                  try {
                    const r = await api.search({ q, source: source || undefined, limit: String(PAGE), offset: String(next) });
                    setResults((prev) => [...(prev ?? []), ...r.results]);
                    setOffset(next);
                  } finally {
                    setMore(false);
                  }
                }}
              >
                More results
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
