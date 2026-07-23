import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { X } from "lucide-react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[1.65rem]">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-ink-muted">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

export function Panel({
  children,
  className,
  title,
  action,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  action?: ReactNode;
}) {
  return (
    <section
      className={cx(
        "rounded-2xl border border-line bg-surface p-4 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]",
        className,
      )}
    >
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title ? (
            <h2 className="text-sm font-medium tracking-tight text-ink">{title}</h2>
          ) : (
            <span />
          )}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost" | "success" | "brand";
  size?: "sm" | "md" | "icon";
}) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex items-center justify-center gap-1.5 font-medium transition-colors",
        "rounded-full",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:ring-offset-2 focus-visible:ring-offset-paper",
        "disabled:pointer-events-none disabled:opacity-40",
        size === "sm" && "h-8 px-3 text-xs",
        size === "md" && "h-9 px-4 text-sm",
        size === "icon" && "h-9 w-9 p-0",
        /* Official primary: white pill on dark */
        variant === "primary" &&
          "bg-ink text-paper hover:bg-white/90 active:bg-white/80",
        variant === "brand" &&
          "bg-brand text-paper hover:brightness-110 active:brightness-95",
        variant === "secondary" &&
          "border border-line bg-surface-2 text-ink hover:bg-surface-3",
        variant === "danger" &&
          "border border-accent-red/30 bg-accent-red/10 text-accent-red hover:bg-accent-red/15",
        variant === "success" &&
          "border border-accent-green/30 bg-accent-green/10 text-accent-green hover:bg-accent-green/15",
        variant === "ghost" && "text-ink-muted hover:bg-surface-2 hover:text-ink",
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-ink-muted">
        {label}
      </label>
      {children}
      {error ? <p className="text-xs text-accent-red">{error}</p> : null}
      {!error && hint ? <p className="text-xs text-ink-faint">{hint}</p> : null}
    </div>
  );
}

const controlBase =
  "w-full rounded-xl border border-line bg-surface-2 px-3 text-sm text-ink placeholder:text-ink-faint " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:border-brand/40 " +
  "disabled:opacity-50";

export function TextInput({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(controlBase, "h-10", className)} {...props} />;
}

export function TextArea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx(controlBase, "min-h-[96px] resize-y py-2.5", className)}
      {...props}
    />
  );
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(controlBase, "h-10", className)} {...props}>
      {children}
    </select>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex flex-wrap rounded-full border border-line bg-surface-2 p-0.5"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={cx(
              "h-8 rounded-full px-3.5 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
              active
                ? "bg-ink text-paper shadow-sm"
                : "text-ink-muted hover:text-ink",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function StatusPill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "green" | "amber" | "red" | "blue";
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        tone === "neutral" && "bg-surface-3 text-ink-muted",
        tone === "green" && "bg-accent-green/12 text-accent-green",
        tone === "amber" && "bg-accent-amber/12 text-accent-amber",
        tone === "red" && "bg-accent-red/12 text-accent-red",
        tone === "blue" && "bg-accent-blue/12 text-accent-blue",
      )}
    >
      {children}
    </span>
  );
}

export function Alert({
  tone = "red",
  title,
  children,
  className,
}: {
  tone?: "red" | "amber" | "green" | "blue";
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cx(
        "rounded-2xl border px-3.5 py-3 text-sm",
        tone === "red" && "border-accent-red/25 bg-accent-red/8 text-accent-red",
        tone === "amber" &&
          "border-accent-amber/25 bg-accent-amber/8 text-accent-amber",
        tone === "green" &&
          "border-accent-green/25 bg-accent-green/8 text-accent-green",
        tone === "blue" &&
          "border-accent-blue/25 bg-accent-blue/8 text-accent-blue",
        className,
      )}
    >
      {title ? <div className="mb-0.5 font-medium">{title}</div> : null}
      <div className="text-[13px] leading-relaxed opacity-95">{children}</div>
    </div>
  );
}

export function Dialog({
  open,
  title,
  children,
  onClose,
  busy = false,
  size = "md",
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  size?: "md" | "lg";
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center">
      <button
        type="button"
        aria-label="Close dialog"
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
        disabled={busy}
        onClick={() => {
          if (!busy) onClose();
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          "relative z-10 max-h-[min(90vh,720px)] w-full overflow-auto rounded-2xl border border-line bg-surface shadow-2xl shadow-black/50",
          "focus:outline-none",
          size === "md" && "max-w-lg",
          size === "lg" && "max-w-2xl",
        )}
      >
        <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-line bg-surface/95 px-4 py-3.5 backdrop-blur-sm">
          <h2 id={titleId} className="text-base font-semibold tracking-tight text-ink">
            {title}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            title="Close"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  showMachine = true,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  showMachine?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      {showMachine ? (
        <img
          src={`${import.meta.env.BASE_URL}studio-machine.png`}
          alt="xBloom Studio"
          className="mb-6 h-32 w-auto object-contain opacity-95 drop-shadow-[0_12px_40px_rgba(0,0,0,0.45)] sm:h-40"
          draggable={false}
        />
      ) : null}
      <h3 className="text-base font-medium tracking-tight text-ink">{title}</h3>
      {description ? (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-ink-muted">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-ink-muted" role="status">
      <span
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-brand motion-reduce:animate-none"
        aria-hidden
      />
      <span>{label}</span>
    </div>
  );
}

export function IconButton({
  label,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      title={label}
      aria-label={label}
      className={className}
      {...props}
    >
      {children}
    </Button>
  );
}

/** Soft pastel thumbnail like official Recipe Library cards. */
export function RecipeThumb({
  label,
  pours,
  index = 0,
  className,
}: {
  label?: string;
  pours?: number;
  index?: number;
  className?: string;
}) {
  const swatch = `recipe-swatch-${Math.abs(index) % 6}`;
  return (
    <div
      className={cx(
        "relative flex h-14 w-14 shrink-0 flex-col justify-between overflow-hidden rounded-xl p-1.5",
        swatch,
        className,
      )}
    >
      {label ? (
        <span className="truncate text-[9px] font-semibold uppercase tracking-wide opacity-80">
          {label}
        </span>
      ) : (
        <span />
      )}
      <span className="self-end text-2xl font-semibold leading-none tracking-tight opacity-90">
        {pours != null && pours > 0 ? pours : "·"}
      </span>
    </div>
  );
}

/** LED-style metric (Live View). */
export function MatrixReadout({
  value,
  unit,
  label,
}: {
  value: string;
  unit?: string;
  label?: string;
}) {
  return (
    <div className="text-center">
      {label ? (
        <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-faint">
          {label}
        </div>
      ) : null}
      <div className="font-matrix text-3xl text-ink sm:text-4xl">
        {value}
        {unit ? (
          <span className="ml-1 text-base font-normal text-ink-muted">{unit}</span>
        ) : null}
      </div>
    </div>
  );
}
