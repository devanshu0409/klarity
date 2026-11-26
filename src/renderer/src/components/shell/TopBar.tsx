import type { ReactNode } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, Lock, Plug, Plus } from 'lucide-react'
import { useClusters } from '../../stores/clusterStore'
import { useTopics } from '../../stores/topicStore'
import { useUi, type Section } from '../../stores/uiStore'
import { Dot, cx } from '../common/ui'
import { ThemeToggle } from './ThemeToggle'

const TITLES: Record<Section, string> = {
  clusters: 'Clusters & Topics',
  brokers: 'Brokers',
  browse: 'Browse Messages',
  produce: 'Produce',
  groups: 'Consumer Groups',
  loadtest: 'Load Test',
  settings: 'Settings'
}

/**
 * The cluster switcher sits above every section: which cluster an action lands
 * on must never be something the user has to infer.
 */
export function TopBar({ onAddCluster }: { onAddCluster: () => void }): ReactNode {
  const section = useUi((s) => s.section)

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-surface)] px-3">
      <ClusterSwitcher onAddCluster={onAddCluster} />
      <div className="h-5 w-px bg-[var(--border)]" />
      <h1 className="text-[13px] font-semibold text-[var(--text-primary)]">{TITLES[section]}</h1>
      <div className="flex-1" />
      <ThemeToggle />
    </header>
  )
}

function ClusterSwitcher({ onAddCluster }: { onAddCluster: () => void }): ReactNode {
  const profiles = useClusters((s) => s.profiles)
  const selectedId = useClusters((s) => s.selectedId)
  const health = useClusters((s) => s.health)
  const select = useClusters((s) => s.select)
  const connect = useClusters((s) => s.connect)
  const resetTopics = useTopics((s) => s.reset)
  const setSection = useUi((s) => s.setSection)

  const selected = profiles.find((p) => p.id === selectedId) ?? null
  const state = selectedId ? (health[selectedId]?.state ?? 'disconnected') : 'disconnected'

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className={cx(
          'flex h-8 min-w-44 items-center gap-2 rounded-[var(--radius-pill)] border border-[var(--border-strong)]',
          'bg-[var(--bg-surface)] px-2.5 text-[13px] transition-colors duration-[var(--duration-fast)]',
          'hover:bg-[var(--bg-hover)]'
        )}
      >
        {selected ? (
          <Dot
            color={`var(--cluster-${selected.color})`}
            title={state === 'connected' ? 'Connected' : 'Not connected'}
          />
        ) : (
          <Plug size={13} className="text-[var(--text-muted)]" />
        )}
        <span
          className={cx(
            'min-w-0 flex-1 truncate text-left',
            selected ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
          )}
        >
          {selected?.name ?? 'No cluster'}
        </span>
        {selected?.readOnly && <Lock size={11} className="text-[var(--text-muted)]" />}
        {selected && state !== 'connected' && (
          <span className="text-[10px] text-[var(--text-muted)]">offline</span>
        )}
        <ChevronDown size={13} className="text-[var(--text-muted)]" />
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-50 min-w-64 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-raised)] p-1 shadow-[var(--shadow-md)]"
        >
          {profiles.length === 0 && (
            <div className="px-2 py-2 text-[12px] text-[var(--text-muted)]">
              No clusters registered yet.
            </div>
          )}

          {profiles.map((profile) => {
            const profileState = health[profile.id]?.state ?? 'disconnected'
            return (
              <DropdownMenu.Item
                key={profile.id}
                onSelect={() => {
                  if (profile.id !== selectedId) resetTopics()
                  select(profile.id)
                  // Selecting an offline cluster from here means "take me
                  // there" — connect rather than leaving an inert selection.
                  if (profileState !== 'connected') {
                    void connect(profile.id).catch(() => undefined)
                  }
                }}
                className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-[12px] outline-none data-[highlighted]:bg-[var(--bg-hover)]"
              >
                <Dot color={`var(--cluster-${profile.color})`} />
                <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
                  {profile.name}
                </span>
                {profile.readOnly && <Lock size={11} className="text-[var(--text-muted)]" />}
                <span className="text-[10px] text-[var(--text-muted)]">
                  {profileState === 'connected' ? 'live' : profileState === 'connecting' ? '…' : ''}
                </span>
                {profile.id === selectedId && <Check size={13} className="text-[var(--accent)]" />}
              </DropdownMenu.Item>
            )
          })}

          <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />

          <DropdownMenu.Item
            onSelect={() => {
              setSection('clusters')
              onAddCluster()
            }}
            className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-[12px] text-[var(--accent-text)] outline-none data-[highlighted]:bg-[var(--bg-hover)]"
          >
            <Plus size={13} /> Add cluster…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** Bottom status strip: connection state, cluster facts, version. */
export function StatusBar(): ReactNode {
  const selectedId = useClusters((s) => s.selectedId)
  const health = useClusters((s) => (s.selectedId ? s.health[s.selectedId] : undefined))
  const profile = useClusters((s) => s.profiles.find((p) => p.id === s.selectedId) ?? null)

  const connected = health?.state === 'connected'

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-[var(--border)] bg-[var(--bg-rail)] px-3 text-[11px] text-[var(--text-muted)]">
      <span className="flex items-center gap-1.5">
        <Dot color={connected ? 'var(--ok)' : 'var(--text-muted)'} />
        {!selectedId
          ? 'No cluster selected'
          : connected
            ? `Connected — ${profile?.name ?? ''}`
            : health?.state === 'connecting'
              ? 'Connecting…'
              : 'Disconnected'}
      </span>

      {connected && (
        <>
          <span className="num">
            {health.brokerCount} broker{health.brokerCount === 1 ? '' : 's'}
          </span>
          {/* Zero means "not counted yet": the topic metadata is still being
              fetched in the background, and a status event fills this in. */}
          {health.topicCount > 0 && <span className="num">{health.topicCount} topics</span>}
          <span className="num">{health.latencyMs}ms</span>
          {profile?.readOnly && (
            <span className="flex items-center gap-1 text-[var(--warn)]">
              <Lock size={10} /> read-only
            </span>
          )}
        </>
      )}

      <div className="flex-1" />
      <span className="num">v{__APP_VERSION__}</span>
    </footer>
  )
}
