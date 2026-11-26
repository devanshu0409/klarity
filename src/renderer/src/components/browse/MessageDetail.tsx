import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import { Copy, Download, Loader2, X } from 'lucide-react'
import type { DecodedMessage, DecodedValue } from '@shared/models'
import { ApiError, call } from '../../lib/api'
import { formatBytes, formatCount, formatTimestamp } from '../../lib/format'
import { Badge, Button, EmptyState, Panel, cx } from '../common/ui'

const FORMAT_COLORS: Record<string, Parameters<typeof Badge>[0]['color']> = {
  json: 'json',
  protobuf: 'protobuf',
  flatbuffers: 'flatbuffers',
  avro: 'avro',
  string: 'string',
  number: 'number',
  raw: 'raw',
  null: 'raw'
}

export function formatBadge(value: DecodedValue): ReactNode {
  if (value.decodeError) return <Badge color="error">decode failed</Badge>
  return <Badge color={FORMAT_COLORS[value.format] ?? 'raw'}>{value.format}</Badge>
}

/** How the user chose to look at a payload, independent of how it decoded. */
type ViewAs = 'auto' | 'json' | 'text' | 'hex'

const VIEW_LABELS: Record<ViewAs, string> = {
  auto: 'Auto',
  json: 'JSON',
  text: 'Text',
  hex: 'Hex'
}

/** Raw bytes for one record, fetched lazily. */
interface RawBytes {
  key?: string
  value?: string
}

type RawState = 'idle' | 'loading' | 'error'

export function MessageDetail({
  clusterId,
  message,
  onClose
}: {
  clusterId: string
  message: DecodedMessage
  onClose: () => void
}): ReactNode {
  const headerEntries = Object.entries(message.headers)

  // Scans decode without carrying raw bytes across IPC — doing so would double
  // the payload of every scan for bytes nobody usually looks at. The non-Auto
  // views need them, so they are fetched for the selected record only.
  const [raw, setRaw] = useState<RawBytes>({})
  const [rawState, setRawState] = useState<RawState>('idle')
  const [rawError, setRawError] = useState<string | null>(null)

  const coords = `${message.partition}:${message.offset}`
  useEffect(() => {
    // A different record is selected: drop whatever was fetched for the old one.
    setRaw({ key: message.key.rawBase64, value: message.value.rawBase64 })
    setRawState('idle')
    setRawError(null)
  }, [coords, message.key.rawBase64, message.value.rawBase64])

  const ensureRaw = useCallback(async (): Promise<void> => {
    setRawState((current) => (current === 'loading' ? current : 'loading'))
    setRawError(null)
    try {
      const full = await call('consume:peek', {
        clusterId,
        topic: message.topic,
        partition: message.partition,
        offset: message.offset,
        includeRaw: true
      })
      if (!full) {
        setRawState('error')
        setRawError('The record is no longer available at that offset.')
        return
      }
      setRaw({ key: full.key.rawBase64, value: full.value.rawBase64 })
      setRawState('idle')
    } catch (err) {
      setRawState('error')
      setRawError(err instanceof ApiError ? err.message : 'Could not read the raw bytes.')
    }
  }, [clusterId, message.topic, message.partition, message.offset])

  return (
    <Panel
      className="h-full min-h-0"
      title={
        <span className="flex items-center gap-2 normal-case">
          <span className="num text-[12px] text-[var(--text-primary)]">
            p{message.partition} · offset {formatCount(message.offset)}
          </span>
          <span className="num text-[11px] font-normal text-[var(--text-muted)]">
            {formatTimestamp(message.timestamp)} · {formatBytes(message.sizeBytes)}
          </span>
        </span>
      }
      actions={
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            onClick={() =>
              void call('export:messageFile', {
                clusterId,
                topic: message.topic,
                partition: message.partition,
                offset: message.offset,
                target: 'value',
                mode: 'binary'
              })
            }
            title="Write the exact value bytes to a file"
          >
            <Download size={13} /> Save bytes
          </Button>
          <Button size="sm" variant="ghost" aria-label="Close" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>
      }
    >
      <Tabs.Root defaultValue="value" className="flex h-full flex-col">
        <Tabs.List className="flex shrink-0 gap-1 border-b border-[var(--border)] px-2">
          {[
            ['value', 'Value'],
            ['key', 'Key'],
            ['headers', `Headers (${headerEntries.length})`]
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

        <Tabs.Content value="value" className="min-h-0 flex-1">
          <ValuePane
            value={message.value}
            rawBase64={raw.value}
            rawState={rawState}
            rawError={rawError}
            onNeedRaw={ensureRaw}
          />
        </Tabs.Content>

        <Tabs.Content value="key" className="min-h-0 flex-1">
          <ValuePane
            value={message.key}
            rawBase64={raw.key}
            rawState={rawState}
            rawError={rawError}
            onNeedRaw={ensureRaw}
          />
        </Tabs.Content>

        <Tabs.Content value="headers" className="min-h-0 flex-1 overflow-auto">
          {headerEntries.length === 0 ? (
            <EmptyState title="No headers" />
          ) : (
            <table className="w-full text-[12px]">
              <tbody>
                {headerEntries.map(([key, value]) => (
                  <tr key={key} className="border-b border-[var(--border)]">
                    <td className="num w-1/3 px-2.5 py-1.5 text-[var(--text-secondary)]">{key}</td>
                    <td className="num px-2.5 py-1.5 text-[var(--text-primary)]" data-selectable>
                      {value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Tabs.Content>
      </Tabs.Root>
    </Panel>
  )
}

function ValuePane({
  value,
  rawBase64,
  rawState,
  rawError,
  onNeedRaw
}: {
  value: DecodedValue
  rawBase64?: string
  rawState: RawState
  rawError: string | null
  onNeedRaw: () => Promise<void>
}): ReactNode {
  const [view, setView] = useState<ViewAs>('auto')

  const needsRaw = view !== 'auto'
  const missingRaw = rawBase64 === undefined

  useEffect(() => {
    if (needsRaw && missingRaw && rawState === 'idle') void onNeedRaw()
  }, [needsRaw, missingRaw, rawState, onNeedRaw])

  const rendered = useMemo(() => renderAs(view, value, rawBase64), [view, value, rawBase64])

  const isEmpty = value.format === 'null'

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] px-2.5 py-1.5">
        {formatBadge(value)}
        <span className="num text-[11px] text-[var(--text-muted)]">
          {formatBytes(value.sizeBytes)}
        </span>
        {value.schemaId !== undefined && (
          <span className="num text-[11px] text-[var(--text-muted)]">schema {value.schemaId}</span>
        )}
        {value.truncated && view === 'auto' && <Badge color="avro">truncated</Badge>}

        <div className="flex-1" />

        {/* A display choice, deliberately separate from the topic's serde:
            forcing Text here does not change how the topic is decoded. */}
        <div className="flex items-center gap-0.5 rounded-[var(--radius-pill)] border border-[var(--border)] bg-[var(--bg-sunken)] p-0.5">
          {(Object.keys(VIEW_LABELS) as ViewAs[]).map((option) => (
            <button
              key={option}
              disabled={isEmpty}
              title={`View as ${VIEW_LABELS[option]}`}
              onClick={() => setView(option)}
              className={cx(
                'rounded-[var(--radius-pill)] px-2 py-0.5 text-[11px]',
                'transition-colors duration-[var(--duration-fast)] disabled:opacity-45',
                view === option
                  ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              )}
            >
              {VIEW_LABELS[option]}
            </button>
          ))}
        </div>

        <Button
          size="sm"
          variant="ghost"
          aria-label="Copy"
          onClick={() => void navigator.clipboard.writeText(rendered.text)}
        >
          <Copy size={13} />
        </Button>
      </div>

      {value.decodeError && view === 'auto' && (
        <div className="shrink-0 border-b border-[var(--border)] bg-[var(--danger-subtle)] px-2.5 py-1.5 text-[11px] text-[var(--text-primary)]">
          {value.decodeError}
        </div>
      )}

      {rendered.error && (
        <div className="shrink-0 border-b border-[var(--border)] bg-[var(--warn-subtle)] px-2.5 py-1.5 text-[11px] text-[var(--text-primary)]">
          {rendered.error}
        </div>
      )}

      {needsRaw && missingRaw ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          {rawState === 'error' ? (
            <EmptyState title="Could not read the bytes" hint={rawError ?? undefined} />
          ) : (
            <span className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
              <Loader2 size={14} className="animate-spin" /> Reading raw bytes…
            </span>
          )}
        </div>
      ) : (
        <pre
          data-selectable
          className="min-h-0 flex-1 overflow-auto px-2.5 py-2 font-mono text-[11px] leading-[1.6] whitespace-pre-wrap text-[var(--text-primary)]"
        >
          {rendered.text || <span className="text-[var(--text-muted)]">(empty)</span>}
        </pre>
      )}
    </div>
  )
}

/** Produces the text for a view mode, plus a note when the mode did not fit. */
function renderAs(
  view: ViewAs,
  value: DecodedValue,
  rawBase64?: string
): { text: string; error?: string } {
  if (view === 'auto') return { text: value.text }
  if (rawBase64 === undefined) return { text: '' }

  const bytes = base64ToBytes(rawBase64)

  if (view === 'hex') return { text: hexDump(bytes) }

  const utf8 = new TextDecoder().decode(bytes)
  if (view === 'text') return { text: utf8 }

  try {
    return { text: JSON.stringify(JSON.parse(utf8), null, 2) }
  } catch (err) {
    // Show the bytes as text rather than an empty pane; the note explains why.
    return {
      text: utf8,
      error: err instanceof Error ? `Not valid JSON: ${err.message}` : 'Not valid JSON.'
    }
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Classic offset / hex / ASCII dump, 16 bytes per row. */
function hexDump(bytes: Uint8Array): string {
  const lines: string[] = []
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.subarray(i, i + 16)
    const hex = [...chunk]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
      .padEnd(47, ' ')
    const ascii = [...chunk]
      .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.'))
      .join('')
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`)
  }
  return lines.join('\n')
}
