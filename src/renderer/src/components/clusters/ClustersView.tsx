import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  Lock,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Unplug
} from 'lucide-react'
import type { ClusterProfile } from '@shared/models'
import { useClusters } from '../../stores/clusterStore'
import { useTopics, visibleTopics } from '../../stores/topicStore'
import { Badge, Button, Dot, EmptyState, Input, Panel, cx } from '../common/ui'
import { ConfirmDialog } from '../common/Dialog'
import { ClusterDialog } from './ClusterDialog'
import { TopicsPanel } from '../topics/TopicsPanel'

const COLLAPSED_FOLDERS_KEY = 'klarity.collapsedClusterFolders'

function loadCollapsedFolders(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_FOLDERS_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

export function ClustersView(): ReactNode {
  const profiles = useClusters((s) => s.profiles)
  const selectedId = useClusters((s) => s.selectedId)
  const health = useClusters((s) => s.health)
  const loading = useClusters((s) => s.loading)
  const select = useClusters((s) => s.select)
  const connect = useClusters((s) => s.connect)
  const disconnect = useClusters((s) => s.disconnect)
  const remove = useClusters((s) => s.remove)
  const clone = useClusters((s) => s.clone)

  const resetTopics = useTopics((s) => s.reset)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ClusterProfile | null>(null)
  const [deleting, setDeleting] = useState<ClusterProfile | null>(null)
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsedFolders)

  const toggleFolder = (folder: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      try {
        localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify([...next]))
      } catch {
        // Per-viewer convenience only; fine to lose across a private session.
      }
      return next
    })
  }

  const { grouped, ungrouped } = useMemo(() => {
    const grouped = new Map<string, ClusterProfile[]>()
    const ungrouped: ClusterProfile[] = []
    for (const p of profiles) {
      if (p.folder) {
        const list = grouped.get(p.folder) ?? []
        list.push(p)
        grouped.set(p.folder, list)
      } else {
        ungrouped.push(p)
      }
    }
    return { grouped: new Map([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))), ungrouped }
  }, [profiles])

  const openCreate = (): void => {
    setEditing(null)
    setDialogOpen(true)
  }

  const openEdit = (profile: ClusterProfile): void => {
    setEditing(profile)
    setDialogOpen(true)
  }

  if (!loading && profiles.length === 0) {
    return (
      <>
        <EmptyState
          icon={<Server size={30} strokeWidth={1.5} />}
          title="No clusters yet"
          hint="Add a Kafka cluster to browse its topics, partitions and consumer groups."
          action={
            <Button variant="primary" onClick={openCreate}>
              <Plus size={14} /> Add cluster
            </Button>
          }
        />
        <ClusterDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} />
      </>
    )
  }

  return (
    <div className="grid h-full grid-cols-[300px_1fr] gap-3 p-3">
      <Panel
        title="Clusters"
        actions={
          <Button size="sm" variant="primary" onClick={openCreate}>
            <Plus size={13} /> Add
          </Button>
        }
      >
        <div className="flex flex-col">
          {ungrouped.length > 0 && (
            <ul className="flex flex-col">
              {ungrouped.map((profile) => (
                <ClusterRow
                  key={profile.id}
                  profile={profile}
                  isSelected={profile.id === selectedId}
                  state={health[profile.id]?.state ?? 'disconnected'}
                  healthError={health[profile.id]?.error}
                  onSelect={() => {
                    if (profile.id !== selectedId) resetTopics()
                    select(profile.id)
                  }}
                  onConnect={() => void connect(profile.id).catch(() => undefined)}
                  onDisconnect={() => {
                    resetTopics()
                    void disconnect(profile.id)
                  }}
                  onEdit={() => openEdit(profile)}
                  onClone={() => void clone(profile.id).catch(() => undefined)}
                  onDelete={() => setDeleting(profile)}
                />
              ))}
            </ul>
          )}

          {[...grouped.entries()].map(([folder, items]) => {
            const isCollapsed = collapsed.has(folder)
            return (
              <div key={folder}>
                <button
                  onClick={() => toggleFolder(folder)}
                  className="flex w-full items-center gap-1.5 border-b border-[var(--border)] bg-[var(--bg-hover)] px-3 py-1.5 text-left text-[11px] font-semibold tracking-wide text-[var(--text-secondary)] uppercase hover:text-[var(--text-primary)]"
                >
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <Folder size={11} />
                  <span className="min-w-0 flex-1 truncate normal-case">{folder}</span>
                  <span className="num font-normal text-[var(--text-muted)]">{items.length}</span>
                </button>
                {!isCollapsed && (
                  <ul className="flex flex-col">
                    {items.map((profile) => (
                      <ClusterRow
                        key={profile.id}
                        profile={profile}
                        isSelected={profile.id === selectedId}
                        state={health[profile.id]?.state ?? 'disconnected'}
                        healthError={health[profile.id]?.error}
                        onSelect={() => {
                          if (profile.id !== selectedId) resetTopics()
                          select(profile.id)
                        }}
                        onConnect={() => void connect(profile.id).catch(() => undefined)}
                        onDisconnect={() => {
                          resetTopics()
                          void disconnect(profile.id)
                        }}
                        onEdit={() => openEdit(profile)}
                        onClone={() => void clone(profile.id).catch(() => undefined)}
                        onDelete={() => setDeleting(profile)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      </Panel>

      <TopicsPanel />

      <ClusterDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Remove ${deleting?.name ?? ''}?`}
        confirmWord={deleting?.name ?? ''}
        confirmLabel="Remove cluster"
        busy={busy}
        body={
          <>
            This removes the saved connection and its stored password from this machine. The
            Kafka cluster itself is not touched.
          </>
        }
        onConfirm={() => {
          if (!deleting) return
          setBusy(true)
          void remove(deleting.id)
            .then(() => {
              resetTopics()
              setDeleting(null)
            })
            .finally(() => setBusy(false))
        }}
      />
    </div>
  )
}

function StateChip({ state }: { state: string }): ReactNode {
  if (state === 'connected') return <Badge color="flatbuffers">live</Badge>
  if (state === 'connecting') return <Badge color="avro">…</Badge>
  return <Badge color="raw">off</Badge>
}

function ClusterRow({
  profile,
  isSelected,
  state,
  healthError,
  onSelect,
  onConnect,
  onDisconnect,
  onEdit,
  onClone,
  onDelete
}: {
  profile: ClusterProfile
  isSelected: boolean
  state: string
  healthError?: string
  onSelect: () => void
  onConnect: () => void
  onDisconnect: () => void
  onEdit: () => void
  onClone: () => void
  onDelete: () => void
}): ReactNode {
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onSelect()
        }}
        className={cx(
          'group flex cursor-pointer flex-col gap-1 border-b border-[var(--border)] py-2.5 pr-3',
          // A left accent bar rather than a filled row: the brand red
          // as a full background reads as an alert, not a selection.
          isSelected
            ? 'border-l-2 border-l-[var(--accent)] bg-[var(--bg-active)] pl-[10px]'
            : 'pl-3 hover:bg-[var(--bg-hover)]'
        )}
      >
        <div className="flex items-center gap-2">
          <Dot color={`var(--cluster-${profile.color})`} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">
            {profile.name}
          </span>
          {profile.readOnly && (
            <Lock size={11} className="text-[var(--text-muted)]" aria-label="Read-only" />
          )}
          <StateChip state={state} />
        </div>

        <div className="num truncate text-[11px] text-[var(--text-muted)]">
          {profile.bootstrapServers}
        </div>

        {isSelected && (
          <div className="mt-1 flex items-center gap-1.5">
            {state === 'connected' ? (
              <Button
                size="sm"
                onClick={(e) => {
                  e.stopPropagation()
                  onDisconnect()
                }}
              >
                <Unplug size={12} /> Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                disabled={state === 'connecting'}
                onClick={(e) => {
                  e.stopPropagation()
                  onConnect()
                }}
              >
                <Plug size={12} />
                {state === 'connecting' ? 'Connecting…' : 'Connect'}
              </Button>
            )}
            <Button
              size="sm"
              aria-label="Edit"
              onClick={(e) => {
                e.stopPropagation()
                onEdit()
              }}
            >
              <Pencil size={12} />
            </Button>
            <Button
              size="sm"
              aria-label="Clone"
              onClick={(e) => {
                e.stopPropagation()
                onClone()
              }}
            >
              <Copy size={12} />
            </Button>
            <Button
              size="sm"
              aria-label="Delete"
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
            >
              <Trash2 size={12} />
            </Button>
          </div>
        )}

        {healthError && isSelected && (
          <div className="flex items-start gap-1.5 text-[11px] text-[var(--danger)]">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span className="min-w-0">{healthError}</span>
          </div>
        )}
      </div>
    </li>
  )
}

/** Search + refresh bar shared by the topics panel. */
export function TopicToolbar({ onRefresh }: { onRefresh: () => void }): ReactNode {
  const filter = useTopics((s) => s.filter)
  const setFilter = useTopics((s) => s.setFilter)
  const showInternal = useTopics((s) => s.showInternal)
  const setShowInternal = useTopics((s) => s.setShowInternal)
  const count = useTopics((s) => visibleTopics(s).length)

  return (
    <div className="flex items-center gap-2">
      <Input
        value={filter}
        placeholder="Filter topics…"
        className="h-7 w-52"
        onChange={(e) => setFilter(e.target.value)}
      />
      <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
        <input
          type="checkbox"
          checked={showInternal}
          onChange={(e) => setShowInternal(e.target.checked)}
          className="size-3 accent-[var(--accent)]"
        />
        Internal
      </label>
      <span className="num text-[11px] text-[var(--text-muted)]">{count}</span>
      <Button size="sm" variant="ghost" aria-label="Refresh" onClick={onRefresh}>
        <RefreshCw size={13} />
      </Button>
    </div>
  )
}

/** Re-loads topics whenever the selected cluster becomes connected. */
export function useTopicsForSelectedCluster(): { clusterId: string | null; connected: boolean } {
  const selectedId = useClusters((s) => s.selectedId)
  const connected = useClusters((s) =>
    s.selectedId ? s.health[s.selectedId]?.state === 'connected' : false
  )
  const load = useTopics((s) => s.load)

  useEffect(() => {
    if (selectedId && connected) void load(selectedId)
  }, [selectedId, connected, load])

  return { clusterId: selectedId, connected }
}
