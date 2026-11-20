import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Item } from "../lib/api";
import { Composer } from "../components/Composer";
import { Button } from "../components/ui";

/** First-run onboarding. Three real steps: understand privacy, save one thing, find it again. */
export function Welcome() {
  const nav = useNavigate();
  const [saved, setSaved] = useState<Item | null>(null);

  return (
    <div className="max-w-2xl">
      <h1 className="text-[1.625rem] font-semibold text-ink">Welcome to Cognis</h1>
      <p className="mt-2 max-w-[60ch] text-ink-2">
        Cognis keeps the things you save, with their source, and finds them again when you describe what you need.
      </p>

      <ol className="mt-8 grid gap-8">
        <li>
          <h2 className="font-semibold text-ink">What Cognis stores</h2>
          <ul className="mt-2 grid max-w-[60ch] list-disc gap-1 pl-5 text-[0.875rem] text-ink-2">
            <li>Only what you choose to save: links, the text of those pages, and your notes.</li>
            <li>Nothing from your other apps or browser, unless you save it here.</li>
            <li>You can export or delete everything from Account at any time.</li>
          </ul>
        </li>
        <li>
          <h2 className="font-semibold text-ink">Save your first item</h2>
          <p className="mt-1 mb-3 text-[0.875rem] text-ink-2">
            Pick something you saved elsewhere and keep losing. A Reddit thread, a LinkedIn post, an article.
          </p>
          {saved ? (
            <p className="rounded-xl bg-success-soft px-4 py-3 text-[0.875rem] text-success" role="status">
              Saved "{saved.title || "your item"}".
            </p>
          ) : (
            <Composer onSaved={(i) => setSaved(i)} />
          )}
        </li>
        <li>
          <h2 className="font-semibold text-ink">Find it again</h2>
          <p className="mt-1 text-[0.875rem] text-ink-2">
            Use the search bar and describe the idea in your own words. Results show why they matched.
          </p>
        </li>
      </ol>

      <div className="mt-10 flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => nav("/app")}>Go to my library</Button>
        <Link to="/help" className="inline-flex h-10 items-center px-4 text-[0.875rem] font-medium text-ink-2 hover:text-ink">Read how it works</Link>
      </div>
    </div>
  );
}
