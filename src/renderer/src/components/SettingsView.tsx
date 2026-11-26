import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { FlatcStatus } from '@shared/serde'
import { useUi } from '../stores/uiStore'
import { ApiError, call } from '../lib/api'
import { Badge, Button, Panel, cx } from './common/ui'
import { ThemeToggle } from './shell/ThemeToggle'
import { FlatcPathRow, SchemaSettings } from './SchemaSettings'

export function SettingsView(): ReactNode {
  const density = useUi((s) => s.density)
  const setDensity = useUi((s) => s.setDensity)
  const [version, setVersion] = useState('')
  const [flatc, setFlatc] = useState<FlatcStatus | null>(null)

  const refreshFlatc = useCallback(() => {
    call('serde:flatcStatus')
      .then(setFlatc)
      .catch((err: unknown) => {
        setFlatc({
          available: false,
          userProvided: false,
          error: err instanceof ApiError ? err.message : 'Unavailable'
        })
      })
  }, [])

  useEffect(() => {
    void call('app:version').then(setVersion)
    refreshFlatc()
  }, [refreshFlatc])

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4">
      <Panel title="Appearance">
        <Row label="Theme" hint="Follow the system setting, or pin light or dark.">
          <ThemeToggle />
        </Row>
        <Row label="Density" hint="Compact tightens table rows for dense clusters.">
          <div className="flex items-center gap-0.5 rounded-[var(--radius-pill)] border border-[var(--border)] bg-[var(--bg-sunken)] p-0.5">
            {(['comfortable', 'compact'] as const).map((value) => (
              <button
                key={value}
                onClick={() => setDensity(value)}
                className={cx(
                  'rounded-[var(--radius-pill)] px-2.5 py-1 text-[12px] capitalize',
                  'transition-colors duration-[var(--duration-fast)]',
                  density === value
                    ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                )}
              >
                {value}
              </button>
            ))}
          </div>
        </Row>
      </Panel>

      <Panel title="Schema tooling">
        <Row
          label="FlatBuffers compiler"
          hint="flatc decodes and encodes FlatBuffers payloads. Leave the path empty to use the bundled binary or PATH."
        >
          <div className="flex flex-col items-end gap-1.5">
            {flatc?.available ? (
              <span className="flex items-center gap-2">
                <Badge color="flatbuffers">ready</Badge>
                <span className="num text-[12px] text-[var(--text-muted)]">{flatc.version}</span>
              </span>
            ) : (
              <Badge color="error">not found</Badge>
            )}
            <FlatcPathRow flatc={flatc} onChanged={refreshFlatc} />
          </div>
        </Row>
      </Panel>

      <SchemaSettings flatc={flatc} />

      <Panel title="About">
        <Row label="Klarity" hint="Desktop GUI for Apache Kafka.">
          <span className="num text-[12px] text-[var(--text-muted)]">v{version}</span>
        </Row>
        <Row label="Updates" hint="Checks GitHub releases for packaged builds.">
          <Button size="sm" onClick={() => void call('update:check')}>
            Check now
          </Button>
        </Row>
      </Panel>
    </div>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): ReactNode {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-3 py-2.5 last:border-b-0">
      <div className="min-w-0">
        <p className="text-[13px] text-[var(--text-primary)]">{label}</p>
        {hint && <p className="text-[11px] text-[var(--text-muted)]">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
