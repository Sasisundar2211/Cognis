import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { authClient, authErrorMessage, passkeysSupported } from "../lib/auth";
import { Button, Field, Input, Notice } from "../components/ui";
import { Logo } from "../components/Shell";

function safeNext(next: string | null) {
  return next && next.startsWith("/app") && !next.startsWith("//") ? next : "/app";
}

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-panel px-4 py-10">
      <div className="w-full max-w-sm">
        <Link to="/" className="mb-8 inline-block" aria-label="Cognis home">
          <Logo />
        </Link>
        <div className="rounded-2xl border border-line bg-raised p-6 shadow-raised sm:p-7">
          <h1 className="text-[1.25rem] font-semibold text-ink">{title}</h1>
          {subtitle && <p className="mt-1.5 text-[0.875rem] text-ink-2">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
        {footer && <div className="mt-5 text-center text-[0.875rem] text-ink-2">{footer}</div>}
      </div>
    </div>
  );
}

function Unsupported() {
  return <Notice tone="warn">This browser does not support passkeys. Use a current version of Chrome, Safari, Edge or Firefox.</Notice>;
}

export function SignIn() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    setError("");
    const { error } = await authClient.signIn();
    setBusy(false);
    if (error) return setError(authErrorMessage(error));
    nav(safeNext(params.get("next")), { replace: true });
  }

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Use the passkey you created for Cognis: Face ID, Touch ID, Windows Hello, your phone or a security key."
      footer={
        <>
          New to Cognis? <Link className="font-medium text-primary hover:underline" to="/sign-up">Create an account</Link>
        </>
      }
    >
      <div className="grid gap-4">
        {!passkeysSupported() && <Unsupported />}
        {error && <Notice tone="error">{error}</Notice>}
        <Button variant="primary" loading={busy} onClick={go} disabled={!passkeysSupported()}>
          Sign in with a passkey
        </Button>
        <Link to="/recover" className="text-center text-[0.8125rem] text-ink-2 hover:text-ink">
          Lost your device? Use a recovery code
        </Link>
      </div>
    </AuthLayout>
  );
}

export function SignUp() {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [fieldErr, setFieldErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email)) return setFieldErr("Enter a valid email address.");
    setFieldErr("");
    setBusy(true);
    setError("");
    const { data, error } = await authClient.signUp(email.trim(), name.trim());
    setBusy(false);
    if (error || !data) return setError(authErrorMessage(error));
    setCodes(data.recoveryCodes);
  }

  if (codes) {
    return (
      <AuthLayout title="Save your recovery codes" subtitle="If you lose every device with your passkey, each code signs you in once. Cognis shows them only now.">
        <ol className="grid grid-cols-2 gap-2 rounded-xl bg-panel p-4 font-mono text-[0.875rem] text-ink" aria-label="Recovery codes">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            onClick={() => {
              const blob = new Blob([`Cognis recovery codes for ${email}\nEach code works once.\n\n${codes.join("\n")}\n`], { type: "text/plain" });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = "cognis-recovery-codes.txt";
              a.click();
              URL.revokeObjectURL(a.href);
              setSaved(true);
            }}
          >
            Download as a file
          </Button>
        </div>
        <label className="mt-5 flex items-start gap-2 text-[0.875rem] text-ink">
          <input type="checkbox" className="mt-1" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          I saved these codes somewhere safe.
        </label>
        <Button className="mt-4 w-full" variant="primary" disabled={!saved} onClick={() => nav("/app/welcome", { replace: true })}>
          Continue to Cognis
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your Cognis account"
      subtitle="No password. Your device creates a passkey that only works on Cognis. Free plan: up to 500 saved items."
      footer={
        <>
          Already have an account? <Link className="font-medium text-primary hover:underline" to="/sign-in">Sign in</Link>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-4" noValidate>
        {!passkeysSupported() && <Unsupported />}
        {error && <Notice tone="error">{error}</Notice>}
        <Field label="Name" htmlFor="name" hint="Optional. Shown only to you.">
          <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Field>
        <Field label="Email" htmlFor="email" hint="Identifies your account. Cognis does not send email." error={fieldErr}>
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!fieldErr} />
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!passkeysSupported()}>
          Create passkey and account
        </Button>
        <p className="text-[0.75rem] text-ink-2">
          By creating an account you agree to the <Link to="/privacy" className="underline hover:text-ink">privacy policy</Link>.
        </p>
      </form>
    </AuthLayout>
  );
}

export function Recover() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <AuthLayout title="Sign in with a recovery code" subtitle="Use one of the codes you saved when you created your account. Each code works once." footer={<Link to="/sign-in" className="hover:text-ink">Back to sign in</Link>}>
      <form
        className="grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const { data, error } = await authClient.recover(email.trim(), code);
          setBusy(false);
          if (error || !data) return setError(authErrorMessage(error));
          nav(`/app/account?recovered=${data.recoveryCodesLeft}`, { replace: true });
        }}
      >
        {error && <Notice tone="error">{error}</Notice>}
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Recovery code" htmlFor="code" hint="Like ABCD-EFGH-JKLM-NPQR. Dashes and case do not matter.">
          <Input id="code" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} maxLength={40} className="font-mono" />
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!email || !code}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
