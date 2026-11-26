import { useState, type ReactNode } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import { Download, GitBranch, SlidersHorizontal, Trash2, X } from 'lucide-react'
import type { ConfigEntry, PartitionDetail } from '@shared/models'
import { useClusters } from '../../stores/clusterStore'
import { useTopics } from '../../stores/topicStore'
import { ApiError, call } from '../../lib/api'
import { formatCount } from '../../lib/format'
import { Badge, Button, EmptyState, Panel, cx } from '../common/ui'
import { DataTable, type Column } from '../common/DataTable'
import { ConfirmDialog, Dialog } from '../common/Dialog'
import { Input } from '../common/ui'
import { EditTopicConfigDialog } from './EditTopicConfigDialog'

export function TopicDetailPanel({ clusterId }: { clusterId: string }): ReactNode {
  const detail = useTopics((s) => s.detail)
  const loading = useTopics((s) => s.detailLoading)
  const selected = useTopics((s) => s.selected)
  const close = useTopics((s) => s.close)
  const loadTopics = useTopics((s) => s.load)
  const openTopic = useTopics((s) => s.open)
  const readOnly = useClusters(
    (s) => s.profiles.find((p) => p.id === clusterId)?.readOnly ?? false
  )

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [partitionsOpen, setPartitionsOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (loading || !detail) {
    return (
      <Panel title={selected ?? "Topic"} className="h-full min-h-0">
        <EmptyState title={loading ? 'Loading topic…' : 'No topic selected'} />
      </Panel>
    )
  }

  const partitionColumns: Column<PartitionDetail>[] = [
    { key: 'p', header: 'Partition', width: '90px', align: 'right', render: (p) => <span className="num">{p.partition}</span> },
    { key: 'leader', header: 'Leader', width: '80px', align: 'right', render: (p) => <span className="num">{p.leader}</span> },
    {
      key: 'replicas',
      header: 'Replicas',
      width: '110px',
      render: (p) => <span className="num">{p.replicas.join(', ')}</span>
    },
    {
      key: 'isr',
      header: 'ISR',
      width: '110px',
      render: (p) => (
        <span
          className={cx('num', p.isr.length < p.replicas.length && 'text-[var(--warn)]')}
        >
          {p.isr.join(', ')}
        </span>
      )
    },
    { key: 'earliest', header: 'Earliest', align: 'right', render: (p) => <span className="num">{formatCount(p.earliestOffset)}</span> },
    { key: 'latest', header: 'Latest', align: 'right', render: (p) => <span className="num">{formatCount(p.latestOffset)}</span> },
    { key: 'count', header: 'Messages', align: 'right', render: (p) => <span className="num">{formatCount(p.messageCount)}</span> }
  ]

  const configColumns: Column<ConfigEntry>[] = [
    {
      key: 'name',
      header: 'Config',
      render: (c) => (
        <span className="flex items-center gap-1.5">
          <span className="num truncate">{c.name}</span>
          {!c.isDefault && <Badge color="json">set</Badge>}
        </span>
      )
    },
    { key: 'value', header: 'Value', render: (c) => <span className="num truncate">{c.value}</span> }
  ]

  return (
    <Panel
      className="h-full min-h-0"
      title={
        <span className="flex items-center gap-2 normal-case">
          <span className="text-[13px] font-semibold text-[var(--text-primary)]">
            {detail.name}
          </span>
          <span className="num text-[11px] font-normal text-[var(--text-muted)]">
            {detail.partitions.length} partitions · {formatCount(detail.totalMessageCount)} messages
          </span>
          {detail.underReplicatedCount > 0 && (
            <Badge color="error">{detail.underReplicatedCount} under-replicated</Badge>
          )}
        </span>
      }
      actions={
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            onClick={() =>
              void call('export:rows', {
                suggestedName: `${detail.name}-partitions`,
                format: 'csv',
                rows: detail.partitions.map((p) => ({
                  partition: p.partition,
                  leader: p.leader,
                  replicas: p.replicas.join(' '),
                  isr: p.isr.join(' '),
                  earliest: p.earliestOffset,
                  latest: p.latestOffset,
                  messages: p.messageCount
                }))
              })
            }
          >
            <Download size={13} /> Export
          </Button>
          <Button size="sm" disabled={readOnly} onClick={() => setConfigOpen(true)}>
            <SlidersHorizontal size={13} /> Configure
          </Button>
          <Button size="sm" disabled={readOnly} onClick={() => setPartitionsOpen(true)}>
            <GitBranch size={13} /> Add partitions
          </Button>
          <Button size="sm" disabled={readOnly} onClick={() => setDeleteOpen(true)}>
            <Trash2 size={13} /> Delete
          </Button>
          <Button size="sm" variant="ghost" aria-label="Close" onClick={close}>
            <X size={14} />
          </Button>
        </div>
      }
    >
      <Tabs.Root defaultValue="partitions" className="flex h-full flex-col">
        <Tabs.List className="flex shrink-0 gap-1 border-b border-[var(--border)] px-2">
          {[
            ['partitions', `Partitions (${detail.partitions.length})`],
            ['configs', `Configuration (${detail.configs.length})`]
          ].map(([value, label]) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className={cx(
                'border-b-2 border-transparent px-2 py-1.5 text-[12px] text-[var(--text-secondary)]',
                'data-[state=active]:border-[var(--accent)] data-[state=active]:text-[var(--text-primary)]'
              )}
            >
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="partitions" className="min-h-0 flex-1">
          <DataTable
            rows={detail.partitions}
            columns={partitionColumns}
            rowKey={(p) => String(p.partition)}
          />
        </Tabs.Content>

        <Tabs.Content value="configs" className="min-h-0 flex-1">
          <DataTable
            rows={detail.configs}
            columns={configColumns}
            rowKey={(c) => c.name}
            empty={<EmptyState title="No configuration returned" hint="The broker may restrict describeConfigs." />}
          />
        </Tabs.Content>
      </Tabs.Root>

      <EditTopicConfigDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        clusterId={clusterId}
        topic={detail.name}
        configs={detail.configs}
        readOnly={readOnly}
        onDone={() => void openTopic(clusterId, detail.name)}
      />

      <AddPartitionsDialog
        open={partitionsOpen}
        onOpenChange={setPartitionsOpen}
        clusterId={clusterId}
        topic={detail.name}
        current={detail.partitions.length}
        onDone={() => {
          void openTopic(clusterId, detail.name)
          void loadTopics(clusterId)
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${detail.name}?`}
        confirmWord={detail.name}
        busy={busy}
        body={
          <>
            Every message in this topic is deleted permanently, across all{' '}
            {detail.partitions.length} partitions ({formatCount(detail.totalMessageCount)}{' '}
            messages). This cannot be undone.
            {error && <div className="mt-1.5 font-medium">{error}</div>}
          </>
        }
        onConfirm={(token) => {
          setBusy(true)
          setError(null)
          void call('topics:delete', clusterId, detail.name, token)
            .then(() => {
              setDeleteOpen(false)
              close()
              return loadTopics(clusterId)
            })
            .catch((err: unknown) =>
              setError(err instanceof ApiError ? err.message : 'Delete failed.')
            )
            .finally(() => setBusy(false))
        }}
      />
    </Panel>
  )
}

function AddPartitionsDialog({
  open,
  onOpenChange,
  clusterId,
  topic,
  current,
  onDone
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clusterId: string
  topic: string
  current: number
  onDone: () => void
}): ReactNode {
  const [total, setTotal] = useState(current + 1)
  const [confirmWord, setConfirmWord] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setTotal(current + 1)
          setConfirmWord('')
          setError(null)
        }
        onOpenChange(next)
      }}
      title={`Add partitions to ${topic}`}
      width="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={busy || confirmWord !== topic || total <= current}
            onClick={() => {
              setBusy(true)
              setError(null)
              void call('topics:addPartitions', clusterId, topic, total, confirmWord)
                .then(() => {
                  onOpenChange(false)
                  onDone()
                })
                .catch((err: unknown) =>
                  setError(err instanceof ApiError ? err.message : 'Could not add partitions.')
                )
                .finally(() => setBusy(false))
            }}
          >
            {busy ? 'Working…' : 'Add partitions'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[12px]">
        <div className="rounded-[var(--radius)] border border-[var(--warn)] bg-[var(--warn-subtle)] p-2.5 text-[var(--text-primary)]">
          Partition count can only go up — Kafka cannot remove partitions afterwards. Adding
          partitions also changes which partition a key hashes to, so existing keys stop landing
          where their earlier messages are.
        </div>

        <label className="flex items-center gap-3">
          <span className="w-32 text-[var(--text-secondary)]">Current</span>
          <span className="num">{current}</span>
        </label>
        <label className="flex items-center gap-3">
          <span className="w-32 text-[var(--text-secondary)]">New total</span>
          <Input
            type="number"
            min={current + 1}
            value={total}
            className="w-28"
            onChange={(e) => setTotal(Number(e.target.value))}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[var(--text-secondary)]">
            Type <code className="num text-[var(--text-primary)]">{topic}</code> to confirm
          </span>
          <Input value={confirmWord} spellCheck={false} onChange={(e) => setConfirmWord(e.target.value)} />
        </label>

        {error && <div className="text-[var(--danger)]">{error}</div>}
      </div>
    </Dialog>
  )
}
