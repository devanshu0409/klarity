import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import type {
  ClusterColor,
  ClusterHealth,
  ClusterProfile,
  ClusterProfileInput,
  SaslMechanism
} from '@shared/models'
import { ApiError, call } from '../../lib/api'
import { useClusters } from '../../stores/clusterStore'
import { Button, Input, cx } from '../common/ui'
import { Dialog } from '../common/Dialog'

const COLORS: ClusterColor[] = ['slate', 'blue', 'green', 'amber', 'red', 'purple', 'teal']
const MECHANISMS: SaslMechanism[] = ['plain', 'scram-sha-256', 'scram-sha-512']

/** Blank form. `password: undefined` means "leave the stored secret alone". */
function emptyForm(): ClusterProfileInput {
  return {
    name: '',
    bootstrapServers: '',
    folder: '',
    color: 'red',
    tls: { enabled: false, rejectUnauthorized: true },
    sasl: { enabled: false, mechanism: 'plain', username: '' },
    schemaRegistry: { enabled: false, url: '' },
    readOnly: false
  }
}

function fromProfile(profile: ClusterProfile): ClusterProfileInput {
  return {
    id: profile.id,
    name: profile.name,
    bootstrapServers: profile.bootstrapServers,
    folder: profile.folder ?? '',
    color: profile.color,
    tls: { ...profile.tls },
    sasl: { ...profile.sasl },
    schemaRegistry: { ...profile.schemaRegistry },
    readOnly: profile.readOnly
  }
}

export function ClusterDialog({
  open,
  onOpenChange,
  editing
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Null opens the dialog in create mode. */
  editing: ClusterProfile | null
}): ReactNode {
  const save = useClusters((s) => s.save)
  const connect = useClusters((s) => s.connect)
  const profiles = useClusters((s) => s.profiles)
  const folders = useMemo(
    () =>
      Array.from(new Set(profiles.map((p) => p.folder).filter((f): f is string => !!f))).sort(),
    [profiles]
  )

  const [form, setForm] = useState<ClusterProfileInput>(emptyForm)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ClusterHealth | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setForm(editing ? fromProfile(editing) : emptyForm())
    setTestResult(null)
    setError(null)
  }, [open, editing])

  const patch = (next: Partial<ClusterProfileInput>): void => {
    setForm((f) => ({ ...f, ...next }))
    setTestResult(null)
  }

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setError(null)
    try {
      setTestResult(await call('clusters:test', form))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Connection test failed.')
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async (alsoConnect: boolean): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const saved = await save({ ...form, folder: form.folder?.trim() || undefined })
      if (alsoConnect) await connect(saved.id)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the cluster.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${editing.name}` : 'Add cluster'}
      description="Connection details are stored locally; passwords go to the OS credential vault."
      footer={
        <>
          <Button onClick={() => void handleTest()} disabled={testing || saving}>
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
          <div className="flex-1" />
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={saving} onClick={() => void handleSave(true)}>
            {saving ? 'Saving…' : editing ? 'Save & connect' : 'Add & connect'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Section title="Connection">
          <Field label="Name" hint="Shown in the cluster switcher.">
            <Input
              autoFocus
              value={form.name}
              placeholder="production-eu"
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label="Bootstrap servers" hint="Comma-separated host:port.">
            <Input
              value={form.bootstrapServers}
              placeholder="broker1:9092, broker2:9092"
              spellCheck={false}
              onChange={(e) => patch({ bootstrapServers: e.target.value })}
            />
          </Field>
          <Field label="Folder" hint="Groups clusters in the sidebar, e.g. dev, qa.">
            <Input
              value={form.folder ?? ''}
              placeholder="dev"
              list="cluster-folders"
              onChange={(e) => patch({ folder: e.target.value })}
            />
            <datalist id="cluster-folders">
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </Field>
          <Field label="Colour" hint="Marks the cluster everywhere it is acted on.">
            <div className="flex gap-1.5">
              {COLORS.map((color) => (
                <button
                  key={color}
                  aria-label={color}
                  onClick={() => patch({ color })}
                  className={cx(
                    'size-6 rounded-full border-2 transition-transform duration-[var(--duration-fast)]',
                    form.color === color
                      ? 'scale-110 border-[var(--text-primary)]'
                      : 'border-transparent'
                  )}
                  style={{ backgroundColor: `var(--cluster-${color})` }}
                />
              ))}
            </div>
          </Field>
          <Toggle
            checked={form.readOnly}
            onChange={(readOnly) => patch({ readOnly })}
            label="Read-only"
            hint="Blocks producing, topic changes and offset resets — enforced in the backend, not just hidden."
          />
        </Section>

        <Section title="TLS">
          <Toggle
            checked={form.tls.enabled}
            onChange={(enabled) => patch({ tls: { ...form.tls, enabled } })}
            label="Use TLS"
          />
          {form.tls.enabled && (
            <>
              <Field label="CA certificate" hint="PEM contents. Leave empty to use system roots.">
                <TextArea
                  value={form.tls.caCert ?? ''}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  onChange={(caCert) => patch({ tls: { ...form.tls, caCert } })}
                />
              </Field>
              <Field label="Client certificate" hint="Only for mutual TLS.">
                <TextArea
                  value={form.tls.clientCert ?? ''}
                  onChange={(clientCert) => patch({ tls: { ...form.tls, clientCert } })}
                />
              </Field>
              <Field label="Client key">
                <TextArea
                  value={form.tls.clientKey ?? ''}
                  onChange={(clientKey) => patch({ tls: { ...form.tls, clientKey } })}
                />
              </Field>
              <Toggle
                checked={!form.tls.rejectUnauthorized}
                onChange={(skip) =>
                  patch({ tls: { ...form.tls, rejectUnauthorized: !skip } })
                }
                label="Allow self-signed certificates"
                hint="Skips certificate verification. Use only against clusters you control."
                danger
              />
            </>
          )}
        </Section>

        <Section title="SASL">
          <Toggle
            checked={form.sasl.enabled}
            onChange={(enabled) => patch({ sasl: { ...form.sasl, enabled } })}
            label="Authenticate with SASL"
          />
          {form.sasl.enabled && (
            <>
              <Field label="Mechanism">
                <select
                  value={form.sasl.mechanism}
                  onChange={(e) =>
                    patch({
                      sasl: { ...form.sasl, mechanism: e.target.value as SaslMechanism }
                    })
                  }
                  className="h-8 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2 text-[13px] text-[var(--text-primary)]"
                >
                  {MECHANISMS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Username">
                <Input
                  value={form.sasl.username}
                  spellCheck={false}
                  onChange={(e) => patch({ sasl: { ...form.sasl, username: e.target.value } })}
                />
              </Field>
              <Field
                label="Password"
                hint={
                  editing?.hasPassword
                    ? 'A password is stored. Leave blank to keep it.'
                    : 'Encrypted with the OS credential vault.'
                }
              >
                <Input
                  type="password"
                  value={form.password ?? ''}
                  placeholder={editing?.hasPassword ? '••••••••' : ''}
                  onChange={(e) => patch({ password: e.target.value })}
                />
              </Field>
            </>
          )}
        </Section>

        <Section title="Schema Registry">
          <Toggle
            checked={form.schemaRegistry.enabled}
            onChange={(enabled) =>
              patch({ schemaRegistry: { ...form.schemaRegistry, enabled } })
            }
            label="Use Confluent Schema Registry"
            hint="Decodes Avro and registry-framed Protobuf payloads automatically."
          />
          {form.schemaRegistry.enabled && (
            <>
              <Field label="URL">
                <Input
                  value={form.schemaRegistry.url}
                  placeholder="http://schema-registry:8081"
                  spellCheck={false}
                  onChange={(e) =>
                    patch({ schemaRegistry: { ...form.schemaRegistry, url: e.target.value } })
                  }
                />
              </Field>
              <Field label="Username" hint="Optional basic auth.">
                <Input
                  value={form.schemaRegistry.username ?? ''}
                  onChange={(e) =>
                    patch({
                      schemaRegistry: { ...form.schemaRegistry, username: e.target.value }
                    })
                  }
                />
              </Field>
              <Field label="Password">
                <Input
                  type="password"
                  value={form.registryPassword ?? ''}
                  placeholder={editing?.hasRegistryPassword ? '••••••••' : ''}
                  onChange={(e) => patch({ registryPassword: e.target.value })}
                />
              </Field>
            </>
          )}
        </Section>

        {(testResult || error) && (
          <div
            className={cx(
              'flex items-start gap-2 rounded-[var(--radius)] border p-2.5 text-[12px]',
              error || testResult?.state !== 'connected'
                ? 'border-[var(--danger)] bg-[var(--danger-subtle)]'
                : 'border-[var(--ok)] bg-[var(--ok-subtle)]'
            )}
          >
            {testing ? (
              <Loader2 size={15} className="mt-0.5 animate-spin" />
            ) : error || testResult?.state !== 'connected' ? (
              <XCircle size={15} className="mt-0.5 shrink-0 text-[var(--danger)]" />
            ) : (
              <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-[var(--ok)]" />
            )}
            <div className="min-w-0">
              {error ?? testResult?.error ?? (
                <span>
                  Connected to {testResult?.brokerCount} broker
                  {testResult?.brokerCount === 1 ? '' : 's'}, {testResult?.topicCount} topics
                  {testResult?.clusterName ? ` — ${testResult.clusterName}` : ''} (
                  {testResult?.latencyMs}ms)
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <fieldset className="flex flex-col gap-2.5 rounded-[var(--radius)] border border-[var(--border)] p-3">
      <legend className="px-1 text-[11px] font-semibold tracking-wide text-[var(--text-secondary)] uppercase">
        {title}
      </legend>
      {children}
    </fieldset>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): ReactNode {
  return (
    <label className="grid grid-cols-[160px_1fr] items-start gap-3">
      <div className="pt-1.5">
        <div className="text-[12px] text-[var(--text-primary)]">{label}</div>
        {hint && <div className="text-[11px] text-[var(--text-muted)]">{hint}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </label>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  danger
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  hint?: string
  danger?: boolean
}): ReactNode {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-3.5 accent-[var(--accent)]"
      />
      <div className="min-w-0">
        <div
          className={cx(
            'text-[12px]',
            danger && checked ? 'text-[var(--danger)]' : 'text-[var(--text-primary)]'
          )}
        >
          {label}
        </div>
        {hint && <div className="text-[11px] text-[var(--text-muted)]">{hint}</div>}
      </div>
    </label>
  )
}

function TextArea({
  value,
  placeholder,
  onChange
}: {
  value: string
  placeholder?: string
  onChange: (value: string) => void
}): ReactNode {
  return (
    <textarea
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      rows={3}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2 py-1.5 font-mono text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none"
    />
  )
}
