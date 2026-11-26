import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Download,
  FolderClosed,
  FolderPlus,
  Loader2,
  Pencil,
  Plug,
  Plus,
  Radio,
  Search,
  SlidersHorizontal,
  Square,
  Trash2,
  X
} from 'lucide-react'
import type { DecodedMessage, TabGroup } from '@shared/models'
import { useClusters } from '../../stores/clusterStore'
import { useTopics } from '../../stores/topicStore'
import { useTabGroups } from '../../stores/tabGroupStore'
import {
  orderedMessages,
  tabTitle,
  useActiveTab,
  useMessages,
  type BrowseTab
} from '../../stores/messageStore'
import { call } from '../../lib/api'
import { formatCount, formatDuration, formatTimestamp } from '../../lib/format'
import { Badge, Button, EmptyState, Input, Panel, cx } from '../common/ui'
import { ConfirmDialog } from '../common/Dialog'
import { DataTable, type Column } from '../common/DataTable'
import { Splitter, clampSize } from '../common/Splitter'
import { GroupDialog } from './GroupDialog'
import { MessageDetail, formatBadge } from './MessageDetail'
import { SerdeDialog } from './SerdeDialog'

export function BrowseView(): ReactNode {
  const clusterId = useClusters((s) => s.selectedId)
  const connected = useClusters((s) =>
    s.selectedId ? s.health[s.selectedId]?.state === 'connected' : false
  )
  const topics = useTopics((s) => s.topics)
  const loadTopics = useTopics((s) => s.load)
  const watch = useMessages((s) => s.watch)

  useEffect(() => watch(), [watch])

  // The topic picker needs the topic list even when the user came straight here.
  useEffect(() => {
    if (clusterId && connected && topics.length === 0) void loadTopics(clusterId)
  }, [clusterId, connected, topics.length, loadTopics])

  if (!clusterId || !connected) {
    return (
      <EmptyState
        icon={<Plug size={28} strokeWidth={1.5} />}
        title="Not connected"
        hint="Connect to a cluster to browse its messages."
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      <TabStrip clusterId={clusterId} />
      <SearchWorkspace clusterId={clusterId} />
    </div>
  )
}

/**
 * Each tab is an independent search. Running jobs keep streaming into their own
 * tab while another is in front, so several topics can be scanned at once.
 */
function TabStrip({ clusterId }: { clusterId: string }): ReactNode {
  // Select the stable `tabs` array itself and derive the display shape in
  // render: a selector that builds fresh objects can never be shallow-compared,
  // so zustand would see a new snapshot every render and loop.
  const tabs = useMessages((s) => s.tabs)
  const activeId = useMessages((s) => s.activeId)
  const setActive = useMessages((s) => s.setActive)
  const addTab = useMessages((s) => s.addTab)
  const closeTab = useMessages((s) => s.closeTab)

  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-rail)] px-2 py-1">
      {tabs.map((tab) => {
        const title = tabTitle(tab)
        const busy = tab.mode !== 'idle'
        const count = tab.messages.length
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
            // Middle-click closes, as in a browser.
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
          {busy && <Loader2 size={11} className="shrink-0 animate-spin text-[var(--accent)]" />}
          <span className="truncate">{title}</span>
          {count > 0 && (
            <span className="num shrink-0 text-[10px] text-[var(--text-muted)]">
              {formatCount(count)}
            </span>
          )}
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
        aria-label="New search tab"
        title="New search tab"
        onClick={() => addTab()}
      >
        <Plus size={14} />
      </Button>

      <div className="flex-1" />

      <GroupsMenu clusterId={clusterId} tabs={tabs} addTab={addTab} setActive={setActive} />
    </div>
  )
}

/**
 * Saves the currently open topics as a named group, and reopens a saved group
 * later by adding a tab for every topic not already open — existing tabs and
 * their in-progress scans are left alone.
 */
function GroupsMenu({
  clusterId,
  tabs,
  addTab,
  setActive
}: {
  clusterId: string
  tabs: BrowseTab[]
  addTab: (topic?: string) => string
  setActive: (id: string) => void
}): ReactNode {
  const groups = useTabGroups((s) => s.groups)
  const loadGroups = useTabGroups((s) => s.load)
  const removeGroup = useTabGroups((s) => s.remove)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<TabGroup | null>(null)
  const [deleting, setDeleting] = useState<TabGroup | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void loadGroups(clusterId)
  }, [clusterId, loadGroups])

  const openGroup = (group: TabGroup): void => {
    let firstId: string | null = null
    for (const topic of group.topics) {
      const existing = tabs.find((t) => t.filters.topic === topic)
      const id = existing?.id ?? addTab(topic)
      if (!firstId) firstId = id
    }
    if (firstId) setActive(firstId)
  }

  const currentTopics = [...new Set(tabs.map((t) => t.filters.topic.trim()).filter(Boolean))]

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button size="sm" variant="ghost" title="Saved tab groups">
            <FolderClosed size={13} /> Groups
            {groups.length > 0 && (
              <span className="num text-[10px] text-[var(--text-muted)]">{groups.length}</span>
            )}
            <ChevronDown size={11} />
          </Button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-50 min-w-64 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-raised)] p-1 shadow-[var(--shadow-md)]"
          >
            {groups.length === 0 && (
              <div className="px-2 py-2 text-[12px] text-[var(--text-muted)]">
                No saved groups yet.
              </div>
            )}

            {groups.map((group) => (
              <DropdownMenu.Item
                key={group.id}
                onSelect={(e) => {
                  // Keep the menu open while the edit/delete icon buttons are used.
                  e.preventDefault()
                  openGroup(group)
                }}
                className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-[12px] outline-none data-[highlighted]:bg-[var(--bg-hover)]"
              >
                <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
                  {group.name}
                </span>
                <span className="num text-[10px] text-[var(--text-muted)]">
                  {group.topics.length}
                </span>
                <button
                  aria-label={`Edit ${group.name}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditing(group)
                    setDialogOpen(true)
                  }}
                  className="shrink-0 rounded-[var(--radius-sm)] p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-active)] hover:text-[var(--text-primary)]"
                >
                  <Pencil size={11} />
                </button>
                <button
                  aria-label={`Delete ${group.name}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setDeleting(group)
                  }}
                  className="shrink-0 rounded-[var(--radius-sm)] p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-active)] hover:text-[var(--text-primary)]"
                >
                  <Trash2 size={11} />
                </button>
              </DropdownMenu.Item>
            ))}

            <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />

            <DropdownMenu.Item
              disabled={currentTopics.length === 0}
              onSelect={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
              className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-[12px] text-[var(--accent-text)] outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-[var(--bg-hover)]"
            >
              <FolderPlus size={13} /> Save open tabs as group…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <GroupDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        clusterId={clusterId}
        editing={editing}
        initialTopics={currentTopics}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? ''}?`}
        confirmWord={deleting?.name ?? ''}
        confirmLabel="Delete group"
        busy={busy}
        body={<>This removes the saved group. The topics themselves are not touched.</>}
        onConfirm={() => {
          if (!deleting) return
          setBusy(true)
          void removeGroup(deleting.id)
            .then(() => setDeleting(null))
            .finally(() => setBusy(false))
        }}
      />
    </>
  )
}

function SearchWorkspace({ clusterId }: { clusterId: string }): ReactNode {
  const tab = useActiveTab()
  const topics = useTopics((s) => s.topics)

  const setFilters = useMessages((s) => s.setFilters)
  const setNewestFirst = useMessages((s) => s.setNewestFirst)
  const select = useMessages((s) => s.select)
  const search = useMessages((s) => s.search)
  const tail = useMessages((s) => s.tail)
  const stop = useMessages((s) => s.stop)
  const clear = useMessages((s) => s.clear)

  const messages = useMessages(
    useShallow((s) => {
      const active = s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0]
      return orderedMessages(active)
    })
  )

  const [serdeOpen, setSerdeOpen] = useState(false)
  // Half the window: a decoded protobuf record is wide, and the old 480px default
  // meant dragging the splitter open on almost every inspection.
  const [detailWidth, setDetailWidth] = useState(() => Math.round(window.innerWidth / 2))
  const resizeDetail = useCallback((delta: number) => {
    setDetailWidth((w) => clampSize(w - delta, 280, window.innerWidth - 420))
  }, [])

  const { filters } = tab
  const busy = tab.mode !== 'idle'
  const canRun = filters.topic.trim().length > 0

  const columns: Column<DecodedMessage>[] = [
    {
      key: 'partition',
      header: 'P',
      width: '48px',
      align: 'right',
      render: (m) => <span className="num">{m.partition}</span>
    },
    {
      key: 'offset',
      header: 'Offset',
      width: '110px',
      align: 'right',
      render: (m) => <span className="num">{formatCount(m.offset)}</span>
    },
    {
      key: 'timestamp',
      header: (
        <button
          type="button"
          onClick={() => setNewestFirst(tab.id, !tab.newestFirst)}
          title={tab.newestFirst ? 'Newest first — click for oldest' : 'Oldest first — click for newest'}
          className="flex items-center gap-1 uppercase hover:text-[var(--text-primary)]"
        >
          Timestamp
          {tab.newestFirst ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
        </button>
      ),
      width: '175px',
      render: (m) => <span className="num">{formatTimestamp(m.timestamp)}</span>
    },
    { key: 'format', header: 'Format', width: '96px', render: (m) => formatBadge(m.value) },
    {
      key: 'key',
      header: 'Key',
      width: '150px',
      render: (m) => (
        <span className="num truncate text-[var(--text-secondary)]">
          {m.key.format === 'null' ? '—' : m.key.text}
        </span>
      )
    },
    {
      key: 'value',
      header: 'Value',
      render: (m) => (
        <span className="num truncate">{m.value.text.replace(/\s+/g, ' ').slice(0, 400)}</span>
      )
    }
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <Panel title="Search" collapsible>
        <div className="flex flex-col gap-2.5 p-3">
          <div className="flex flex-wrap items-end gap-2.5">
            <Labeled label="Topic" grow>
              <input
                list="klarity-topics"
                value={filters.topic}
                spellCheck={false}
                placeholder="Choose or type a topic…"
                onChange={(e) => setFilters(tab.id, { topic: e.target.value })}
                className="h-8 w-full rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none"
              />
              <datalist id="klarity-topics">
                {topics.map((t) => (
                  <option key={t.name} value={t.name} />
                ))}
              </datalist>
            </Labeled>

            <Labeled label="Contains" grow hint="a && b  ·  a || b">
              <Input
                value={filters.filter}
                spellCheck={false}
                placeholder="text to match in the decoded message"
                onChange={(e) => setFilters(tab.id, { filter: e.target.value })}
              />
            </Labeled>

            <Labeled label="Partition">
              <Input
                type="number"
                min={0}
                value={filters.partition ?? ''}
                placeholder="all"
                className="w-24"
                onChange={(e) =>
                  setFilters(tab.id, {
                    partition: e.target.value === '' ? null : Number(e.target.value)
                  })
                }
              />
            </Labeled>

            <Labeled label="Max results">
              <Input
                type="number"
                min={1}
                value={filters.maxResults}
                className="w-24"
                onChange={(e) => setFilters(tab.id, { maxResults: Number(e.target.value) })}
              />
            </Labeled>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={filters.useTimeRange}
                onChange={(e) => setFilters(tab.id, { useTimeRange: e.target.checked })}
                className="size-3.5 accent-[var(--accent)]"
              />
              Time range
            </label>
            {filters.useTimeRange && (
              <>
                <DateTime
                  label="From"
                  value={filters.fromMs}
                  onChange={(fromMs) => setFilters(tab.id, { fromMs })}
                />
                <DateTime
                  label="To"
                  value={filters.toMs}
                  onChange={(toMs) => setFilters(tab.id, { toMs })}
                />
              </>
            )}

            <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={filters.fromBeginning}
                onChange={(e) => setFilters(tab.id, { fromBeginning: e.target.checked })}
                className="size-3.5 accent-[var(--accent)]"
              />
              From beginning
            </label>
            {filters.fromBeginning && (
              <span className="flex items-center gap-1 text-[11px] text-[var(--warn)]">
                <AlertTriangle size={12} />
                Scans every message from the earliest offset — slow on a large topic.
              </span>
            )}

            <div className="flex-1" />

            <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={tab.newestFirst}
                onChange={(e) => setNewestFirst(tab.id, e.target.checked)}
                className="size-3.5 accent-[var(--accent)]"
              />
              Newest first
            </label>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              disabled={!canRun || busy}
              onClick={() => void search(tab.id, clusterId)}
            >
              <Search size={14} /> Search
            </Button>
            <Button disabled={!canRun || busy} onClick={() => void tail(tab.id, clusterId)}>
              <Radio size={14} /> Live tail
            </Button>
            {busy && (
              <Button variant="danger" onClick={() => stop(tab.id)}>
                <Square size={13} /> Stop
              </Button>
            )}
            <Button disabled={messages.length === 0} onClick={() => clear(tab.id)}>
              <Trash2 size={13} /> Clear
            </Button>
            <Button
              disabled={messages.length === 0}
              onClick={() =>
                void call('export:rows', {
                  suggestedName: filters.topic || 'messages',
                  format: 'json',
                  rows: messages.map((m) => ({
                    partition: m.partition,
                    offset: m.offset,
                    timestamp: m.timestamp,
                    key: m.key.text,
                    value: m.value.text,
                    format: m.value.format
                  }))
                })
              }
            >
              <Download size={13} /> Export
            </Button>
            <Button
              disabled={!canRun}
              title="How this topic's records are decoded"
              onClick={() => setSerdeOpen(true)}
            >
              <SlidersHorizontal size={13} /> Decoding
            </Button>

            <div className="flex-1" />

            <Status tab={tab} rows={messages.length} />
          </div>

          {tab.error && (
            <div className="rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-subtle)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)]">
              {tab.error}
            </div>
          )}
        </div>
      </Panel>

      <div
        className="grid min-h-0 flex-1"
        style={{ gridTemplateColumns: tab.selected ? `1fr 6px ${detailWidth}px` : '1fr' }}
      >
        <Panel title={`Messages (${formatCount(messages.length)})`}>
          <DataTable
            rows={messages}
            columns={columns}
            rowKey={(m) => `${m.partition}:${m.offset}`}
            selectedKey={tab.selected ? `${tab.selected.partition}:${tab.selected.offset}` : null}
            onRowClick={(m) => select(tab.id, m)}
            empty={
              <EmptyState
                icon={<Search size={26} strokeWidth={1.5} />}
                title={busy ? 'Scanning…' : 'No messages yet'}
                hint={
                  busy
                    ? 'Results stream in as they are found.'
                    : 'Pick a topic and search, or start a live tail.'
                }
              />
            }
          />
        </Panel>

        {tab.selected && <Splitter orientation="vertical" onResize={resizeDetail} />}
        {tab.selected && (
          <MessageDetail
            clusterId={clusterId}
            message={tab.selected}
            onClose={() => select(tab.id, null)}
          />
        )}
      </div>

      <SerdeDialog
        open={serdeOpen}
        onOpenChange={setSerdeOpen}
        clusterId={clusterId}
        topic={filters.topic}
      />
    </div>
  )
}

function Status({ tab, rows }: { tab: BrowseTab; rows: number }): ReactNode {
  const busy = tab.mode !== 'idle'
  return (
    <span className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
      {busy && <Loader2 size={12} className="animate-spin" />}
      {busy && <span>{tab.mode === 'tailing' ? 'tailing' : 'scanning'}</span>}
      <span className="num">scanned {formatCount(tab.scanned)}</span>
      <span className="num">matched {formatCount(tab.matched)}</span>
      {!busy && tab.elapsedMs > 0 && <span className="num">{formatDuration(tab.elapsedMs)}</span>}
      {!busy && tab.stoppedEarly && rows > 0 && <Badge color="avro">stopped early</Badge>}
    </span>
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
    <label className={cx('flex flex-col gap-1', grow && 'min-w-52 flex-1')}>
      <span className="flex items-baseline gap-1.5 text-[11px] text-[var(--text-secondary)]">
        {label}
        {hint && <span className="num text-[10px] text-[var(--text-muted)]">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

/** `datetime-local` keeps the picker native and the value in the user's zone. */
function DateTime({
  label,
  value,
  onChange
}: {
  label: string
  value: number | null
  onChange: (ms: number | null) => void
}): ReactNode {
  const asInput = value ? toLocalInput(value) : ''
  return (
    <label className="flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
      {label}
      <input
        type="datetime-local"
        value={asInput}
        onChange={(e) => onChange(e.target.value ? new Date(e.target.value).getTime() : null)}
        className="h-7 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2 text-[12px] text-[var(--text-primary)] focus:border-[var(--border-focus)] focus:outline-none"
      />
    </label>
  )
}

function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
