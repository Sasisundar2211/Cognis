import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router";
import { authClient, useSession } from "../lib/auth";
import { Spinner } from "./ui";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight text-ink ${className}`}>
      <svg viewBox="0 0 32 32" className="size-6" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="var(--primary)" />
        <path d="M21.5 11.2a7 7 0 1 0 0 9.6" fill="none" stroke="var(--primary-ink)" strokeWidth="3" strokeLinecap="round" />
        <circle cx="21.6" cy="16" r="1.8" fill="var(--primary-ink)" />
      </svg>
      Cognis
    </span>
  );
}

const NAV = [
  { to: "/app", label: "Library", end: true },
  { to: "/app/collections", label: "Collections" },
  { to: "/app/account", label: "Account" },
  { to: "/help", label: "Help" },
];

function SearchBox() {
  const [params] = useSearchParams();
  const loc = useLocation();
  const nav = useNavigate();
  const [q, setQ] = useState(loc.pathname === "/app/search" ? params.get("q") ?? "" : "");
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (loc.pathname === "/app/search") setQ(params.get("q") ?? "");
  }, [loc.pathname, params]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    const v = q.trim();
    if (v) nav(`/app/search?q=${encodeURIComponent(v)}`);
  }

  return (
    <form role="search" onSubmit={submit} className="relative w-full max-w-xl">
      <label htmlFor="global-search" className="sr-only">
        Search your knowledge
      </label>
      <svg viewBox="0 0 20 20" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" aria-hidden="true">
        <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="m13.5 13.5 3.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <input
        id="global-search"
        ref={ref}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by words or meaning"
        maxLength={500}
        className="h-10 w-full rounded-lg border border-line bg-panel pr-10 pl-9 text-ink placeholder:text-ink-3 transition-[border-color,box-shadow,background-color] duration-150 focus:border-primary focus:bg-raised focus:ring-3 focus:ring-primary/20 focus:outline-none"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded border border-line px-1.5 font-mono text-[0.6875rem] text-ink-3 sm:block">/</kbd>
    </form>
  );
}

export function AppShell() {
  const { data, isPending } = useSession();
  const nav = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    if (!isPending && !data) nav(`/sign-in?next=${encodeURIComponent(loc.pathname + loc.search)}`, { replace: true });
  }, [isPending, data, nav, loc]);

  if (isPending || !data) {
    return (
      <div className="grid min-h-dvh place-items-center text-ink-2" role="status">
        <span className="flex items-center gap-2">
          <Spinner /> Loading your library
        </span>
      </div>
    );
  }

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[var(--z-toast)] focus:rounded-lg focus:bg-raised focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className="border-line bg-panel md:sticky md:top-0 md:flex md:h-dvh md:flex-col md:border-r">
        <div className="flex items-center justify-between px-4 py-3.5 md:px-5 md:py-5">
          <Link to="/app" aria-label="Cognis library">
            <Logo />
          </Link>
          <SignOut compact />
        </div>
        <nav aria-label="Main" className="overflow-x-auto px-2 pb-2 md:flex-1 md:px-3">
          <ul className="flex gap-1 md:flex-col">
            {NAV.map((n) => (
              <li key={n.to}>
                <NavLink
                  to={n.to}
                  end={n.end}
                  className={({ isActive }) =>
                    `block rounded-lg px-3 py-2 text-[0.875rem] font-medium whitespace-nowrap transition-colors duration-150 ${isActive ? "bg-raised text-ink shadow-raised" : "text-ink-2 hover:bg-raised/60 hover:text-ink"}`
                  }
                >
                  {n.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="hidden border-t border-line px-5 py-4 md:block">
          <p className="truncate text-[0.8125rem] text-ink" title={data.user.email}>
            {data.user.email}
          </p>
          <SignOut />
        </div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-[var(--z-sticky)] border-b border-line bg-bg/90 px-4 py-3 backdrop-blur-sm md:px-8">
          <SearchBox />
        </header>
        <main id="main" className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function SignOut({ compact }: { compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await authClient.signOut();
        nav("/", { replace: true });
      }}
      className={`${compact ? "md:hidden" : "mt-1"} text-[0.8125rem] text-ink-2 hover:text-ink disabled:opacity-50`}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[1.375rem] font-semibold text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-[65ch] text-[0.875rem] text-ink-2">{description}</p>}
      </div>
      {actions}
    </div>
  );
}
