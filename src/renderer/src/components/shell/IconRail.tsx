import type { ReactNode } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import {
  Server,
  HardDrive,
  Search,
  Send,
  Users,
  Gauge,
  Settings,
  type LucideIcon
} from 'lucide-react'
import { useUi, type Section } from '../../stores/uiStore'
import { cx } from '../common/ui'

const ITEMS: { section: Section; label: string; icon: LucideIcon }[] = [
  { section: 'clusters', label: 'Clusters & topics', icon: Server },
  { section: 'brokers', label: 'Brokers', icon: HardDrive },
  { section: 'browse', label: 'Browse messages', icon: Search },
  { section: 'produce', label: 'Produce', icon: Send },
  { section: 'groups', label: 'Consumer groups', icon: Users },
  { section: 'loadtest', label: 'Load test', icon: Gauge }
]

function RailButton({
  label,
  icon: Icon,
  active,
  onClick
}: {
  label: string
  icon: LucideIcon
  active: boolean
  onClick: () => void
}): ReactNode {
  return (
    <Tooltip.Root delayDuration={300}>
      <Tooltip.Trigger asChild>
        <button
          onClick={onClick}
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          className={cx(
            'relative flex size-10 items-center justify-center rounded-[var(--radius)]',
            'transition-colors duration-[var(--duration-fast)]',
            active
              ? 'bg-[var(--accent-subtle)] text-[var(--accent-text)]'
              : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
          )}
        >
          {/* Active marker rides the rail edge so the current section reads at a glance. */}
          {active && (
            <span className="absolute top-1/2 -left-2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-[var(--accent)]" />
          )}
          <Icon size={18} strokeWidth={1.75} />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="right"
          sideOffset={8}
          className="z-50 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-raised)] px-2 py-1 text-[12px] text-[var(--text-primary)] shadow-[var(--shadow-md)]"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

export function IconRail(): ReactNode {
  const section = useUi((s) => s.section)
  const setSection = useUi((s) => s.setSection)

  return (
    <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-[var(--border)] bg-[var(--bg-rail)] py-3">
      <div
        className="mb-3 flex size-8 items-center justify-center rounded-[var(--radius)] text-[var(--brand)]"
        title="Klarity"
      >
        <KlarityMark />
      </div>

      {ITEMS.map((item) => (
        <RailButton
          key={item.section}
          label={item.label}
          icon={item.icon}
          active={section === item.section}
          onClick={() => setSection(item.section)}
        />
      ))}

      <div className="flex-1" />

      <RailButton
        label="Settings"
        icon={Settings}
        active={section === 'settings'}
        onClick={() => setSection('settings')}
      />
    </nav>
  )
}

/** Brand mark: the logo's three ascending bars on the brand red. */
function KlarityMark(): ReactNode {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="5" fill="var(--brand)" />
      {/* The bars stay the logo's off-white in both themes: --on-accent goes
          near-black on dark, which would invert the mark. */}
      <rect x="4.6" y="5" width="7" height="3" fill="#f1f1f1" />
      <rect x="4.6" y="10.5" width="11" height="3" fill="#f1f1f1" />
      <rect x="4.6" y="16" width="14.8" height="3" fill="#f1f1f1" />
    </svg>
  )
}
