import { useEffect, useState, type ReactNode } from 'react'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import type {
  DecodeTestResult,
  FbsSchemaInfo,
  ProtoSource,
  SerdeConfig,
  SerdeKind,
  SerdeSpec
} from '@shared/serde'
import { ApiError, call } from '../../lib/api'
import { Button, cx } from '../common/ui'
import { Dialog } from '../common/Dialog'

const KINDS: { value: SerdeKind; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Detect JSON, text, registry framing or raw bytes' },
  { value: 'json', label: 'JSON', hint: 'Parse as JSON, report an error when it is not' },
  { value: 'string', label: 'Text', hint: 'UTF-8 text' },
  {
    value: 'proto-string',
    label: 'Protobuf string',
    hint: 'A bare string wrapped in a protobuf message, e.g. StringValue'
  },
  { value: 'int64', label: 'Long (8B)', hint: "Kafka's LongSerializer: 8-byte big-endian integer" },
  {
    value: 'int32',
    label: 'Integer (4B)',
    hint: "Kafka's IntegerSerializer: 4-byte big-endian integer"
  },
  { value: 'int16', label: 'Short (2B)', hint: "Kafka's ShortSerializer: 2-byte big-endian integer" },
  { value: 'float64', label: 'Double (8B)', hint: "Kafka's DoubleSerializer: IEEE-754 big-endian" },
  { value: 'float32', label: 'Float (4B)', hint: "Kafka's FloatSerializer: IEEE-754 big-endian" },
  { value: 'protobuf', label: 'Protobuf', hint: 'Decode with a .proto message type' },
  { value: 'flatbuffers', label: 'FlatBuffers', hint: 'Decode with a .fbs schema via flatc' },
  { value: 'avro-sr', label: 'Avro / Registry', hint: 'Confluent Schema Registry framing' },
  { value: 'raw', label: 'Raw', hint: 'Never decode; show bytes' }
]

/**
 * Per-topic decoding configuration. Kept separate from the display-level
 * "View as" switch: this changes how every record on the topic is decoded and
 * therefore what the text filter searches.
 */
export function SerdeDialog({
  open,
  onOpenChange,
  clusterId,
  topic
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clusterId: string
  topic: string
}): ReactNode {
  const [config, setConfig] = useState<SerdeConfig | null>(null)
  const [protoSources, setProtoSources] = useState<ProtoSource[]>([])
  const [fbsSchemas, setFbsSchemas] = useState<FbsSchemaInfo[]>([])
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<DecodeTestResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !topic) return
    setResult(null)
    setError(null)
    void Promise.all([
      call('serde:getTopicConfig', clusterId, topic),
      call('serde:listProtoSources'),
      call('serde:listFbsSchemas')
    ])
      .then(([cfg, protos, fbs]) => {
        setConfig(cfg)
        setProtoSources(protos)
        setFbsSchemas(fbs)
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not load the serde config.')
      )
  }, [open, clusterId, topic])

  const patch = (which: 'key' | 'value', changes: Partial<SerdeSpec>): void => {
    setConfig((c) => (c ? { ...c, [which]: { ...c[which], ...changes } } : c))
    setResult(null)
  }

  const runTest = async (): Promise<void> => {
    if (!config) return
    setTesting(true)
    setError(null)
    try {
      setResult(await call('serde:testDecode', clusterId, topic, config))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The test failed.')
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!config) return
    try {
      await call('serde:setTopicConfig', clusterId, topic, config)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the config.')
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Decoding — ${topic}`}
      description="Applies to every record on this topic, and to what the text filter searches."
      footer={
        <>
          <Button onClick={() => void runTest()} disabled={testing || !config}>
            {testing ? 'Testing…' : 'Try on latest message'}
          </Button>
          <div className="flex-1" />
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!config} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      {!config ? (
        <div className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <SpecEditor
            label="Value"
            spec={config.value}
            protoSources={protoSources}
            fbsSchemas={fbsSchemas}
            onChange={(changes) => patch('value', changes)}
          />
          <SpecEditor
            label="Key"
            spec={config.key}
            protoSources={protoSources}
            fbsSchemas={fbsSchemas}
            onChange={(changes) => patch('key', changes)}
          />

          {(result || error) && (
            <div
              className={cx(
                'flex flex-col gap-1.5 rounded-[var(--radius)] border p-2.5 text-[12px]',
                error || !result?.ok
                  ? 'border-[var(--danger)] bg-[var(--danger-subtle)]'
                  : 'border-[var(--ok)] bg-[var(--ok-subtle)]'
              )}
            >
              <div className="flex items-center gap-2">
                {error || !result?.ok ? (
                  <XCircle size={14} className="text-[var(--danger)]" />
                ) : (
                  <CheckCircle2 size={14} className="text-[var(--ok)]" />
                )}
                <span className="text-[var(--text-primary)]">
                  {error ??
                    result?.error ??
                    `Decoded as ${result?.format}` +
                      (result?.sampledFrom
                        ? ` — partition ${result.sampledFrom.partition}, offset ${result.sampledFrom.offset}`
                        : '')}
                </span>
              </div>
              {result?.preview && (
                <pre
                  data-selectable
                  className="max-h-52 overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-sunken)] p-2 font-mono text-[11px] whitespace-pre-wrap text-[var(--text-primary)]"
                >
                  {result.preview.slice(0, 4000)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  )
}

function SpecEditor({
  label,
  spec,
  protoSources,
  fbsSchemas,
  onChange
}: {
  label: string
  spec: SerdeSpec
  protoSources: ProtoSource[]
  fbsSchemas: FbsSchemaInfo[]
  onChange: (changes: Partial<SerdeSpec>) => void
}): ReactNode {
  const selectedProto = protoSources.find((s) => s.id === spec.protoSourceId)
  // Only clutter the labels with file paths when they are actually needed.
  const hasDuplicateNames = (() => {
    const seen = new Set<string>()
    for (const t of selectedProto?.types ?? []) {
      if (seen.has(t.fullName)) return true
      seen.add(t.fullName)
    }
    return false
  })()
  const selectedFbs = fbsSchemas.find((s) => s.id === spec.fbsSchemaId)

  return (
    <fieldset className="flex flex-col gap-2.5 rounded-[var(--radius)] border border-[var(--border)] p-3">
      <legend className="px-1 text-[11px] font-semibold tracking-wide text-[var(--text-secondary)] uppercase">
        {label}
      </legend>

      <div className="flex flex-wrap gap-1">
        {KINDS.map((kind) => (
          <button
            key={kind.value}
            title={kind.hint}
            onClick={() => onChange({ kind: kind.value })}
            className={cx(
              'rounded-[var(--radius-pill)] border px-2.5 py-1 text-[12px]',
              'transition-colors duration-[var(--duration-fast)]',
              spec.kind === kind.value
                ? 'border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--accent-text)]'
                : 'border-[var(--border-strong)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            )}
          >
            {kind.label}
          </button>
        ))}
      </div>

      {spec.kind === 'protobuf' && (
        <div className="flex flex-col gap-2">
          {protoSources.length === 0 ? (
            <Hint>Add a .proto source in Settings first.</Hint>
          ) : (
            <>
              <Row label="Source">
                <Select
                  value={spec.protoSourceId ?? ''}
                  onChange={(protoSourceId) => onChange({ protoSourceId, protoType: undefined })}
                  options={protoSources.map((s) => ({
                    value: s.id,
                    label: `${s.name} (${s.types.length} types)`
                  }))}
                />
              </Row>
              <Row label="Message type">
                <Select
                  // The file travels with the type: sources whose .proto files
                  // declare no package can hold the same type name in several
                  // files, so the name alone is not a unique reference.
                  value={
                    spec.protoType ? `${spec.protoFile ?? ''} ${spec.protoType}` : ''
                  }
                  onChange={(composite) => {
                    const [protoFile, protoType] = composite.split(' ')
                    onChange({ protoType, protoFile: protoFile || undefined })
                  }}
                  options={(selectedProto?.types ?? []).map((t) => ({
                    value: `${t.file} ${t.fullName}`,
                    label: hasDuplicateNames ? `${t.fullName}  —  ${t.file}` : t.fullName
                  }))}
                />
              </Row>
              {selectedProto?.error && <Hint danger>{selectedProto.error}</Hint>}
            </>
          )}
        </div>
      )}

      {spec.kind === 'flatbuffers' && (
        <div className="flex flex-col gap-2">
          {fbsSchemas.length === 0 ? (
            <Hint>Add a .fbs schema in Settings first.</Hint>
          ) : (
            <>
              <Row label="Schema">
                <Select
                  value={spec.fbsSchemaId ?? ''}
                  onChange={(fbsSchemaId) => onChange({ fbsSchemaId, fbsRootType: undefined })}
                  options={fbsSchemas.map((s) => ({ value: s.id, label: s.name }))}
                />
              </Row>
              <Row label="Root type">
                <Select
                  value={spec.fbsRootType ?? selectedFbs?.rootType ?? ''}
                  onChange={(fbsRootType) => onChange({ fbsRootType })}
                  options={(selectedFbs?.tables ?? []).map((t) => ({ value: t, label: t }))}
                  placeholder={selectedFbs?.rootType ? `${selectedFbs.rootType} (from schema)` : undefined}
                />
              </Row>
              {selectedFbs?.error && <Hint danger>{selectedFbs.error}</Hint>}
            </>
          )}
        </div>
      )}

      {spec.kind === 'avro-sr' && (
        <Hint>
          Uses the cluster&apos;s Schema Registry settings. The schema id is read from the
          record&apos;s magic-byte header.
        </Hint>
      )}
    </fieldset>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <label className="grid grid-cols-[110px_1fr] items-center gap-3">
      <span className="text-[12px] text-[var(--text-secondary)]">{label}</span>
      {children}
    </label>
  )
}

function Select({
  value,
  onChange,
  options,
  placeholder
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
}): ReactNode {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-full rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2 text-[12px] text-[var(--text-primary)] focus:border-[var(--border-focus)] focus:outline-none"
    >
      <option value="">{placeholder ?? 'Choose…'}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

function Hint({ children, danger }: { children: ReactNode; danger?: boolean }): ReactNode {
  return (
    <p
      className={cx(
        'text-[11px]',
        danger ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'
      )}
    >
      {children}
    </p>
  )
}
