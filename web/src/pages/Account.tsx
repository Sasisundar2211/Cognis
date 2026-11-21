import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { api, type Me } from "../lib/api";
import { authClient, authErrorMessage } from "../lib/auth";
import { PageHeader } from "../components/Shell";
import { Button, Field, Input, Notice } from "../components/ui";

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-t border-line py-7 md:grid-cols-[14rem_1fr] md:gap-8">
      <div>
        <h2 className="text-[0.9375rem] font-semibold text-ink">{title}</h2>
        {description && <p className="mt-1 text-[0.8125rem] text-ink-2">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Meter({ used, max, label }: { used: number; max: number; label: string }) {
  const pct = Math.min(100, Math.round((used / max) * 100));
  return (
    <div>
      <div className="flex justify-between text-[0.8125rem]">
        <span className="text-ink">{label}</span>
        <span className="text-ink-2">{used.toLocaleString()} of {max.toLocaleString()}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-panel" role="progressbar" aria-label={label} aria-valuenow={used} aria-valuemin={0} aria-valuemax={max}>
        <div className={`h-full rounded-full ${pct > 90 ? "bg-danger" : "bg-primary"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function DeviceList() {
  const [list, setList] = useState<Awaited<ReturnType<typeof authClient.listSessions>> | null>(null);
  const load = () => authClient.listSessions().then(setList);
  useEffect(() => {
    void load();
  }, []);
  if (!list) return <div className="skeleton h-12 w-full max-w-md" aria-hidden="true" />;
  return (
    <ul className="grid max-w-md divide-y divide-line rounded-xl border border-line">
      {list.map((s) => (
        <li key={s.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-[0.875rem]">
          <span className="min-w-0">
            <span className="text-ink">{s.kind === "device" ? s.label || "Desktop companion" : "Browser"}</span>
            {s.current && <span className="ml-2 text-[0.75rem] text-success">This browser</span>}
            <span className="block text-[0.75rem] text-ink-2">Last used {new Date(s.lastUsedAt).toLocaleString()}</span>
          </span>
          {!s.current && (
            <Button size="sm" variant="ghost" onClick={async () => { await authClient.revokeSession(s.id); await load(); }}>
              Sign out
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function Account() {
  const nav = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [pwMsg, setPwMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const [revokeMsg, setRevokeMsg] = useState<string | null>(null);
  const [delOpen, setDelOpen] = useState(false);
  const [delPw, setDelPw] = useState("");
  const [delErr, setDelErr] = useState("");
  const [delBusy, setDelBusy] = useState(false);

  useEffect(() => {
    api.me().then(setMe).catch(() => undefined);
  }, []);

  return (
    <>
      <PageHeader title="Account" description={me ? me.user.email : undefined} />

      <Section title="Plan and usage" description="Limits apply per account.">
        {me ? (
          <div className="grid max-w-md gap-4">
            <p className="text-[0.875rem] text-ink">
              You are on the <strong className="font-semibold capitalize">{me.user.plan}</strong> plan.
            </p>
            <Meter used={me.usage.items} max={me.limits.maxItems} label="Saved items" />
            <Meter used={me.usage.collections} max={me.limits.maxCollections} label="Collections" />
            <p className="text-[0.8125rem] text-ink-2">
              Up to {me.limits.maxUrlIngestPerDay} link imports per day. Paid plans are not on sale yet. <Link to="/pricing" className="underline hover:text-ink">See planned plans</Link>.
            </p>
          </div>
        ) : (
          <div className="skeleton h-20 w-full max-w-md" aria-hidden="true" />
        )}
      </Section>

      <Section title="Your data" description="Cognis stores what you save and nothing from your other apps.">
        <div className="grid max-w-[60ch] gap-3 text-[0.875rem] text-ink-2">
          <p>
            Download everything you saved as a JSON file: items, notes, tags, collections and source links.
          </p>
          <div>
            <a href={api.exportUrl} download className="inline-flex h-10 items-center rounded-lg border border-line-strong bg-raised px-4 text-[0.875rem] font-medium text-ink hover:bg-panel">
              Download my data
            </a>
          </div>
          <p>
            Read the <Link to="/privacy" className="underline hover:text-ink">privacy policy</Link> for what is stored, where, and for how long.
          </p>
        </div>
      </Section>

      <Section title="Password">
        <form
          className="grid max-w-sm gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (next.length < 10) return setPwMsg({ tone: "error", text: "Use at least 10 characters." });
            setPwBusy(true);
            const { error } = await authClient.changePassword({ currentPassword: cur, newPassword: next });
            setPwBusy(false);
            if (error) return setPwMsg({ tone: "error", text: authErrorMessage(error) });
            setCur("");
            setNext("");
            setPwMsg({ tone: "success", text: "Password changed. Other devices were signed out." });
          }}
        >
          {pwMsg && <Notice tone={pwMsg.tone}>{pwMsg.text}</Notice>}
          <Field label="Current password" htmlFor="cur">
            <Input id="cur" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
          </Field>
          <Field label="New password" htmlFor="new" hint="At least 10 characters.">
            <Input id="new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} maxLength={128} />
          </Field>
          <div><Button type="submit" loading={pwBusy} disabled={!cur || !next}>Change password</Button></div>
        </form>
      </Section>

      <Section title="Devices" description="Browsers and desktop companions signed in to your account.">
        <div className="grid gap-3">
          {revokeMsg && <Notice tone="success">{revokeMsg}</Notice>}
          <DeviceList key={revokeMsg ?? ""} />
          <div>
            <Button
              onClick={async () => {
                const { error } = await authClient.revokeOtherSessions();
                setRevokeMsg(error ? null : `Signed out everywhere else at ${new Date().toLocaleTimeString()}.`);
              }}
            >
              Sign out other sessions
            </Button>
          </div>
        </div>
      </Section>

      <Section title="Delete account" description="Permanent. Removes your account and every item, tag and collection.">
        {delOpen ? (
          <form
            className="grid max-w-sm gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setDelBusy(true);
              setDelErr("");
              const { error } = await authClient.deleteUser({ password: delPw });
              setDelBusy(false);
              if (error) return setDelErr(authErrorMessage(error));
              nav("/?deleted=1", { replace: true });
            }}
          >
            <Notice tone="warn">This cannot be undone. Download your data first if you want a copy.</Notice>
            {delErr && <Notice tone="error">{delErr}</Notice>}
            <Field label="Enter your password to confirm" htmlFor="delpw">
              <Input id="delpw" type="password" autoComplete="current-password" value={delPw} onChange={(e) => setDelPw(e.target.value)} />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variant="danger" loading={delBusy} disabled={!delPw}>Delete my account</Button>
              <Button type="button" variant="ghost" onClick={() => setDelOpen(false)}>Cancel</Button>
            </div>
          </form>
        ) : (
          <Button variant="danger" onClick={() => setDelOpen(true)}>Delete account…</Button>
        )}
      </Section>
    </>
  );
}
