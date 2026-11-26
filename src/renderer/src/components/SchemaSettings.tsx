import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Archive, FileCode2, FolderOpen, RefreshCw, Trash2 } from 'lucide-react'
import type { FbsSchemaInfo, FlatcStatus, JarImportResult, ProtoSource } from '@shared/serde'
import { ApiError, call } from '../lib/api'
import { Badge, Button, Input, Panel, cx } from './common/ui'

/**
 * Schema sources are registered once and referenced per topic. Protobuf parses
 * a directory of `.proto` files at registration; FlatBuffers records a `.fbs`
 * path that `flatc` reads at decode time.
 */
export function SchemaSettings({ flatc }: { flatc: FlatcStatus | null }): ReactNode {
  const [protoSources, setProtoSources] = useState<ProtoSource[]>([])
  const [fbsSchemas, setFbsSchemas] = useState<FbsSchemaInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jarResult, setJarResult] = useState<JarImportResult | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const [protos, fbs] = await Promise.all([
      call('serde:listProtoSources'),
      call('serde:listFbsSchemas')
    ])
    setProtoSources(protos)
    setFbsSchemas(fbs)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const guard = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      await refresh()
    } catch (err) {
      // Cancelling the picker rejects too; that is not worth an error banner.
      const message = err instanceof ApiError ? err.message : 'Something went wrong.'
      if (!/No .* (was|were) chosen/.test(message)) setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Panel
        title="Protobuf sources"
        actions={
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              disabled={busy}
              title="Recover .proto schemas from jars of compiled protobuf classes and save them to a folder"
              onClick={() =>
                void guard(async () => {
                  setJarResult(await call('serde:importJars', ''))
                })
              }
            >
              <Archive size={13} /> Import from .jar
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => void guard(() => call('serde:addProtoSource', ''))}
            >
              <FolderOpen size={13} /> Add .proto directory
            </Button>
          </div>
        }
      >
        {jarResult && (
          <div className="border-b border-[var(--border)] bg-[var(--ok-subtle)] px-3 py-2 text-[11px] text-[var(--text-primary)]">
            Recovered <strong>{jarResult.files.length}</strong>{' '}
            {jarResult.files.length === 1 ? 'schema' : 'schemas'} from{' '}
            {jarResult.classesScanned} scanned classes. Written to{' '}
            <span className="num">{jarResult.outDir}</span>.
          </div>
        )}

        {protoSources.length === 0 ? (
          <Empty>
            Point Klarity at a directory of <code className="num">.proto</code> files, or{' '}
            <strong>import a .jar</strong> of compiled protobuf classes — protoc embeds the full
            schema in the generated classes, so Klarity can recover the{' '}
            <code className="num">.proto</code> files without a JVM.
          </Empty>
        ) : (
          <ul>
            {protoSources.map((source) => (
              <li
                key={source.id}
                className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-2.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] text-[var(--text-primary)]">
                      {source.name}
                    </span>
                    {/* A source with types is usable even when some files were
                        skipped, so only a total failure reads as an error. */}
                    {source.types.length > 0 ? (
                      <Badge color="protobuf">{source.types.length} types</Badge>
                    ) : (
                      <Badge color="error">error</Badge>
                    )}
                    {source.warning && <Badge color="avro">partial</Badge>}
                  </div>
                  <div className="num truncate text-[11px] text-[var(--text-muted)]">
                    {source.dir}
                  </div>
                  {source.error && (
                    <div className="text-[11px] text-[var(--danger)]">{source.error}</div>
                  )}
                  {source.warning && (
                    <details className="mt-0.5">
                      <summary className="cursor-pointer text-[11px] text-[var(--warn)]">
                        {source.warning}
                      </summary>
                      <ul className="mt-1 max-h-32 overflow-auto">
                        {(source.skipped ?? []).map((s) => (
                          <li key={s.file} className="num text-[10px] text-[var(--text-muted)]">
                            {s.file} — {s.reason}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
                <Button
                  size="sm"
                  aria-label="Reload"
                  title="Re-read the .proto files from disk"
                  disabled={busy}
                  onClick={() => void guard(() => call('serde:reloadProtoSource', source.id))}
                >
                  <RefreshCw size={12} />
                </Button>
                <Button
                  size="sm"
                  aria-label="Remove"
                  disabled={busy}
                  onClick={() => void guard(() => call('serde:removeProtoSource', source.id))}
                >
                  <Trash2 size={12} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="FlatBuffers schemas"
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => void guard(() => call('serde:addFbsSchema', ''))}
          >
            <FileCode2 size={13} /> Add .fbs schema
          </Button>
        }
      >
        {!flatc?.available && (
          <div className="border-b border-[var(--border)] bg-[var(--warn-subtle)] px-3 py-2 text-[11px] text-[var(--text-primary)]">
            {flatc?.error ?? 'flatc is not available.'} FlatBuffers decoding needs the FlatBuffers
            compiler; set its path below.
          </div>
        )}

        {fbsSchemas.length === 0 ? (
          <Empty>
            Register a <code className="num">.fbs</code> file, then pick it as the value serde on a
            topic. Decoding runs one <code className="num">flatc</code> call per batch, not per
            message.
          </Empty>
        ) : (
          <ul>
            {fbsSchemas.map((schema) => (
              <li
                key={schema.id}
                className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-2.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] text-[var(--text-primary)]">
                      {schema.name}
                    </span>
                    {schema.error ? (
                      <Badge color="error">error</Badge>
                    ) : (
                      <Badge color="flatbuffers">{schema.tables.length} tables</Badge>
                    )}
                    {schema.rootType && (
                      <span className="num text-[11px] text-[var(--text-muted)]">
                        root {schema.rootType}
                      </span>
                    )}
                  </div>
                  <div className="num truncate text-[11px] text-[var(--text-muted)]">
                    {schema.path}
                  </div>
                  {schema.error && (
                    <div className="text-[11px] text-[var(--danger)]">{schema.error}</div>
                  )}
                </div>
                <Button
                  size="sm"
                  aria-label="Remove"
                  disabled={busy}
                  onClick={() => void guard(() => call('serde:removeFbsSchema', schema.id))}
                >
                  <Trash2 size={12} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {error && (
        <div className="rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-subtle)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)]">
          {error}
        </div>
      )}
    </>
  )
}

/** Editable flatc path, shown in the Settings "Schema tooling" panel. */
export function FlatcPathRow({
  flatc,
  onChanged
}: {
  flatc: FlatcStatus | null
  onChanged: () => void
}): ReactNode {
  const [path, setPath] = useState('')

  useEffect(() => {
    setPath(flatc?.userProvided ? (flatc.path ?? '') : '')
  }, [flatc])

  return (
    <div className="flex items-center gap-2">
      <Input
        value={path}
        spellCheck={false}
        placeholder={flatc?.path ?? 'path to flatc'}
        className={cx('h-7 w-64', flatc?.available ? '' : 'border-[var(--warn)]')}
        onChange={(e) => setPath(e.target.value)}
      />
      <Button
        size="sm"
        onClick={() => {
          // Empty clears the override and falls back to bundled / PATH.
          void call('settings:set', { flatcPath: path.trim() || undefined }).then(onChanged)
        }}
      >
        Apply
      </Button>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }): ReactNode {
  return <p className="px-3 py-4 text-[12px] text-[var(--text-muted)]">{children}</p>
}
