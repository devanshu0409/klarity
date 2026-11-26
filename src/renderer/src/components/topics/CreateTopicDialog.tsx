import { useState, type ReactNode } from 'react'
import { useTopics } from '../../stores/topicStore'
import { ApiError, call } from '../../lib/api'
import { Button, Input } from '../common/ui'
import { Dialog } from '../common/Dialog'

/** Parses `key=value` lines into a config map, ignoring blanks and `#` comments. */
export function parseConfigLines(text: string): Record<string, string> {
  const configs: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (key) configs[key] = line.slice(eq + 1).trim()
  }
  return configs
}

export function CreateTopicDialog({
  open,
  onOpenChange,
  clusterId,
  readOnly
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clusterId: string
  readOnly: boolean
}): ReactNode {
  const loadTopics = useTopics((s) => s.load)

  const [name, setName] = useState('')
  const [partitions, setPartitions] = useState(6)
  const [replication, setReplication] = useState(3)
  const [configText, setConfigText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = (): void => {
    setName('')
    setPartitions(6)
    setReplication(3)
    setConfigText('')
    setError(null)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) reset()
        onOpenChange(next)
      }}
      title="Create topic"
      width="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || readOnly || !name.trim()}
            onClick={() => {
              setBusy(true)
              setError(null)
              void call('topics:create', clusterId, {
                name: name.trim(),
                numPartitions: partitions,
                replicationFactor: replication,
                configs: parseConfigLines(configText)
              })
                .then(() => {
                  onOpenChange(false)
                  return loadTopics(clusterId)
                })
                .catch((err: unknown) =>
                  setError(err instanceof ApiError ? err.message : 'Could not create the topic.')
                )
                .finally(() => setBusy(false))
            }}
          >
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[12px]">
        {readOnly && (
          <div className="rounded-[var(--radius)] border border-[var(--warn)] bg-[var(--warn-subtle)] p-2.5">
            This cluster is registered read-only, so topic creation is blocked.
          </div>
        )}

        <label className="flex items-center gap-3">
          <span className="w-32 shrink-0 text-[var(--text-secondary)]">Name</span>
          <Input
            autoFocus
            value={name}
            spellCheck={false}
            placeholder="orders.v1"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="flex items-center gap-3">
          <span className="w-32 shrink-0 text-[var(--text-secondary)]">Partitions</span>
          <Input
            type="number"
            min={1}
            value={partitions}
            className="w-28"
            onChange={(e) => setPartitions(Number(e.target.value))}
          />
        </label>

        <label className="flex items-center gap-3">
          <span className="w-32 shrink-0 text-[var(--text-secondary)]">Replication</span>
          <Input
            type="number"
            min={1}
            value={replication}
            className="w-28"
            onChange={(e) => setReplication(Number(e.target.value))}
          />
          <span className="text-[11px] text-[var(--text-muted)]">
            Cannot exceed the broker count.
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[var(--text-secondary)]">
            Configuration — one <code className="num">key=value</code> per line, optional
          </span>
          <textarea
            value={configText}
            rows={5}
            spellCheck={false}
            placeholder={'retention.ms=604800000\ncleanup.policy=delete'}
            onChange={(e) => setConfigText(e.target.value)}
            className="w-full rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2 py-1.5 font-mono text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none"
          />
        </label>

        {error && <div className="text-[var(--danger)]">{error}</div>}
      </div>
    </Dialog>
  )
}
