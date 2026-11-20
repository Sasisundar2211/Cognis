import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { authClient, authErrorMessage } from "../lib/auth";
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

export function SignIn() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error } = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (error) return setError(authErrorMessage(error));
    nav(safeNext(params.get("next")), { replace: true });
  }

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Pick up where you left off."
      footer={
        <>
          New to Cognis? <Link className="font-medium text-primary hover:underline" to="/sign-up">Create an account</Link>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-4" noValidate>
        {params.get("verified") && <Notice tone="success">Email verified. Sign in to continue.</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!email || !password}>
          Sign in
        </Button>
        <Link to="/forgot-password" className="text-center text-[0.8125rem] text-ink-2 hover:text-ink">
          Forgot your password?
        </Link>
      </form>
    </AuthLayout>
  );
}

export function SignUp() {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [fieldErr, setFieldErr] = useState<{ email?: string; password?: string }>({});
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const fe: typeof fieldErr = {};
    if (!/^\S+@\S+\.\S+$/.test(email)) fe.email = "Enter a valid email address.";
    if (password.length < 10) fe.password = "Use at least 10 characters.";
    setFieldErr(fe);
    if (Object.keys(fe).length) return;
    setBusy(true);
    setError("");
    const { data, error } = await authClient.signUp.email({ name: name.trim() || email.split("@")[0]!, email, password, callbackURL: "/app/welcome" });
    setBusy(false);
    if (error) return setError(authErrorMessage(error));
    if (data?.token) nav("/app/welcome", { replace: true });
    else setSentTo(email);
  }

  if (sentTo) {
    return (
      <AuthLayout title="Check your email" subtitle={<>We sent a verification link to <strong className="text-ink">{sentTo}</strong>. Open it to finish creating your account.</>}>
        <p className="text-[0.875rem] text-ink-2">The link expires in one hour. If it does not arrive, check your spam folder.</p>
        <ResendVerification email={sentTo} />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your Cognis account"
      subtitle="Free plan: up to 500 saved items. No card needed."
      footer={
        <>
          Already have an account? <Link className="font-medium text-primary hover:underline" to="/sign-in">Sign in</Link>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-4" noValidate>
        {error && <Notice tone="error">{error}</Notice>}
        <Field label="Name" htmlFor="name" hint="Optional. Shown only to you.">
          <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Field>
        <Field label="Email" htmlFor="email" error={fieldErr.email}>
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!fieldErr.email} aria-describedby={fieldErr.email ? "email-error" : undefined} />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 10 characters." error={fieldErr.password}>
          <Input id="password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} maxLength={128} aria-invalid={!!fieldErr.password} aria-describedby={fieldErr.password ? "password-error" : "password-hint"} />
        </Field>
        <Button type="submit" variant="primary" loading={busy}>
          Create account
        </Button>
        <p className="text-[0.75rem] text-ink-2">
          By creating an account you agree to the <Link to="/privacy" className="underline hover:text-ink">privacy policy</Link>.
        </p>
      </form>
    </AuthLayout>
  );
}

function ResendVerification({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "busy" | "sent" | "error">("idle");
  return (
    <div className="mt-5">
      <Button
        variant="secondary"
        loading={state === "busy"}
        disabled={state === "sent"}
        onClick={async () => {
          setState("busy");
          const { error } = await authClient.sendVerificationEmail({ email, callbackURL: "/app/welcome" });
          setState(error ? "error" : "sent");
        }}
      >
        {state === "sent" ? "Sent again" : "Resend the link"}
      </Button>
      {state === "error" && <p className="mt-2 text-[0.8125rem] text-danger">Could not resend right now. Wait a few minutes and try again.</p>}
    </div>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  return (
    <AuthLayout title="Reset your password" subtitle="Enter your account email. We will send you a reset link." footer={<Link to="/sign-in" className="hover:text-ink">Back to sign in</Link>}>
      {done ? (
        <Notice tone="success">If an account exists for {email}, a reset link is on its way. It expires in one hour.</Notice>
      ) : (
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const { error } = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
            setBusy(false);
            if (error && error.status === 429) return setError(authErrorMessage(error));
            setDone(true); // same message whether or not the account exists
          }}
        >
          {error && <Notice tone="error">{error}</Notice>}
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={!email}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get("token");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(params.get("error") ? "This link has expired or was already used. Request a new one." : "");

  if (!token) {
    return (
      <AuthLayout title="Link not valid" subtitle="This reset link is incomplete or expired.">
        <Link to="/forgot-password" className="font-medium text-primary hover:underline">Request a new link</Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Choose a new password" subtitle="Signing in with the new password signs you out everywhere else.">
      <form
        className="grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (password.length < 10) return setError("Use at least 10 characters.");
          setBusy(true);
          const { error } = await authClient.resetPassword({ newPassword: password, token });
          setBusy(false);
          if (error) return setError(authErrorMessage(error));
          nav("/sign-in?reset=1", { replace: true });
        }}
      >
        {error && <Notice tone="error">{error}</Notice>}
        <Field label="New password" htmlFor="password" hint="At least 10 characters.">
          <Input id="password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} maxLength={128} />
        </Field>
        <Button type="submit" variant="primary" loading={busy}>
          Save new password
        </Button>
      </form>
    </AuthLayout>
  );
}
