import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

/** Joins class names, dropping falsy entries. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

/**
 * DESIGN.md button language: the primary action is an ink pill (warm near-
 * black on the cream canvas — inverted on dark), the secondary is an outlined
 * pill, and the brand red stays out of ordinary CTAs so it keeps its meaning
 * as a signal color. Danger keeps its own darker red plus type-to-confirm.
 */
const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] border-transparent hover:bg-[var(--btn-primary-bg-hover)]',
  secondary:
    'bg-[var(--bg-surface)] text-[var(--text-primary)] border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
  ghost:
    'bg-transparent text-[var(--text-secondary)] border-transparent hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
  danger: 'bg-[var(--danger)] text-white border-transparent hover:brightness-110'
}

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[12px] gap-1.5',
  md: 'h-8 px-3 text-[13px] gap-2'
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      {...rest}
      className={cx(
        // Pill-shaped controls: the committed radius tier for interactive chrome.
        'inline-flex items-center justify-center rounded-[var(--radius-pill)] border font-medium',
        'transition-colors duration-[var(--duration-fast)]',
        'disabled:opacity-45 disabled:pointer-events-none',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** True when the caller already decided how wide this control should be. */
function hasWidth(className: string | undefined): boolean {
  return /(^|\s)(w-|min-w-|max-w-|flex-1|basis-)/.test(className ?? '')
}

/**
 * `w-full` is the default, not a fixed part of the base: two classes setting
 * the same property have equal specificity, so which one wins comes down to
 * Tailwind's own stylesheet order, not the order they appear in `class`. A
 * caller passing `w-56` or `flex-1` was silently losing that fight — most
 * visibly in a flex row, where the stretched control squeezed its neighbour to
 * nothing.
 */
export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return (
    <input
      {...rest}
      className={cx(
        'h-8 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-surface)]',
        !hasWidth(className) && 'w-full',
        'px-2.5 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
        'focus:border-[var(--border-focus)] focus:outline-none',
        className
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// Panel / section chrome
// ---------------------------------------------------------------------------

/**
 * Section container. Optionally collapsible: the chevron and the header itself
 * toggle it, and the body unmounts so a collapsed section costs its header and
 * nothing else.
 *
 * Collapse can be controlled by the parent (pass `collapsed` + `onCollapsedChange`)
 * or left to the panel. Views whose layout uses fixed pixel tracks control it,
 * because the track has to shrink to `auto` for the collapse to free any space.
 */
export function Panel({
  title,
  actions,
  children,
  className,
  collapsible,
  collapsed,
  onCollapsedChange
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  collapsible?: boolean
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}): ReactNode {
  const [internal, setInternal] = useState(false)
  const isCollapsed = collapsible ? (collapsed ?? internal) : false

  const toggle = (): void => {
    const next = !isCollapsed
    if (collapsed === undefined) setInternal(next)
    onCollapsedChange?.(next)
  }

  return (
    <section
      className={cx(
        'flex min-h-0 flex-col rounded-[var(--radius-lg)] border border-[var(--border)]',
        'bg-[var(--bg-surface)] shadow-[var(--shadow-sm)]',
        className
      )}
    >
      {(title || actions) && (
        <header className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] px-3">
          {/* Eyebrow treatment: tiny accent dot + uppercase tracked label —
              the section-category signal from DESIGN.md. The dot doubles as the
              collapse affordance, turning into a chevron on a collapsible panel. */}
          <h2 className="flex min-w-0 items-center gap-1.5 truncate text-[12px] font-bold tracking-[var(--tracking-eyebrow)] whitespace-nowrap text-[var(--text-secondary)] uppercase">
            {collapsible ? (
              <button
                type="button"
                onClick={toggle}
                aria-expanded={!isCollapsed}
                title={isCollapsed ? 'Expand section' : 'Collapse section'}
                className="-ml-1 flex items-center gap-1.5 rounded-[var(--radius-sm)] px-1 py-0.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <ChevronDown
                  size={13}
                  className={cx(
                    'shrink-0 transition-transform duration-[var(--duration-fast)]',
                    isCollapsed && '-rotate-90'
                  )}
                />
                <span className="truncate">{title}</span>
              </button>
            ) : (
              <>
                <span aria-hidden className="size-1 shrink-0 rounded-full bg-[var(--accent)]" />
                {title}
              </>
            )}
          </h2>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      {/* Unmounted rather than hidden: a collapsed message table should not keep
          a virtualized list mounted and measuring. */}
      {!isCollapsed && <div className="min-h-0 flex-1 overflow-auto">{children}</div>}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Empty / error states
// ---------------------------------------------------------------------------

export function EmptyState({
  icon,
  title,
  hint,
  action
}: {
  icon?: ReactNode
  title: string
  hint?: string
  action?: ReactNode
}): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 py-12 text-center">
      {icon && <div className="mb-1 text-[var(--text-muted)]">{icon}</div>}
      <p className="text-[14px] font-medium text-[var(--text-primary)]">{title}</p>
      {hint && <p className="max-w-md text-[12px] text-[var(--text-muted)]">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export function Badge({
  children,
  color = 'raw',
  className
}: {
  children: ReactNode
  /** Maps to the --fmt-* token pair, so decode formats and states share one style. */
  color?: 'json' | 'protobuf' | 'flatbuffers' | 'avro' | 'string' | 'number' | 'raw' | 'error'
  className?: string
}): ReactNode {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-[var(--radius-pill)] px-2 py-0.5',
        'text-[10px] font-semibold tracking-wide uppercase',
        className
      )}
      style={{ color: `var(--fmt-${color})`, backgroundColor: `var(--fmt-${color}-bg)` }}
    >
      {children}
    </span>
  )
}

/** Small dot used for cluster color and connection state. */
export function Dot({ color, title }: { color: string; title?: string }): ReactNode {
  return (
    <span
      title={title}
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  )
}
