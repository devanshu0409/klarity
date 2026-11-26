import type { ReactNode } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import type { ThemePreference } from '@shared/models'
import { useUi } from '../../stores/uiStore'
import { cx } from '../common/ui'

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'Follow system', icon: Monitor },
  { value: 'dark', label: 'Dark', icon: Moon }
]

/**
 * Three-state control rather than a binary switch: `system` has to stay
 * reachable, otherwise the app stops following the OS the first time anyone
 * touches the toggle.
 */
export function ThemeToggle(): ReactNode {
  const theme = useUi((s) => s.theme)
  const setTheme = useUi((s) => s.setTheme)

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex items-center gap-0.5 rounded-[var(--radius-pill)] border border-[var(--border)] bg-[var(--bg-sunken)] p-0.5"
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => setTheme(value)}
          className={cx(
            'flex size-6 items-center justify-center rounded-[var(--radius-pill)]',
            'transition-colors duration-[var(--duration-fast)]',
            theme === value
              ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
          )}
        >
          <Icon size={13} strokeWidth={2} />
        </button>
      ))}
    </div>
  )
}
