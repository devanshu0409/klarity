import { useCallback, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Download,
  Loader2,
  Plug,
  Plus
} from 'lucide-react'
import type { TopicSummary } from '@shared/models'
import { useClusters } from '../../stores/clusterStore'
import { useTopics, visibleTopics } from '../../stores/topicStore'
import { call } from '../../lib/api'

import { Badge, Button, EmptyState, Panel } from '../common/ui'
import { DataTable, type Column } from '../common/DataTable'
import { Splitter, clampSize } from '../common/Splitter'
import { TopicToolbar, useTopicsForSelectedCluster } from '../clusters/ClustersView'
import { TopicDetailPanel } from './TopicDetailPanel'
import { CreateTopicDialog } from './CreateTopicDialog'

export function TopicsPanel(): ReactNode {
  const { clusterId, connected } = useTopicsForSelectedCluster()
  const profiles = useClusters((s) => s.profiles)
  const connect = useClusters((s) => s.connect)

  // `visibleTopics` builds a new array each call, so without a shallow compare
  // zustand sees a fresh snapshot every render and loops forever.
  const topics = useTopics(useShallow(visibleTopics))
  const loading = useTopics((s) => s.loading)
  const error = useTopics((s) => s.error)
  const selected = useTopics((s) => s.selected)
  const load = useTopics((s) => s.load)
  const open = useTopics((s) => s.open)

  const [createOpen, setCreateOpen] = useState(false)
  // Detail pane height in px; the topics list takes whatever is left.
  const [detailHeight, setDetailHeight] = useState(340)
  const [listCollapsed, setListCollapsed] = useState(false)

  const resizeDetail = useCallback((delta: number) => {
    // Dragging the splitter down shrinks the detail pane, hence the negation.
    setDetailHeight((h) => clampSize(h - delta, 120, window.innerHeight - 220))
  }, [])

  const profile = profiles.find((p) => p.id === clusterId) ?? null

  if (!clusterId) {
    return (
      <Panel title="Topics">
        <EmptyState title="Select a cluster" hint="Pick a cluster on the left to see its topics." />
      </Panel>
    )
  }

  if (!connected) {
    return (
      <Panel title="Topics">
        <EmptyState
          icon={<Plug size={26} strokeWidth={1.5} />}
          title={`${profile?.name ?? 'Cluster'} is not connected`}
          hint="Connect to load topics, partitions and configuration."
          action={
            <Button variant="primary" onClick={() => void connect(clusterId).catch(() => undefined)}>
              Connect
            </Button>
          }
        />
      </Panel>
    )
  }

  const columns: Column<TopicSummary>[] = [
    {
      key: 'name',
      header: 'Topic',
      render: (t) => (
        <span className="flex items-center gap-1.5">
          <span className="truncate">{t.name}</span>
          {t.isInternal && <Badge color="raw">internal</Badge>}
          {t.underReplicated && (
            <span title="Under-replicated partitions">
              <AlertTriangle size={12} className="text-[var(--warn)]" />
            </span>
          )}
        </span>
      )
    },
    {
      key: 'partitions',
      header: 'Parts',
      width: '70px',
      align: 'right',
      render: (t) => <span className="num">{t.partitionCount}</span>
    },
    {
      key: 'replication',
      header: 'RF',
      width: '55px',
      align: 'right',
      render: (t) => <span className="num">{t.replicationFactor}</span>
    },
    {
      key: 'status',
      header: 'Status',
      width: '110px',
      render: (t) =>
        t.underReplicated ? (
          <span className="text-[var(--warn)]">under-replicated</span>
        ) : (
          <span className="text-[var(--text-muted)]">ok</span>
        )
    }
  ]

  return (
    <div
      className="grid min-h-0"
      style={{
        // Collapsed, the list keeps only its header bar so the toolbar and the
        // expand control stay reachable.
        gridTemplateRows: selected
          ? listCollapsed
            ? 'auto 6px 1fr'
            : `1fr 6px ${detailHeight}px`
          : '1fr'
      }}
    >
      <Panel
        title="Topics"
        className={listCollapsed ? 'overflow-hidden' : undefined}
        actions={
          <div className="flex items-center gap-2">
            {loading && topics.length > 0 && (
              <Loader2 size={13} className="animate-spin text-[var(--text-muted)]" />
            )}
            <TopicToolbar onRefresh={() => void load(clusterId, true)} />
            <Button
              size="sm"
              onClick={() =>
                void call('export:rows', {
                  suggestedName: `topics-${profile?.name ?? 'cluster'}`,
                  format: 'csv',
                  rows: topics.map((t) => ({
                    topic: t.name,
                    partitions: t.partitionCount,
                    replicationFactor: t.replicationFactor,

                    internal: t.isInternal,
                    underReplicated: t.underReplicated
                  }))
                })
              }
            >
              <Download size={13} /> Export
            </Button>
            <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus size={13} /> Topic
            </Button>
            {selected && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={listCollapsed ? 'Expand topic list' : 'Collapse topic list'}
                title={listCollapsed ? 'Expand topic list' : 'Collapse topic list'}
                onClick={() => setListCollapsed((c) => !c)}
              >
                {listCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              </Button>
            )}
          </div>
        }
      >
        {/* Collapsed keeps the header only; the body is what gets hidden. */}
        {listCollapsed ? null : error ? (
          <EmptyState title="Could not load topics" hint={error} />
        ) : loading && topics.length === 0 ? (
          <EmptyState title="Loading topics…" />
        ) : (
          <DataTable
            rows={topics}
            columns={columns}
            rowKey={(t) => t.name}
            selectedKey={selected}
            onRowClick={(t) => void open(clusterId, t.name)}
            empty={<EmptyState title="No topics match" hint="Clear the filter to see everything." />}
          />
        )}
      </Panel>

      {selected && (
        <Splitter onResize={resizeDetail} onDoubleClick={() => setDetailHeight(340)} />
      )}

      {selected && <TopicDetailPanel clusterId={clusterId} />}

      <CreateTopicDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        clusterId={clusterId}
        readOnly={profile?.readOnly ?? false}
      />
    </div>
  )
}
