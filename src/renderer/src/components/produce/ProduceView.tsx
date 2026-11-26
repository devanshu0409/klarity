import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, FileUp, Plug, Plus, Send, Settings2, X } from 'lucide-react'
import { useClusters } from '../../stores/clusterStore'
import { useTopics } from '../../stores/topicStore'
import {
  produceTabTitle,
  useActiveProduceTab,
  useProduce,
  type HeaderRow
} from '../../stores/produceStore'
import { formatCount, formatTimestamp } from '../../lib/format'
import { Badge, Button, EmptyState, Input, Panel, cx } from '../common/ui'
import { SerdeDialog } from '../browse/SerdeDialog'

export function ProduceView(): ReactNode {
  const clusterId = useClusters((s) => s.selectedId)
  const connected = useClusters((s) =>
    s.selectedId ? s.health[s.selectedId]?.state === 'connected' : false
  )

  if (!clusterId || !connected) {
    return (
      <EmptyState
        icon={<Plug size={28} strokeWidth={1.5} />}
        title="Not connected"
        hint="Connect to a cluster to produce messages."
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      <TabStrip />
      <ProduceWorkspace clusterId={clusterId} />
    </div>
  )
}

/** Each tab is an independent draft: its own topic, key/value/headers and last result. */
function TabStrip(): ReactNode {
  const tabs = useProduce((s) => s.tabs)
  const activeId = useProduce((s) => s.activeId)
  const setActive = useProduce((s) => s.setActive)
  const addTab = useProduce((s) => s.addTab)
  const closeTab = useProduce((s) => s.closeTab)

  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-rail)] px-2 py-1">
      {tabs.map((tab) => {
        const title = produceTabTitle(tab)
        return (
          <div
            key={tab.id}
            role="button"
            tabIndex={0}
            onClick={() => setActive(tab.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') setActive(tab.id)
            }}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(tab.id)
            }}
            className={cx(
              'group flex h-7 max-w-56 shrink-0 cursor-pointer items-center gap-1.5 rounded-[var(--radius-pill)] px-3 text-[12px]',
              'transition-colors duration-[var(--duration-fast)]',
              tab.id === activeId
                ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]'
                : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
            )}
          >
            <span className="truncate">{title}</span>
            <button
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
              className="ml-0.5 shrink-0 rounded-[var(--radius-sm)] p-0.5 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 hover:bg-[var(--bg-active)] hover:text-[var(--text-primary)]"
            >
              <X size={11} />
            </button>
          </div>
        )
      })}

      <Button
        size="sm"
        variant="ghost"
        aria-label="New message tab"
        title="New message tab"
        onClick={() => addTab()}
      >
        <Plus size={14} />
      </Button>
    </div>
  )
}

function ProduceWorkspace({ clusterId }: { clusterId: string }): ReactNode {
  const tab = useActiveProduceTab()
  const readOnly = useClusters((s) => s.profiles.find((p) => p.id === s.selectedId)?.readOnly)
  const topics = useTopics((s) => s.topics)
  const loadTopics = useTopics((s) => s.load)

  const setTopic = useProduce((s) => s.setTopic)
  const setKey = useProduce((s) => s.setKey)
  const setValue = useProduce((s) => s.setValue)
  const setPartition = useProduce((s) => s.setPartition)
  const setHeaders = useProduce((s) => s.setHeaders)
  const setMessageCollapsed = useProduce((s) => s.setMessageCollapsed)
  const loadSerde = useProduce((s) => s.loadSerde)
  const sendSingle = useProduce((s) => s.sendSingle)
  const sendFile = useProduce((s) => s.sendFile)

  const [serdeOpen, setSerdeOpen] = useState(false)

  useEffect(() => {
    if (clusterId && topics.length === 0) void loadTopics(clusterId)
  }, [clusterId, topics.length, loadTopics])

  // The serde decides how the text in the editor becomes bytes, so it is shown
  // next to the editor rather than hidden behind the dialog. Keyed on the tab
  // id too, so switching tabs re-fetches for whichever topic is now active;
  // `serdeOpen` too, so closing the dialog picks up whatever it just changed.
  useEffect(() => {
    void loadSerde(tab.id, clusterId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.topic, clusterId, serdeOpen, loadSerde])

  const ready = tab.topic.trim() !== '' && !tab.busy && !readOnly

  return (
    <div className="grid h-full grid-rows-[auto_1fr] gap-3 p-3">
      <Panel
        title="Message"
        collapsible
        collapsed={tab.messageCollapsed}
        onCollapsedChange={(collapsed) => setMessageCollapsed(tab.id, collapsed)}
      >
        <div className="flex flex-col gap-2.5 p-3">
          <div className="flex flex-wrap items-end gap-2.5">
            <Labeled label="Topic" grow>
              <input
                list="klarity-topics-produce"
                value={tab.topic}
                spellCheck={false}
                placeholder="Choose or type a topic…"
                onChange={(e) => setTopic(tab.id, e.target.value)}
                className="h-8 w-full rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none"
              />
              <datalist id="klarity-topics-produce">
                {topics.map((t) => (
                  <option key={t.name} value={t.name} />
                ))}
              </datalist>
            </Labeled>

            <Labeled label="Key" grow hint="encoded with the key serde">
              <Input
                value={tab.key}
                spellCheck={false}
                placeholder="(none)"
                onChange={(e) => setKey(tab.id, e.target.value)}
              />
            </Labeled>

            <Labeled label="Partition" hint="default: partitioner">
              <Input
                type="number"
                min={0}
                value={tab.partition}
                placeholder="auto"
                className="w-24"
                onChange={(e) => setPartition(tab.id, e.target.value)}
              />
            </Labeled>

            <Button
              size="md"
              disabled={tab.topic.trim() === ''}
              onClick={() => setSerdeOpen(true)}
              title="How this topic's key and value are encoded"
            >
              <Settings2 size={13} />
              {tab.serde ? (
                <span className="flex items-center gap-1">
                  <Badge color={badgeColor(tab.serde.key.kind)}>{tab.serde.key.kind}</Badge>
                  <span className="text-[var(--text-muted)]">/</span>
                  <Badge color={badgeColor(tab.serde.value.kind)}>{tab.serde.value.kind}</Badge>
                </span>
              ) : (
                'Serde'
              )}
            </Button>
          </div>

          <Headers rows={tab.headers} onChange={(headers) => setHeaders(tab.id, headers)} />
        </div>
      </Panel>

      <Panel
        title="Value"
        actions={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={!ready}
              title="Send a file's exact bytes as the value"
              onClick={() => void sendFile(tab.id, clusterId, 'value', 'binary')}
            >
              <FileUp size={13} /> File as value (binary)
            </Button>
            <Button
              size="sm"
              disabled={!ready}
              title="Send a file's exact bytes as the key; the editor holds the value"
              onClick={() => void sendFile(tab.id, clusterId, 'key', 'binary')}
            >
              <FileUp size={13} /> File as key
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!ready}
              onClick={() => void sendSingle(tab.id, clusterId)}
            >
              <Send size={13} /> {tab.busy ? 'Sending…' : 'Send'}
            </Button>
          </div>
        }
      >
        <div className="flex h-full min-h-0 flex-col gap-2 p-3">
          {readOnly && (
            <Note tone="warn">
              This cluster is registered read-only. Producing is blocked in the main process.
            </Note>
          )}
          {tab.error && <Note tone="danger">{tab.error}</Note>}
          {tab.result && (
            <Note tone="ok">
              Delivered to <strong>{tab.result.topic}</strong> partition{' '}
              <strong className="num">{tab.result.partition}</strong> at offset{' '}
              <strong className="num">{formatCount(tab.result.offset)}</strong> ·{' '}
              {formatTimestamp(tab.result.timestamp)}
            </Note>
          )}

          <textarea
            value={tab.value}
            spellCheck={false}
            placeholder={
              tab.serde?.value.kind === 'protobuf' || tab.serde?.value.kind === 'flatbuffers'
                ? 'JSON matching the configured schema — it is encoded to bytes before sending.'
                : 'Message value. Sent as UTF-8 unless the topic has a schema serde.'
            }
            onChange={(e) => setValue(tab.id, e.target.value)}
            className="num min-h-0 flex-1 resize-none rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-surface)] p-2.5 text-[12px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none"
          />
        </div>
      </Panel>

      {tab.topic.trim() && (
        <SerdeDialog
          open={serdeOpen}
          onOpenChange={setSerdeOpen}
          clusterId={clusterId}
          topic={tab.topic.trim()}
        />
      )}
    </div>
  )
}

function badgeColor(kind: string): Parameters<typeof Badge>[0]['color'] {
  if (kind.startsWith('int') || kind.startsWith('float')) return 'number'
  if (kind === 'protobuf' || kind === 'proto-string') return 'protobuf'
  if (kind === 'flatbuffers') return 'flatbuffers'
  if (kind === 'avro-sr') return 'avro'
  if (kind === 'json') return 'json'
  if (kind === 'string') return 'string'
  return 'raw'
}

function Headers({
  rows,
  onChange
}: {
  rows: HeaderRow[]
  onChange: (rows: HeaderRow[]) => void
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] tracking-wide text-[var(--text-muted)] uppercase">Headers</span>
      {rows.map((row) => (
        <div key={row.id} className="flex items-center gap-2">
          <Input
            value={row.name}
            spellCheck={false}
            placeholder="name"
            className="w-56 shrink-0"
            onChange={(e) =>
              onChange(rows.map((r) => (r.id === row.id ? { ...r, name: e.target.value } : r)))
            }
          />
          <Input
            value={row.value}
            spellCheck={false}
            placeholder="value"
            className="min-w-0 flex-1"
            onChange={(e) =>
              onChange(rows.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))
            }
          />
          <Button
            size="sm"
            variant="ghost"
            aria-label="Remove header"
            disabled={rows.length === 1}
            onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
          >
            <X size={13} />
          </Button>
        </div>
      ))}
      <div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange([...rows, { id: Date.now(), name: '', value: '' }])}
        >
          <Plus size={13} /> Add header
        </Button>
      </div>
    </div>
  )
}

function Note({ tone, children }: { tone: 'ok' | 'warn' | 'danger'; children: ReactNode }): ReactNode {
  const border = { ok: 'var(--ok)', warn: 'var(--warn)', danger: 'var(--danger)' }[tone]
  return (
    <div
      className="flex shrink-0 items-start gap-2 rounded-[var(--radius)] border p-2.5 text-[12px] text-[var(--text-primary)]"
      style={{ borderColor: border }}
    >
      {tone === 'ok' ? (
        <Check size={15} className="mt-0.5 shrink-0" style={{ color: border }} />
      ) : (
        <AlertTriangle size={15} className="mt-0.5 shrink-0" style={{ color: border }} />
      )}
      <span>{children}</span>
    </div>
  )
}

function Labeled({
  label,
  hint,
  grow,
  children
}: {
  label: string
  hint?: string
  grow?: boolean
  children: ReactNode
}): ReactNode {
  return (
    <label className={cx('flex flex-col gap-1', grow && 'min-w-48 flex-1')}>
      <span className="flex items-baseline gap-1.5">
        <span className="text-[11px] tracking-wide text-[var(--text-muted)] uppercase">{label}</span>
        {hint && <span className="text-[10px] text-[var(--text-muted)]">{hint}</span>}
      </span>
      {children}
    </label>
  )
}
