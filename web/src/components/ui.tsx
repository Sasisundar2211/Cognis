import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const variants: Record<Variant, string> = {
  primary: "bg-primary text-primary-ink hover:bg-primary-hover active:translate-y-px shadow-[0_1px_0_oklch(0_0_0/0.08)]",
  secondary: "bg-raised text-ink border border-line-strong hover:bg-panel active:translate-y-px",
  ghost: "text-ink-2 hover:text-ink hover:bg-panel",
  danger: "bg-raised text-danger border border-line-strong hover:bg-danger-soft hover:border-danger/40",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean; size?: "sm" | "md" }>(
  function Button({ variant = "secondary", loading, size = "md", className = "", children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-[background-color,color,border-color,transform] duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-55 ${size === "sm" ? "h-8 px-3 text-[0.8125rem]" : "h-10 px-4 text-[0.875rem]"} ${variants[variant]} ${className}`}
        {...rest}
      >
        {loading && <Spinner />}
        {children}
      </button>
    );
  },
);

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`size-4 animate-spin motion-reduce:animate-none ${className}`} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

const fieldBase =
  "w-full rounded-lg border border-line-strong bg-raised px-3 text-ink placeholder:text-ink-3 transition-[border-color,box-shadow] duration-150 focus:border-primary focus:outline-none focus:ring-3 focus:ring-primary/20 aria-[invalid=true]:border-danger";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className = "", ...rest }, ref) {
  return <input ref={ref} className={`h-10 ${fieldBase} ${className}`} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className = "", ...rest }, ref) {
  return <textarea ref={ref} className={`py-2.5 leading-relaxed ${fieldBase} ${className}`} {...rest} />;
});

export function Field({ label, hint, error, htmlFor, children }: { label: string; hint?: string; error?: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={htmlFor} className="text-[0.8125rem] font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-[0.8125rem] text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-[0.8125rem] text-ink-2">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Notice({ tone = "info", children, action }: { tone?: "info" | "error" | "success" | "warn"; children: ReactNode; action?: ReactNode }) {
  const tones = {
    info: "bg-primary-soft text-primary-soft-ink",
    error: "bg-danger-soft text-danger",
    success: "bg-success-soft text-success",
    warn: "bg-warn-soft text-warn",
  };
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`flex items-start justify-between gap-3 rounded-lg px-3.5 py-2.5 text-[0.875rem] ${tones[tone]}`}>
      <div className="min-w-0">{children}</div>
      {action}
    </div>
  );
}

export function SourceBadge({ source }: { source: string }) {
  return <span className="inline-flex h-5 items-center rounded-md bg-panel px-1.5 text-[0.75rem] font-medium text-ink-2 ring-1 ring-line ring-inset">{source}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  if (status === "ready") return null;
  const map: Record<string, [string, string]> = {
    pending: ["Queued", "bg-panel text-ink-2"],
    processing: ["Importing", "bg-primary-soft text-primary-soft-ink"],
    failed: ["Import failed", "bg-danger-soft text-danger"],
  };
  const [label, cls] = map[status] ?? [status, "bg-panel text-ink-2"];
  return <span className={`inline-flex h-5 items-center rounded-md px-1.5 text-[0.75rem] font-medium ${cls}`}>{label}</span>;
}
