import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { FbsSchemaInfo, FlatcStatus } from '@shared/serde'
import { KlarityError } from '../util/errors'
import { logger } from '../util/log'
import { getSettings } from '../store/settings'
import { getFbsSchema, upsertFbsSchema } from '../store/schemaStore'

const log = logger('flatbuffers')
const run = promisify(execFile)

/**
 * FlatBuffers has no runtime `.fbs` parser in JavaScript, so decoding goes
 * through the official `flatc` binary. That is a subprocess, which is only
 * viable because it is invoked **per batch** — flatc accepts many binaries in
 * one call — never per message.
 */

let cachedStatus: FlatcStatus | null = null

/** Bundled binary first, then a user override, then whatever is on PATH. */
function candidatePaths(): string[] {
  const override = getSettings().flatcPath
  const exe = process.platform === 'win32' ? 'flatc.exe' : 'flatc'
  const bundled = app.isPackaged
    ? join(process.resourcesPath, 'flatc', `${process.platform}-${process.arch}`, exe)
    : join(app.getAppPath(), 'resources', 'flatc', `${process.platform}-${process.arch}`, exe)

  return [override, bundled, exe].filter((p): p is string => !!p)
}

export function flatcStatus(): FlatcStatus {
  if (cachedStatus) return cachedStatus

  const override = getSettings().flatcPath
  for (const candidate of candidatePaths()) {
    try {
      // `flatc --version` doubles as the existence check: a bare path test
      // would pass for a file that cannot actually execute.
      const output = execFileSync(candidate, ['--version'], {
        encoding: 'utf8',
        timeout: 5_000
      })
      cachedStatus = {
        available: true,
        path: candidate,
        version: output.trim(),
        userProvided: candidate === override
      }
      return cachedStatus
    } catch {
      // Try the next candidate.
    }
  }

  cachedStatus = {
    available: false,
    userProvided: !!override,
    error:
      'flatc was not found. Install the FlatBuffers compiler and set its path in Settings.'
  }
  return cachedStatus
}

/** Called when the user changes the configured path. */
export function invalidateFlatcStatus(): void {
  cachedStatus = null
}

function requireFlatc(): string {
  const status = flatcStatus()
  if (!status.available || !status.path) {
    throw new KlarityError('FLATC_MISSING', status.error ?? 'flatc is not available.')
  }
  return status.path
}

/**
 * Reads the table names out of a `.fbs` file. A regex is enough here: the goal
 * is to offer a root-type picker, and flatc itself validates the real grammar
 * when it runs.
 */
export function loadFbsSchema(name: string, path: string, id?: string): FbsSchemaInfo {
  if (!existsSync(path)) {
    return upsertFbsSchema({ id, name, path, tables: [], error: 'That .fbs file no longer exists.' })
  }

  try {
    const text = readFileSync(path, 'utf8')
    const tables = [...text.matchAll(/^\s*table\s+([A-Za-z_]\w*)/gm)].map((m) => m[1])
    const rootMatch = /^\s*root_type\s+([A-Za-z_]\w*)\s*;/m.exec(text)
    return upsertFbsSchema({
      id,
      name,
      path,
      tables,
      rootType: rootMatch?.[1],
      loadedAt: Date.now()
    })
  } catch (err) {
    return upsertFbsSchema({
      id,
      name,
      path,
      tables: [],
      error: err instanceof Error ? err.message : 'Could not read the .fbs file.'
    })
  }
}

function schemaPath(schemaId: string): string {
  const schema = getFbsSchema(schemaId)
  if (!schema) {
    throw new KlarityError('SERDE_CONFIG', 'The configured .fbs schema no longer exists.')
  }
  if (!existsSync(schema.path)) {
    throw new KlarityError('SCHEMA_LOAD_FAILED', `Schema file is missing: ${schema.path}`)
  }
  return schema.path
}

/**
 * Decodes a batch of FlatBuffer payloads in a single `flatc` invocation.
 * Returns JSON text per input index; entries that flatc could not convert come
 * back as `null` so the caller can fall back to raw for just those records.
 */
export async function decodeFlatBuffersBatch(
  buffers: Buffer[],
  schemaId: string,
  rootType?: string
): Promise<(string | null)[]> {
  if (buffers.length === 0) return []

  const flatc = requireFlatc()
  const fbs = schemaPath(schemaId)
  const dir = mkdtempSync(join(tmpdir(), 'klarity-fbs-'))

  try {
    // Names are index-padded so the output filenames sort back to input order.
    const inputs = buffers.map((buffer, index) => {
      const file = join(dir, `m${String(index).padStart(6, '0')}.bin`)
      writeFileSync(file, buffer)
      return file
    })

    const args = [
      '--json',
      '--strict-json',
      '--raw-binary',
      // Without this flatc omits fields sitting at their default value, which
      // reads as "the field is missing" rather than "the field is 0".
      '--defaults-json',
      ...(rootType ? ['--root-type', rootType] : []),
      '-o',
      dir,
      fbs,
      '--',
      ...inputs
    ]

    try {
      await run(flatc, args, { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
    } catch (err) {
      // flatc exits non-zero when *any* input fails; the ones it managed to
      // convert are still on disk, so keep going and report per-record below.
      log.debug('flatc reported an error for part of the batch', err)
    }

    const produced = new Set(readdirSync(dir).filter((f) => f.endsWith('.json')))
    return inputs.map((input) => {
      const jsonName = `${basename(input, '.bin')}.json`
      if (!produced.has(jsonName)) return null
      try {
        return readFileSync(join(dir, jsonName), 'utf8')
      } catch {
        return null
      }
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Encodes one JSON document into FlatBuffer bytes, for producing. */
export async function encodeFlatBuffers(
  json: string,
  schemaId: string,
  rootType?: string
): Promise<Buffer> {
  const flatc = requireFlatc()
  const fbs = schemaPath(schemaId)
  const dir = mkdtempSync(join(tmpdir(), 'klarity-fbs-enc-'))

  try {
    const input = join(dir, 'message.json')
    writeFileSync(input, json, 'utf8')

    const args = [
      '--binary',
      ...(rootType ? ['--root-type', rootType] : []),
      '-o',
      dir,
      fbs,
      input
    ]
    await run(flatc, args, { timeout: 30_000 })

    const output = join(dir, 'message.bin')
    if (!existsSync(output)) {
      throw new KlarityError(
        'SERDE_CONFIG',
        'flatc did not produce any output for that JSON.',
        'Check that the document matches the schema.'
      )
    }
    return readFileSync(output)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
