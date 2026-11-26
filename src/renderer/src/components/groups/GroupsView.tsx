import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Activity,
  Download,
  Plug,
  RefreshCw,
  Square,
  Trash2,
  Users
} from 'lucide-react'
import type { GroupDetail, GroupMember, GroupState, GroupSummary, LagRow } from '@shared/models'
import { useClusters } from '../../stores/clusterStore'
import { useTopics } from '../../stores/topicStore'
import { useGroups, visibleGroups, type LagPoint } from '../../stores/groupStore'
import { ApiError, call } from '../../lib/api'
import { formatCount, formatTimestamp } from '../../lib/format'
import { Badge, Button, EmptyState, Input, Panel, cx } from '../common/ui'
import { ConfirmDialog } from '../common/Dialog'
import { DataTable, type Column } from '../common/DataTable'
import { Splitter, clampSize } from '../common/Splitter'
import { ResetOffsetsDialog } from './ResetOffsetsDialog'

/** Group state drives the badge color; only Stable is unambiguously healthy. */
const STATE_COLOR: Record<GroupState, 'json' | 'avro' | 'raw' | 'error'> = {
  Stable: 'json',
  Empty: 'raw',
  PreparingRebalance: 'avro',
  CompletingRebalance: 'avro',
  Dead: 'error',
  Unknown: 'raw'
}

export function GroupsView(): ReactNode {
  const clusterId = useClusters((s) => s.selectedId)
  const connected = useClusters((s) =>
    s.selectedId ? s.health[s.selectedId]?.state === 'connected' : false
  )
  const readOnly = useClusters((s) => s.profiles.find((p) => p.id === s.selectedId)?.readOnly)

  const topics = useTopics((s) => s.topics)
  const loadTopics = useTopics((s) => s.load)

  const groups = useGroups(useShallow(visibleGroups))
  const loading = useGroups((s) => s.loading)
  const error = useGroups((s) => s.error)
  const filter = useGroups((s) => s.filter)
  const topicFilter = useGroups((s) => s.topicFilter)
  const selected = useGroups((s) => s.selected)
  const detail = useGroups((s) => s.detail)
  const detailLoading = useGroups((s) => s.detailLoading)

  const load = useGroups((s) => s.load)
  const setFilter = useGroups((s) => s.setFilter)
  const setTopicFilter = useGroups((s) => s.setTopicFilter)
  const select = useGroups((s) => s.select)
  const watch = useGroups((s) => s.watch)
  const stopLag = useGroups((s) => s.stopLag)
  const reset = useGroups((s) => s.reset)

  const [deleting, setDeleting] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Both panes are draggable: a group with 16 members needs more room than the
  // default split gives it, and someone watching lag wants the opposite.
  const [listWidth, setListWidth] = useState(420)
  const [detailHeight, setDetailHeight] = useState(220)
  // Controlled here, not inside the panel: the grid track has to fall back to
  // `auto` or a collapsed section frees no space at all.
  const [detailCollapsed, setDetailCollapsed] = useState(false)
  const [listCollapsed, setListCollapsed] = useState(false)

  const resizeList = useCallback((delta: number) => {
    setListWidth((w) => clampSize(w + delta, 260, window.innerWidth - 420))
  }, [])
  const resizeDetail = useCallback((delta: number) => {
    setDetailHeight((h) => clampSize(h + delta, 120, window.innerHeight - 260))
  }, [])

  useEffect(() => watch(), [watch])

  // Leaving the section must not leave a lag poller running in main.
  useEffect(() => stopLag, [stopLag])

  useEffect(() => {
    if (!clusterId || !connected) {
      reset()
      return
    }
    void load(clusterId)
    if (topics.length === 0) void loadTopics(clusterId)
    // Reloading on every topic-list change would fight the user's typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, connected])

  if (!clusterId || !connected) {
    return (
      <EmptyState
        icon={<Plug size={28} strokeWidth={1.5} />}
        title="Not connected"
        hint="Connect to a cluster to inspect its consumer groups."
      />
    )
  }

  const columns: Column<GroupSummary>[] = [
    {
      key: 'group',
      header: 'Group',
      render: (g) => <span className="num truncate">{g.groupId}</span>
    },
    {
      key: 'state',
      header: 'State',
      width: '120px',
      render: (g) => <Badge color={STATE_COLOR[g.state]}>{g.state}</Badge>
    },
    {
      key: 'members',
      header: 'Members',
      width: '80px',
      align: 'right',
      // A name-only row was never described; 0 would claim more than we know.
      render: (g) => (
        <span className="num">{g.state === 'Unknown' ? '—' : g.memberCount}</span>
      )
    },
    {
      key: 'topics',
      header: 'Topics',
      width: '32%',
      render: (g) => (
        <span className="num truncate text-[var(--text-secondary)]" title={g.topics.join(', ')}>
          {g.topics.length === 0 ? '—' : g.topics.join(', ')}
        </span>
      )
    }
  ]

  const selectedSummary = groups.find((g) => g.groupId === selected) ?? null

  return (
    <div
      className="grid h-full gap-1.5 p-3"
      style={{ gridTemplateColumns: `${listCollapsed ? 'auto' : `${listWidth}px`} 6px 1fr` }}
    >
      <Panel
        title={`Consumer groups (${groups.length})`}
        collapsible
        collapsed={listCollapsed}
        onCollapsedChange={setListCollapsed}
        actions={
          <Button size="sm" disabled={loading} onClick={() => void load(clusterId)}>
            <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
          </Button>
        }
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-2.5 py-2">
            <input
              list="klarity-topics-groups"
              value={topicFilter}
              spellCheck={false}
              placeholder="Any topic"
              title="Filtering by topic describes every group on the cluster — slow on a big one."
              onChange={(e) => setTopicFilter(e.target.value)}
              onBlur={() => void load(clusterId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void load(clusterId)
              }}
              className="h-7 min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none"
            />
            <datalist id="klarity-topics-groups">
              {topics.map((t) => (
                <option key={t.name} value={t.name} />
              ))}
            </datalist>
            <Input
              value={filter}
              placeholder="Filter groups…"
              className="h-7 min-w-0 flex-1"
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>

          <div className="min-h-0 flex-1">
        {error ? (
          <EmptyState title="Could not list consumer groups" hint={error} />
        ) : loading && groups.length === 0 ? (
          <EmptyState title="Listing groups…" />
        ) : (
          <DataTable
            rows={groups}
            columns={columns}
            rowKey={(g) => g.groupId}
            selectedKey={selected}
            onRowClick={(g) => void select(clusterId, g.groupId)}
            empty={
              <EmptyState
                title="No consumer groups"
                hint={
                  topicFilter
                    ? `No group has committed offsets for "${topicFilter}".`
                    : 'This cluster has no registered groups.'
                }
              />
            }
          />
        )}
          </div>
        </div>
      </Panel>

      <Splitter orientation="vertical" onResize={resizeList} />

      <div
        className="grid min-h-0 gap-1.5"
        style={{ gridTemplateRows: `${detailCollapsed ? 'auto' : `${detailHeight}px`} 6px 1fr` }}
      >
        <Panel
          collapsible
          collapsed={detailCollapsed}
          onCollapsedChange={setDetailCollapsed}
          title={selected ? `Group — ${selected}` : 'Group detail'}
          actions={
            selected && (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={detailLoading}
                  onClick={() => void select(clusterId, selected)}
                >
                  <RefreshCw size={13} className={detailLoading ? 'animate-spin' : undefined} />
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  title={
                    readOnly
                      ? 'This cluster is registered read-only'
                      : detail && detail.members.length > 0
                        ? 'Kafka cannot delete a group that still has members'
                        : undefined
                  }
                  disabled={readOnly || !detail || detail.members.length > 0}
                  onClick={() => {
                    setDeleteError(null)
                    setDeleting(true)
                  }}
                >
                  <Trash2 size={13} /> Delete group
                </Button>
              </div>
            )
          }
        >
          {!selected ? (
            <EmptyState
              icon={<Users size={26} strokeWidth={1.5} />}
              title="No group selected"
              hint="Pick a consumer group to see its members and lag."
            />
          ) : detailLoading && !detail ? (
            <EmptyState title="Describing group…" />
          ) : !detail ? (
            <EmptyState title="Group detail unavailable" hint={error ?? undefined} />
          ) : (
            <GroupDetailBody detail={detail} summary={selectedSummary} />
          )}
        </Panel>

        {detailCollapsed ? <div /> : <Splitter orientation="horizontal" onResize={resizeDetail} />}

        <LagPanel clusterId={clusterId} readOnly={!!readOnly} />
      </div>

      {selected && (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title="Delete consumer group"
          confirmWord={selected}
          confirmLabel="Delete group"
          busy={deleteBusy}
          body={
            <>
              Deleting <strong>{selected}</strong> discards its committed offsets. Any consumer that
              rejoins later starts from its <code>auto.offset.reset</code> policy, not where it left
              off.
              {deleteError && <div className="mt-2 text-[var(--danger)]">{deleteError}</div>}
            </>
          }
          onConfirm={(token) => {
            setDeleteBusy(true)
            setDeleteError(null)
            call('groups:delete', clusterId, selected, token)
              .then(() => {
                setDeleting(false)
                void select(clusterId, null)
                void load(clusterId)
              })
              .catch((err: unknown) =>
                setDeleteError(err instanceof ApiError ? err.message : 'Delete failed.')
              )
              .finally(() => setDeleteBusy(false))
          }}
        />
      )}
    </div>
  )
}

function GroupDetailBody({
  detail,
  summary
}: {
  detail: GroupDetail
  summary: GroupSummary | null
}): ReactNode {
  const columns: Column<GroupMember>[] = [
    {
      key: 'client',
      header: 'Client',
      width: '22%',
      render: (m) => <span className="num truncate">{m.clientId || '—'}</span>
    },
    {
      key: 'host',
      header: 'Host',
      width: '18%',
      render: (m) => <span className="num truncate">{m.clientHost}</span>
    },
    {
      key: 'member',
      header: 'Member ID',
      width: '26%',
      render: (m) => <span className="num truncate text-[var(--text-muted)]">{m.memberId}</span>
    },
    {
      key: 'assignment',
      header: 'Assignment',
      render: (m) => (
        <span className="num truncate">
          {m.assignments.length === 0
            ? '—'
            : m.assignments
                .map((a) => `${a.topic} [${a.partitions.join(', ')}]`)
                .join('  ·  ')}
        </span>
      )
    }
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-4 border-b border-[var(--border)] px-3 py-2 text-[12px]">
        <Fact label="State">
          <Badge color={STATE_COLOR[detail.state]}>{detail.state}</Badge>
        </Fact>
        <Fact label="Members">
          <span className="num">{detail.members.length}</span>
        </Fact>
        <Fact label="Protocol">
          <span className="num">{detail.protocol || '—'}</span>
        </Fact>
        <Fact label="Type">
          <span className="num">{detail.protocolType || '—'}</span>
        </Fact>
        <Fact label="Topics">
          <span className="num truncate">
            {summary && summary.topics.length > 0 ? summary.topics.join(', ') : '—'}
          </span>
        </Fact>
      </div>

      <div className="min-h-0 flex-1">
        <DataTable
          rows={detail.members}
          columns={columns}
          rowKey={(m) => m.memberId}
          empty={
            <EmptyState
              title="No active members"
              hint="The group exists but nothing is consuming — offsets can be reset safely."
            />
          }
        />
      </div>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="text-[11px] tracking-wide text-[var(--text-muted)] uppercase">{label}</span>
      {children}
    </span>
  )
}

function LagPanel({ clusterId, readOnly }: { clusterId: string; readOnly: boolean }): ReactNode {
  const selected = useGroups((s) => s.selected)
  const lagTopic = useGroups((s) => s.lagTopic)
  const setLagTopic = useGroups((s) => s.setLagTopic)
  const jobId = useGroups((s) => s.lagJobId)
  const rows = useGroups((s) => s.lagRows)
  const totalLag = useGroups((s) => s.totalLag)
  const updatedAt = useGroups((s) => s.lagUpdatedAt)
  const history = useGroups((s) => s.history)
  const lagError = useGroups((s) => s.lagError)
  const startLag = useGroups((s) => s.startLag)
  const stopLag = useGroups((s) => s.stopLag)
  const refreshDetail = useGroups((s) => s.refreshDetail)

  const [resetting, setResetting] = useState(false)

  const columns: Column<LagRow>[] = [
    {
      key: 'partition',
      header: 'P',
      width: '50px',
      align: 'right',
      render: (r) => <span className="num">{r.partition}</span>
    },
    {
      key: 'committed',
      header: 'Committed',
      width: '14%',
      align: 'right',
      render: (r) => (
        <span className={cx('num', r.committed === null && 'text-[var(--text-muted)]')}>
          {r.committed === null ? 'none' : formatCount(r.committed)}
        </span>
      )
    },
    {
      key: 'end',
      header: 'End',
      width: '14%',
      align: 'right',
      render: (r) => <span className="num">{formatCount(r.endOffset)}</span>
    },
    {
      key: 'lag',
      header: 'Lag',
      width: '12%',
      align: 'right',
      render: (r) => (
        <span className={cx('num font-semibold', r.lag !== '0' && 'text-[var(--warn)]')}>
          {formatCount(r.lag)}
        </span>
      )
    },
    {
      key: 'bar',
      header: '',
      width: '18%',
      render: (r) => <LagBar lag={r.lag} rows={rows} />
    },
    {
      key: 'owner',
      header: 'Consumer',
      render: (r) => (
        <span className="num truncate text-[var(--text-secondary)]">{r.clientId ?? '—'}</span>
      )
    }
  ]

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Activity size={13} /> Lag
        </span>
      }
      actions={
        <div className="flex items-center gap-2">
          <input
            list="klarity-topics-groups"
            value={lagTopic}
            spellCheck={false}
            placeholder="Topic…"
            disabled={!!jobId}
            onChange={(e) => setLagTopic(e.target.value)}
            className="h-7 w-48 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none disabled:opacity-45"
          />
          {jobId ? (
            <Button size="sm" onClick={stopLag}>
              <Square size={12} /> Stop
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={!selected || !lagTopic.trim()}
              onClick={() => void startLag(clusterId)}
            >
              <Activity size={12} /> Monitor
            </Button>
          )}
          <Button
            size="sm"
            variant="danger"
            title={readOnly ? 'This cluster is registered read-only' : undefined}
            disabled={readOnly || !selected || !lagTopic.trim()}
            onClick={() => setResetting(true)}
          >
            Reset offsets…
          </Button>
          <Button
            size="sm"
            disabled={rows.length === 0}
            onClick={() =>
              void call('export:rows', {
                suggestedName: `${selected ?? 'group'}-${lagTopic}-lag`,
                format: 'csv',
                rows: rows.map((r) => ({
                  partition: r.partition,
                  committed: r.committed,
                  endOffset: r.endOffset,
                  lag: r.lag,
                  clientId: r.clientId ?? null,
                  memberId: r.memberId ?? null
                }))
              })
            }
          >
            <Download size={13} />
          </Button>
        </div>
      }
    >
      {!selected ? (
        <EmptyState title="No group selected" hint="Pick a group to watch its lag." />
      ) : lagError ? (
        <EmptyState title="Lag monitor stopped" hint={lagError} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Activity size={26} strokeWidth={1.5} />}
          title={jobId ? 'Waiting for the first sample…' : 'Not monitoring'}
          hint={
            jobId
              ? undefined
              : 'Choose a topic and press Monitor. Committed and end offsets refresh every 2 seconds.'
          }
        />
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center gap-4 border-b border-[var(--border)] px-3 py-2">
            <div className="flex flex-col">
              <span className="text-[11px] tracking-wide text-[var(--text-muted)] uppercase">
                Total lag
              </span>
              <span className="num text-[18px] font-semibold text-[var(--text-primary)]">
                {formatCount(totalLag)}
              </span>
            </div>
            <LagTrend points={history} />
            <span className="text-[11px] text-[var(--text-muted)]">
              {updatedAt ? formatTimestamp(updatedAt) : ''}
            </span>
          </div>
          <div className="min-h-0 flex-1">
            <DataTable rows={rows} columns={columns} rowKey={(r) => String(r.partition)} />
          </div>
        </div>
      )}

      {selected && lagTopic.trim() && (
        <ResetOffsetsDialog
          open={resetting}
          onOpenChange={setResetting}
          clusterId={clusterId}
          groupId={selected}
          topic={lagTopic.trim()}
          onApplied={() => {
            void refreshDetail(clusterId)
            // A reset while monitoring should show up on the next poll; when
            // idle, one manual sample is what the user expects to see.
            if (!jobId) void startLag(clusterId)
          }}
        />
      )}
    </Panel>
  )
}

/** Per-partition lag bar, scaled to the worst partition in the current sample. */
function LagBar({ lag, rows }: { lag: string; rows: LagRow[] }): ReactNode {
  const max = rows.reduce((acc, r) => Math.max(acc, Number(r.lag)), 0)
  const width = max === 0 ? 0 : Math.min(100, (Number(lag) / max) * 100)
  return (
    <span className="block h-1.5 w-full rounded-[var(--radius-pill)] bg-[var(--bg-sunken)]">
      <span
        className="block h-full rounded-[var(--radius-pill)] bg-[var(--warn)]"
        style={{ width: `${width}%` }}
      />
    </span>
  )
}

/**
 * Total-lag sparkline. Inline SVG rather than a charting dependency: it is one
 * series of at most 60 points, and a chart library would be more code than the
 * polyline it draws.
 */
function LagTrend({ points }: { points: LagPoint[] }): ReactNode {
  const width = 220
  const height = 34

  if (points.length < 2) {
    return <div style={{ width, height }} className="flex-1" aria-hidden />
  }

  const max = Math.max(...points.map((p) => p.lag), 1)
  const step = width / (points.length - 1)
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${(height - (p.lag / max) * (height - 4) - 2).toFixed(1)}`)
    .join(' ')

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Total lag trend, latest ${points[points.length - 1]?.lag ?? 0}`}
      className="shrink-0"
    >
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
    </svg>
  )
}
