import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useSession } from "../lib/auth";
import { Logo } from "../components/Shell";

function PublicLayout({ children }: { children: ReactNode }) {
  const { data } = useSession();
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-5 md:px-8">
        <Link to="/" aria-label="Cognis home"><Logo /></Link>
        <nav aria-label="Site" className="flex items-center gap-1 text-[0.875rem]">
          <Link to="/pricing" className="rounded-lg px-3 py-2 text-ink-2 hover:text-ink">Pricing</Link>
          <Link to="/help" className="rounded-lg px-3 py-2 text-ink-2 hover:text-ink">How it works</Link>
          {data ? (
            <Link to="/app" className="ml-1 inline-flex h-9 items-center rounded-lg bg-primary px-3.5 font-medium text-primary-ink hover:bg-primary-hover">Open library</Link>
          ) : (
            <>
              <Link to="/sign-in" className="rounded-lg px-3 py-2 text-ink-2 hover:text-ink">Sign in</Link>
              <Link to="/sign-up" className="ml-1 inline-flex h-9 items-center rounded-lg bg-primary px-3.5 font-medium text-primary-ink hover:bg-primary-hover">Start free</Link>
            </>
          )}
        </nav>
      </header>
      <main id="main">{children}</main>
      <footer className="mx-auto mt-24 flex max-w-5xl flex-wrap justify-between gap-4 border-t border-line px-4 py-8 text-[0.8125rem] text-ink-2 md:px-8">
        <span>Cognis. Open source.</span>
        <span className="flex gap-4">
          <Link to="/privacy" className="hover:text-ink">Privacy</Link>
          <Link to="/help" className="hover:text-ink">Help</Link>
          <Link to="/pricing" className="hover:text-ink">Pricing</Link>
        </span>
      </footer>
    </div>
  );
}

export function Landing() {
  const [params] = useSearchParams();
  return (
    <PublicLayout>
      {params.get("deleted") && (
        <p role="status" className="mx-auto max-w-5xl px-4 text-[0.875rem] text-ink-2 md:px-8">Your account and all its data were deleted.</p>
      )}
      <section className="mx-auto max-w-5xl px-4 pt-14 md:px-8 md:pt-24">
        <h1 className="max-w-[18ch] text-[2.5rem] leading-[1.08] font-semibold tracking-[-0.025em] text-ink md:text-[3.5rem]">
          Remember what you saved. Find it when you need it.
        </h1>
        <p className="mt-5 max-w-[56ch] text-[1.0625rem] text-ink-2">
          You save posts on Reddit, LinkedIn, Instagram and X, articles on Substack, repos on GitHub. Then you forget where. Cognis keeps them in one place, with their source, and finds them by what they mean, not only by the words you remember.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link to="/sign-up" className="inline-flex h-11 items-center rounded-lg bg-primary px-5 font-medium text-primary-ink hover:bg-primary-hover">Create a free account</Link>
          <Link to="/help" className="inline-flex h-11 items-center px-2 font-medium text-ink-2 hover:text-ink">See how it works</Link>
        </div>
      </section>

      <section className="mx-auto mt-20 max-w-5xl px-4 md:px-8" aria-labelledby="example-h">
        <h2 id="example-h" className="sr-only">Example</h2>
        <div className="overflow-hidden rounded-2xl border border-line bg-panel">
          <div className="border-b border-line bg-raised px-5 py-3 text-[0.875rem] text-ink-2">
            <span className="text-ink-3">Search:</span> <span className="text-ink">how do I get early users for a dev tool</span>
          </div>
          <ul className="divide-y divide-line">
            {[
              ["Reddit", "Launching on niche subreddits without getting banned", "Saved 3 months ago", "Close in meaning to your search"],
              ["Substack", "Your first 100 users come from one channel", "Saved 5 weeks ago", 'Contains "users" and is close in meaning'],
              ["LinkedIn", "Positioning: say who it is for in one sentence", "Saved 2 months ago", "Close in meaning to your search"],
            ].map(([src, title, when, why]) => (
              <li key={title} className="px-5 py-4">
                <div className="text-[0.75rem] text-ink-2">{src} · {when}</div>
                <div className="mt-1 font-semibold text-ink">{title}</div>
                <div className="mt-1 text-[0.75rem] text-primary-soft-ink">{why}</div>
              </li>
            ))}
          </ul>
        </div>
        <p className="mt-3 text-[0.8125rem] text-ink-3">Illustration of the results view. Your library starts empty.</p>
      </section>

      <section className="mx-auto mt-20 grid max-w-5xl gap-10 px-4 md:grid-cols-3 md:px-8">
        <div>
          <h2 className="font-semibold text-ink">Save from anywhere</h2>
          <p className="mt-2 text-[0.9375rem] text-ink-2">Paste a link or write a note. Cognis reads the page, keeps the text and the original link.</p>
        </div>
        <div>
          <h2 className="font-semibold text-ink">Search by meaning</h2>
          <p className="mt-2 text-[0.9375rem] text-ink-2">Describe the idea in your words. Each result says why it matched, so you can trust it or skip it.</p>
        </div>
        <div>
          <h2 className="font-semibold text-ink">Yours to keep or delete</h2>
          <p className="mt-2 text-[0.9375rem] text-ink-2">No ads, no tracking scripts. Export everything as JSON or delete your account in one step.</p>
        </div>
      </section>
    </PublicLayout>
  );
}

const PLANS = [
  { name: "Free", price: "$0", note: "forever", items: ["500 saved items", "50 link imports per day", "10 collections", "Search by words and meaning", "Export and delete anytime"] },
  { name: "Plus", price: "$3", note: "per month, planned", items: ["10,000 saved items", "500 link imports per day", "200 collections", "Browser extension capture", "Context suggestions while you work"] },
  { name: "Pro", price: "$8", note: "per month, planned", items: ["50,000 saved items", "2,000 link imports per day", "1,000 collections", "Import from Reddit, GitHub, YouTube, bookmarks", "Priority processing"] },
];

export function Pricing() {
  return (
    <PublicLayout>
      <section className="mx-auto max-w-5xl px-4 pt-12 md:px-8">
        <h1 className="text-[2rem] font-semibold tracking-[-0.02em] text-ink">Pricing</h1>
        <p className="mt-2 max-w-[60ch] text-ink-2">
          Start free. Paid plans are planned and not on sale yet. Features marked for paid plans are in development.
        </p>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {PLANS.map((p, i) => (
            <div key={p.name} className={`rounded-2xl border p-6 ${i === 1 ? "border-primary" : "border-line"}`}>
              <h2 className="font-semibold text-ink">{p.name}</h2>
              <p className="mt-3">
                <span className="text-[2rem] font-semibold text-ink">{p.price}</span> <span className="text-[0.8125rem] text-ink-2">{p.note}</span>
              </p>
              <ul className="mt-5 grid gap-2 text-[0.875rem] text-ink-2">
                {p.items.map((x) => <li key={x}>{x}</li>)}
              </ul>
              {i === 0 && <Link to="/sign-up" className="mt-6 inline-flex h-10 items-center rounded-lg bg-primary px-4 text-[0.875rem] font-medium text-primary-ink hover:bg-primary-hover">Start free</Link>}
            </div>
          ))}
        </div>
      </section>
    </PublicLayout>
  );
}

function Prose({ title, children }: { title: string; children: ReactNode }) {
  return (
    <PublicLayout>
      <article className="mx-auto max-w-[68ch] px-4 pt-12 text-ink-2 md:px-0 [&_h2]:mt-10 [&_h2]:font-semibold [&_h2]:text-ink [&_li]:mt-1 [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5">
        <h1 className="text-[2rem] font-semibold tracking-[-0.02em] text-ink">{title}</h1>
        {children}
      </article>
    </PublicLayout>
  );
}

export function Privacy() {
  return (
    <Prose title="Privacy">
      <p>This page describes what the current version of Cognis does. It changes when the product changes.</p>
      <h2>What Cognis stores</h2>
      <ul>
        <li>Your account: email, name, a salted scrypt hash of your password, and your active sessions.</li>
        <li>What you save: links, the readable text Cognis extracts from those pages, your notes, tags and collections.</li>
        <li>A numeric embedding of each item, used for search by meaning.</li>
        <li>Security events (for example "signed in", "item deleted") with a timestamp. These never contain item content.</li>
      </ul>
      <h2>What Cognis does not do</h2>
      <ul>
        <li>No ads, no analytics scripts, no third-party trackers, no selling data.</li>
        <li>No reading of your browser, clipboard, screen, camera or microphone. A browser extension is planned; it will only capture a page when you click it.</li>
        <li>No other user can see your items. Every request is checked against your account.</li>
      </ul>
      <h2>Who processes your data</h2>
      <ul>
        <li>Cloudflare hosts the app and database (Workers and D1) and computes embeddings with Workers AI.</li>
        <li>If email is enabled, Resend delivers verification and password reset emails.</li>
        <li>When you save a link, Cognis fetches that page from its server, identifying itself as CognisBot.</li>
      </ul>
      <h2>Deletion and export</h2>
      <ul>
        <li>Deleting an item removes it from your library and search immediately.</li>
        <li>Deleting your account removes your account and all items, tags and collections immediately.</li>
        <li>Database point-in-time recovery keeps copies for up to 30 days, after which deleted data is gone.</li>
        <li>Account, then Download my data, gives you everything as JSON.</li>
      </ul>
      <h2>Cookies</h2>
      <p>One session cookie keeps you signed in. It is HTTP-only and not used for tracking.</p>
    </Prose>
  );
}

export function Help() {
  return (
    <Prose title="How Cognis works">
      <h2>Saving</h2>
      <p>Paste a link into the box at the top of your library. Cognis fetches the page, keeps its title, description and readable text, and stores the original link. Write anything that is not a link and it saves as a note.</p>
      <p>Some sites block automated reading, and some links are not web pages (PDFs, images). Those imports fail with a clear reason. The link stays saved, and you can try again or add a note.</p>
      <h2>Searching</h2>
      <p>Search combines two methods. Word search finds items containing your terms. Meaning search finds items about the same idea, even with different words. Results that both methods agree on rank higher. Each result says which one matched.</p>
      <p>Press / anywhere to jump to search.</p>
      <h2>Organizing</h2>
      <p>Add tags when you save or edit. Group items into collections from an item's page. Archive items to keep them out of search without deleting them.</p>
      <h2>What is not built yet</h2>
      <ul>
        <li>Browser extension for one-click capture.</li>
        <li>Context suggestions that surface saved items while you work.</li>
        <li>Imports from Reddit, GitHub, YouTube and browser bookmarks.</li>
      </ul>
    </Prose>
  );
}

export function NotFound() {
  return (
    <PublicLayout>
      <section className="mx-auto max-w-5xl px-4 pt-16 md:px-8">
        <h1 className="text-[1.5rem] font-semibold text-ink">Page not found</h1>
        <p className="mt-2 text-ink-2">The link may be wrong or the page moved.</p>
        <Link to="/" className="mt-4 inline-block font-medium text-primary hover:underline">Go home</Link>
      </section>
    </PublicLayout>
  );
}
