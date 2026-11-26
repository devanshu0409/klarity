import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import type { ResetOffsetsRequest, ResetPreviewRow, ResetStrategy } from '@shared/models'
import { ApiError, call } from '../../lib/api'
import { formatCount } from '../../lib/format'
import { Button, EmptyState, Input, cx } from '../common/ui'
import { Dialog } from '../common/Dialog'

type StrategyKind = ResetStrategy['kind']

const KINDS: { kind: StrategyKind; label: string; hint: string }[] = [
  { kind: 'earliest', label: 'Earliest', hint: 'Replay everything still retained' },
  { kind: 'latest', label: 'Latest', hint: 'Skip to the end, consume only new records' },
  { kind: 'to-datetime', label: 'To date/time', hint: 'First record at or after the timestamp' },
  { kind: 'shift-by', label: 'Shift by', hint: 'Move each partition ±N from its current offset' },
  { kind: 'explicit', label: 'Per partition', hint: 'Hand-edit every partition offset' }
]

/** `datetime-local` wants `YYYY-MM-DDTHH:mm`, in local time. */
function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

export function ResetOffsetsDialog({
  open,
  onOpenChange,
  clusterId,
  groupId,
  topic,
  onApplied
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clusterId: string
  groupId: string
  topic: string
  onApplied: () => void
}): ReactNode {
  const [kind, setKind] = useState<StrategyKind>('earliest')
  const [timestamp, setTimestamp] = useState(() => toLocalInput(Date.now() - 60 * 60 * 1000))
  const [delta, setDelta] = useState('-100')
  /** Hand-edited offsets, keyed by partition. Seeded from the current commits. */
  const [edited, setEdited] = useState<Record<number, string>>({})

  const [rows, setRows] = useState<ResetPreviewRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [applying, setApplying] = useState(false)

  const strategy = useCallback((): ResetStrategy => {
    switch (kind) {
      case 'earliest':
        return { kind: 'earliest' }
      case 'latest':
        return { kind: 'latest' }
      case 'to-datetime':
        return { kind: 'to-datetime', timestampMs: new Date(timestamp).getTime() }
      case 'shift-by':
        return { kind: 'shift-by', delta: Number(delta) || 0 }
      case 'explicit':
        return { kind: 'explicit', offsets: edited }
    }
  }, [kind, timestamp, delta, edited])

  const buildRequest = (): ResetOffsetsRequest => ({
    clusterId,
    groupId,
    topic,
    strategy: strategy()
  })

  const loadPreview = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setRows(await call('groups:resetPreview', { clusterId, groupId, topic, strategy: strategy() }))
    } catch (err) {
      setRows([])
      setError(err instanceof ApiError ? err.message : 'Could not preview the reset.')
    } finally {
      setLoading(false)
    }
  }, [clusterId, groupId, topic, strategy])

  // Seed the per-partition grid with what the group is committed at now, so the
  // user edits real numbers instead of typing every partition from scratch.
  // A zero shift is the cheapest way to ask for "current, earliest, latest".
  useEffect(() => {
    if (!open) return
    setTyped('')
    let cancelled = false
    setLoading(true)
    call('groups:resetPreview', {
      clusterId,
      groupId,
      topic,
      strategy: { kind: 'shift-by', delta: 0 }
    })
      .then((baseline) => {
        if (cancelled) return
        setRows(baseline)
        setEdited(Object.fromEntries(baseline.map((r) => [r.partition, r.current ?? r.earliest])))
        setError(null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not read offsets.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, clusterId, groupId, topic])

  const apply = async (): Promise<void> => {
    setApplying(true)
    setError(null)
    try {
      await call('groups:resetOffsets', buildRequest(), typed)
      onApplied()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reset failed.')
    } finally {
      setApplying(false)
    }
  }

  const clamped = rows.filter((r) => r.outOfRange).length
  const changing = rows.filter((r) => r.current !== r.next).length

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Reset offsets — ${groupId}`}
      description={`Topic ${topic}. The group must have no active members.`}
      width="lg"
      footer={
        <>
          <span className="mr-auto text-[11px] text-[var(--text-muted)]">
            {rows.length === 0
              ? ''
              : `${changing} of ${rows.length} partitions change` +
                (clamped > 0 ? ` · ${clamped} outside the retained range, will be clamped` : '')}
          </span>
          <Input
            value={typed}
            spellCheck={false}
            placeholder={`Type ${groupId} to confirm`}
            className="w-56"
            onChange={(e) => setTyped(e.target.value)}
          />
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={typed !== groupId || rows.length === 0 || applying}
            onClick={() => void apply()}
          >
            {applying ? 'Applying…' : 'Apply reset'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2">
          {KINDS.map((option) => (
            <button
              key={option.kind}
              title={option.hint}
              onClick={() => setKind(option.kind)}
              className={cx(
                'h-8 rounded-[var(--radius-pill)] border px-3 text-[12px] font-medium',
                'transition-colors duration-[var(--duration-fast)]',
                kind === option.kind
                  ? 'border-transparent bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)]'
                  : 'border-[var(--border-strong)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
              )}
            >
              {option.label}
            </button>
          ))}

          {kind === 'to-datetime' && (
            <Input
              type="datetime-local"
              value={timestamp}
              className="w-56"
              onChange={(e) => setTimestamp(e.target.value)}
            />
          )}
          {kind === 'shift-by' && (
            <Input
              type="number"
              value={delta}
              className="w-28"
              onChange={(e) => setDelta(e.target.value)}
            />
          )}

          <Button className="ml-auto" disabled={loading} onClick={() => void loadPreview()}>
            <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} /> Preview
          </Button>
        </div>

        <p className="text-[12px] text-[var(--text-muted)]">
          {KINDS.find((k) => k.kind === kind)?.hint}
          {kind === 'explicit' && ' — edit the New offset column, then press Preview.'}
        </p>

        {error && (
          <div className="flex gap-2 rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-subtle)] p-2.5 text-[12px]">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--danger)]" />
            <span className="text-[var(--text-primary)]">{error}</span>
          </div>
        )}

        <div className="max-h-[46vh] overflow-auto rounded-[var(--radius)] border border-[var(--border)]">
          {rows.length === 0 ? (
            <EmptyState
              title={loading ? 'Reading offsets…' : 'Nothing to preview'}
              hint={loading ? undefined : 'Choose a strategy and press Preview.'}
            />
          ) : (
            <table className="w-full border-collapse text-[12px]">
              <thead className="sticky top-0 bg-[var(--bg-sunken)]">
                <tr>
                  {['Partition', 'Current', 'New offset', 'Earliest', 'Latest'].map((header) => (
                    <th
                      key={header}
                      className="border-b border-[var(--border)] px-2.5 py-1.5 text-right text-[11px] font-semibold tracking-wide text-[var(--text-secondary)] uppercase first:text-left"
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.partition} className="border-b border-[var(--border)]">
                    <td className="num px-2.5 py-1">{row.partition}</td>
                    <td className="num px-2.5 py-1 text-right text-[var(--text-secondary)]">
                      {row.current === null ? '—' : formatCount(row.current)}
                    </td>
                    <td className="num px-2.5 py-1 text-right">
                      {kind === 'explicit' ? (
                        <input
                          value={edited[row.partition] ?? row.next}
                          inputMode="numeric"
                          onChange={(e) =>
                            setEdited((prev) => ({
                              ...prev,
                              [row.partition]: e.target.value.replace(/\D/g, '')
                            }))
                          }
                          className={cx(
                            'num h-7 w-32 rounded-[var(--radius-sm)] border bg-[var(--bg-surface)] px-1.5 text-right',
                            'focus:border-[var(--border-focus)] focus:outline-none',
                            row.outOfRange
                              ? 'border-[var(--danger)]'
                              : 'border-[var(--border-strong)]'
                          )}
                        />
                      ) : (
                        <span
                          title={
                            row.outOfRange
                              ? 'Outside the retained range — will be clamped on apply'
                              : undefined
                          }
                          className={cx(
                            'num',
                            row.outOfRange
                              ? 'text-[var(--danger)]'
                              : row.current !== row.next
                                ? 'font-semibold text-[var(--text-primary)]'
                                : 'text-[var(--text-muted)]'
                          )}
                        >
                          {formatCount(row.next)}
                        </span>
                      )}
                    </td>
                    <td className="num px-2.5 py-1 text-right text-[var(--text-muted)]">
                      {formatCount(row.earliest)}
                    </td>
                    <td className="num px-2.5 py-1 text-right text-[var(--text-muted)]">
                      {formatCount(row.latest)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Dialog>
  )
}
