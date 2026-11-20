import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api, ApiError, type Collection } from "../lib/api";
import { PageHeader } from "../components/Shell";
import { Button, Input, Notice } from "../components/ui";

export function Collections() {
  const [list, setList] = useState<Collection[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = () => api.collections().then((r) => setList(r.collections)).catch((e) => setError(e instanceof ApiError ? e.message : "Could not load collections."));
  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createCollection(name.trim());
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the collection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Collections" description="Group saved items by project or topic. An item can be in several collections. Deleting a collection keeps its items." />
      <form onSubmit={create} className="mb-6 flex max-w-lg gap-2">
        <label htmlFor="new-col" className="sr-only">New collection name</label>
        <Input id="new-col" placeholder="New collection, for example: Launch marketing" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>Create</Button>
      </form>
      {error && <div className="mb-4"><Notice tone="error">{error}</Notice></div>}
      {!list && <div className="skeleton h-24 w-full" aria-hidden="true" />}
      {list && list.length === 0 && (
        <p className="max-w-[60ch] text-ink-2">No collections yet. Create one above, then add items to it from any item's page.</p>
      )}
      {list && list.length > 0 && (
        <ul className="divide-y divide-line rounded-2xl border border-line">
          {list.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              {renaming === c.id ? (
                <form
                  className="flex flex-1 gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      await api.updateCollection(c.id, { name: renameValue });
                      setRenaming(null);
                      await load();
                    } catch (err) {
                      setError(err instanceof ApiError ? err.message : "Could not rename.");
                    }
                  }}
                >
                  <label htmlFor={`rn-${c.id}`} className="sr-only">Collection name</label>
                  <Input id={`rn-${c.id}`} autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)} maxLength={80} />
                  <Button size="sm" type="submit" variant="primary">Save</Button>
                  <Button size="sm" type="button" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
                </form>
              ) : (
                <>
                  <Link to={`/app?collection=${c.id}`} className="min-w-0 font-medium text-ink hover:text-primary">
                    {c.name}
                    <span className="ml-2 text-[0.8125rem] font-normal text-ink-2">{c.itemCount} {c.itemCount === 1 ? "item" : "items"}</span>
                  </Link>
                  <div className="flex gap-1">
                    {confirm === c.id ? (
                      <>
                        <Button size="sm" variant="danger" onClick={async () => { await api.deleteCollection(c.id); setConfirm(null); await load(); }}>Delete collection</Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => { setRenaming(c.id); setRenameValue(c.name); }}>Rename</Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirm(c.id)}>Delete</Button>
                      </>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
