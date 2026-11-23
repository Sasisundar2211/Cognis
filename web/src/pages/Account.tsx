import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api, type Me } from "../lib/api";
import { authClient, authErrorMessage, type Passkey } from "../lib/auth";
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

function Passkeys() {
  const [list, setList] = useState<Passkey[] | null>(null);
  const [left, setLeft] = useState(0);
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => {
    const r = await authClient.listPasskeys();
    if (r.data) {
      setList(r.data.passkeys);
      setLeft(r.data.recoveryCodesLeft);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <div className="grid max-w-md gap-3">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {!list ? (
        <div className="skeleton h-12 w-full" aria-hidden="true" />
      ) : (
        <ul className="grid divide-y divide-line rounded-xl border border-line" aria-label="Passkeys">
          {list.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-[0.875rem]">
              <span className="min-w-0">
                <span className="text-ink">{p.name || "Passkey"}</span>
                <span className="block text-[0.75rem] text-ink-2">Added {new Date(p.createdAt).toLocaleDateString()}{p.lastUsedAt ? `, last used ${new Date(p.lastUsedAt).toLocaleDateString()}` : ""}</span>
              </span>
              {list.length > 1 && (
                <Button size="sm" variant="ghost" onClick={async () => { const r = await authClient.removePasskey(p.id); setMsg(r.error ? { tone: "error", text: authErrorMessage(r.error) } : { tone: "success", text: "Passkey removed." }); await load(); }}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          loading={busy === "add"}
          onClick={async () => {
            setBusy("add");
            const r = await authClient.addPasskey();
            setBusy(null);
            setMsg(r.error ? { tone: "error", text: authErrorMessage(r.error) } : { tone: "success", text: "Passkey added. You can sign in with it now." });
            await load();
          }}
        >
          Add a passkey on another device
        </Button>
        <Button
          variant="ghost"
          loading={busy === "codes"}
          onClick={async () => {
            setBusy("codes");
            const r = await authClient.newRecoveryCodes();
            setBusy(null);
            if (r.error || !r.data) return setMsg({ tone: "error", text: authErrorMessage(r.error) });
            setCodes(r.data.recoveryCodes);
            setLeft(r.data.recoveryCodes.length);
          }}
        >
          New recovery codes
        </Button>
      </div>
      <p className="text-[0.8125rem] text-ink-2">{left} unused recovery code{left === 1 ? "" : "s"} left. New codes replace all old ones.</p>
      {codes && (
        <div className="rounded-xl bg-panel p-4">
          <p className="text-[0.8125rem] text-ink">Save these now. They will not be shown again.</p>
          <ol className="mt-2 grid grid-cols-2 gap-1.5 font-mono text-[0.875rem]">{codes.map((c) => <li key={c}>{c}</li>)}</ol>
        </div>
      )}
    </div>
  );
}

function PairDesktop() {
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid max-w-md gap-3 text-[0.875rem] text-ink-2">
      <p>Open the Cognis desktop app, choose Pair with a code, and enter the code below. It works once and expires in 10 minutes.</p>
      {err && <Notice tone="error">{err}</Notice>}
      {code ? (
        <div className="rounded-xl border border-line bg-panel px-4 py-3">
          <p className="font-mono text-[1.5rem] tracking-[0.12em] text-ink" aria-label="Pairing code">{code.code}</p>
          <p className="text-[0.75rem]">Expires at {new Date(code.expiresAt).toLocaleTimeString()}. Server address: {location.origin}</p>
        </div>
      ) : null}
      <div>
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErr("");
            const r = await authClient.pairingCode();
            setBusy(false);
            if (r.error || !r.data) return setErr(authErrorMessage(r.error));
            setCode(r.data);
          }}
        >
          {code ? "New code" : "Get a pairing code"}
        </Button>
      </div>
    </div>
  );
}

export function Account() {
  const nav = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [params] = useSearchParams();
  const recovered = params.get("recovered");
  const [revokeMsg, setRevokeMsg] = useState<string | null>(null);
  const [delOpen, setDelOpen] = useState(false);
  const [delText, setDelText] = useState("");
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

      {recovered !== null && (
        <Notice tone="warn">You signed in with a recovery code. {recovered} left. Add a passkey on this device now so you do not run out.</Notice>
      )}

      <Section title="Passkeys" description="How you sign in. Add one on each device you use. Recovery codes work if you lose them all.">
        <Passkeys />
      </Section>

      <Section title="Desktop companion" description="Connect the Cognis desktop app to this account.">
        <PairDesktop />
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
              const { error } = await authClient.deleteAccount();
              setDelBusy(false);
              if (error) return setDelErr(authErrorMessage(error));
              nav("/?deleted=1", { replace: true });
            }}
          >
            <Notice tone="warn">This cannot be undone. Download your data first if you want a copy.</Notice>
            {delErr && <Notice tone="error">{delErr}</Notice>}
            <Field label="Type DELETE to confirm" htmlFor="deltext" hint="For your safety this needs a sign-in from the last 15 minutes.">
              <Input id="deltext" autoComplete="off" value={delText} onChange={(e) => setDelText(e.target.value)} />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variant="danger" loading={delBusy} disabled={delText !== "DELETE"}>Delete my account</Button>
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
