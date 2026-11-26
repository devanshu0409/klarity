import { useMemo, useState, type ReactNode } from 'react'
import type { ConfigEntry } from '@shared/models'
import { ApiError, call } from '../../lib/api'
import { Button } from '../common/ui'
import { Dialog } from '../common/Dialog'
import { parseConfigLines } from './CreateTopicDialog'

interface Change {
  name: string
  from: string
  to: string
  isNew: boolean
}

/** Compares typed entries against current values so only real changes are sent. */
export function diffConfigs(current: ConfigEntry[], typed: Record<string, string>): Change[] {
  const byName = new Map(current.map((c) => [c.name, c]))
  const changes: Change[] = []
  for (const [name, to] of Object.entries(typed)) {
    const existing = byName.get(name)
    const from = existing?.value ?? ''
    if (existing && existing.value === to) continue
    changes.push({ name, from, to, isNew: !existing })
  }
  return changes.sort((a, b) => a.name.localeCompare(b.name))
}

export function EditTopicConfigDialog({
  open,
  onOpenChange,
  clusterId,
  topic,
  configs,
  readOnly,
  onDone
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clusterId: string
  topic: string
  configs: ConfigEntry[]
  readOnly: boolean
  onDone: () => void
}): ReactNode {
  // Seed with the values someone actually set; defaults would make the diff
  // meaningless and risk pinning every inherited value onto the topic.
  const seed = useMemo(
    () =>
      configs
        .filter((c) => !c.isDefault && !c.isSensitive)
        .map((c) => `${c.name}=${c.value}`)
        .join('\n'),
    [configs]
  )

  const [text, setText] = useState(seed)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const changes = useMemo(() => diffConfigs(configs, parseConfigLines(text)), [configs, text])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setText(seed)
          setError(null)
        }
        onOpenChange(next)
      }}
      title={`Configuration — ${topic}`}
      description="Only changed entries are sent. Removing a line does not reset a value; set it explicitly instead."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || readOnly || changes.length === 0}
            onClick={() => {
              setBusy(true)
              setError(null)
              const payload = Object.fromEntries(changes.map((c) => [c.name, c.to]))
              void call('topics:updateConfig', clusterId, topic, payload)
                .then(() => {
                  onOpenChange(false)
                  onDone()
                })
                .catch((err: unknown) =>
                  setError(err instanceof ApiError ? err.message : 'Could not apply the changes.')
                )
                .finally(() => setBusy(false))
            }}
          >
            {busy
              ? 'Applying…'
              : `Apply ${changes.length} change${changes.length === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[12px]">
        {readOnly && (
          <div className="rounded-[var(--radius)] border border-[var(--warn)] bg-[var(--warn-subtle)] p-2.5">
            This cluster is registered read-only, so configuration changes are blocked.
          </div>
        )}

        <textarea
          value={text}
          rows={10}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          className="w-full rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2 py-1.5 font-mono text-[11px] text-[var(--text-primary)] focus:border-[var(--border-focus)] focus:outline-none"
        />

        <div>
          <div className="mb-1 text-[11px] font-semibold tracking-wide text-[var(--text-secondary)] uppercase">
            Pending changes
          </div>
          {changes.length === 0 ? (
            <div className="text-[var(--text-muted)]">Nothing to apply.</div>
          ) : (
            <ul className="flex flex-col gap-1">
              {changes.map((c) => (
                <li key={c.name} className="num flex flex-wrap items-baseline gap-2">
                  <span className="text-[var(--text-primary)]">{c.name}</span>
                  {c.isNew ? (
                    <span className="text-[var(--ok)]">set to {c.to}</span>
                  ) : (
                    <>
                      <span className="text-[var(--text-muted)] line-through">{c.from}</span>
                      <span className="text-[var(--accent-text)]">{c.to}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && <div className="text-[var(--danger)]">{error}</div>}
      </div>
    </Dialog>
  )
}
