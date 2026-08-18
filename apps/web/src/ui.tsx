import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';

/**
 * The shared UI vocabulary.
 *
 * Deliberately small. Each primitive exists because the same shape recurs on
 * three or more screens - not to build a general component framework, which
 * would be a larger surface than the product it dresses.
 *
 * Two rules hold throughout:
 *
 *   - STATUS IS NEVER COLOUR ALONE. Every badge carries a word; colour only
 *     reinforces it. An operator with a colour-vision difference, or reading a
 *     greyscale screenshot during an incident review, loses nothing.
 *   - NUMBERS ARE FORMATTED, NEVER COMPUTED. Nothing here parses, sums or
 *     compares a money string. That is the server's job, and the frontend
 *     guards enforce it.
 */

/* -- Buttons ------------------------------------------------------------- */

type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_TONE: Record<ButtonTone, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface text-ink border-line-strong hover:bg-canvas',
  ghost: 'bg-transparent text-ink-muted border-transparent hover:bg-canvas hover:text-ink',
  danger: 'bg-surface text-deny border-line-strong hover:bg-deny-soft',
};

export function Button({
  children,
  tone = 'secondary',
  type = 'button',
  size = 'md',
  className = '',
  ...rest
}: {
  children: ReactNode;
  tone?: ButtonTone;
  size?: 'sm' | 'md';
} & ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  const sizing = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm';
  return (
    <button
      // Always an explicit type: a bare button inside a form submits it.
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${sizing} ${BUTTON_TONE[tone]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/* -- Surfaces ------------------------------------------------------------ */

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section
      className={`rounded-card border border-line bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.04)] ${className}`}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description !== undefined && (
          <p className="mt-0.5 max-w-prose text-sm text-ink-muted">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description !== undefined && (
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex shrink-0 gap-2">{actions}</div>}
    </header>
  );
}

/* -- Status -------------------------------------------------------------- */

type BadgeTone = 'neutral' | 'ok' | 'warn' | 'deny' | 'accent';

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: 'bg-canvas text-ink-muted border-line-strong',
  ok: 'bg-ok-soft text-ok border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  deny: 'bg-deny-soft text-deny border-transparent',
  accent: 'bg-accent-soft text-accent border-accent-line',
};

/** A status chip. The LABEL carries the meaning; tone only reinforces it. */
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: BadgeTone;
}): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/* -- States -------------------------------------------------------------- */

export function LoadingState({ label = 'Loading…' }: { label?: string }): JSX.Element {
  return (
    // aria-live so a screen reader announces the wait rather than silence.
    <p role="status" aria-live="polite" className="px-5 py-8 text-sm text-ink-muted">
      {label}
    </p>
  );
}

export function ErrorState({ message }: { message: string }): JSX.Element {
  return (
    <div role="alert" className="m-5 rounded-md border border-line-strong bg-deny-soft px-4 py-3">
      <p className="text-sm font-medium text-deny">Something went wrong</p>
      <p className="mt-0.5 text-sm text-ink-muted">{message}</p>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="px-5 py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {description !== undefined && (
        <p className="mx-auto mt-1 max-w-sm text-sm text-ink-muted">{description}</p>
      )}
      {action !== undefined && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/* -- Metrics ------------------------------------------------------------- */

/**
 * A single headline number.
 *
 * `value` is always a pre-formatted STRING, and that type is the guard: a
 * component accepting a number would invite arithmetic in the browser, which
 * is exactly what the money invariants forbid.
 */
export function MetricCard({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'deny';
}): JSX.Element {
  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3.5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">{label}</p>
      <p
        className={`tnum mt-1.5 text-2xl font-semibold ${tone === 'deny' ? 'text-deny' : 'text-ink'}`}
      >
        {value}
      </p>
      {hint !== undefined && <p className="mt-0.5 text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

/* -- Data ---------------------------------------------------------------- */

export function TableShell({ children }: { children: ReactNode }): JSX.Element {
  // The wrapper scrolls, not the page: a wide audit table must never break the
  // whole layout horizontally on a laptop.
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({
  children,
  align = 'left',
}: {
  children: ReactNode;
  align?: 'left' | 'right';
}): JSX.Element {
  return (
    <th
      scope="col"
      className={`border-b border-line px-4 py-2.5 text-xs font-semibold tracking-wide text-ink-muted uppercase ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = 'left',
  className = '',
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}): JSX.Element {
  return (
    <td
      className={`border-b border-line px-4 py-3 align-top ${align === 'right' ? 'text-right' : ''} ${className}`}
    >
      {children}
    </td>
  );
}

/* -- Forms --------------------------------------------------------------- */

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      {/* Always a real label+for, never a floating span. */}
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {hint !== undefined && <p className="text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

export const inputClass =
  'w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none';

/* -- Code ---------------------------------------------------------------- */

/**
 * Preformatted text.
 *
 * The content is passed as a React CHILD, never as HTML, so a payload
 * containing markup renders as characters. No frontend file calls
 * `dangerouslySetInnerHTML` anywhere, and a guard asserts it.
 */
export function CodeBlock({ children }: { children: string }): JSX.Element {
  return (
    <pre className="max-h-96 overflow-auto rounded-md border border-line bg-nav-950 px-4 py-3 font-mono text-xs leading-relaxed text-nav-300">
      {children}
    </pre>
  );
}
