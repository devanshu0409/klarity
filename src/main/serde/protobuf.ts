import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import protobuf from 'protobufjs'
import type { ProtoSource, ProtoTypeInfo } from '@shared/serde'
import { KlarityError } from '../util/errors'
import { logger } from '../util/log'
import { getProtoSource, upsertProtoSource } from '../store/schemaStore'

const log = logger('protobuf')

/**
 * A loaded source is either one shared root (the normal case, where packages
 * keep type names unique) or a root per file.
 *
 * The per-file mode exists because plenty of real schema jars declare no
 * `package` at all. protoc compiles each `.proto` independently, so two files
 * can both declare a top-level `Service` and never conflict — but loading them
 * into a single protobufjs root fails with "duplicate name". Falling back to a
 * root per file reproduces protoc's compilation-unit isolation, and the file
 * path becomes the disambiguator for a type name.
 */
type LoadedSource =
  | { mode: 'single'; root: protobuf.Root }
  | { mode: 'per-file'; roots: Map<string, protobuf.Root> }

const loaded = new Map<string, LoadedSource>()

function findProtoFiles(dir: string, depth = 0): string[] {
  // Guard against a user pointing at their home directory by accident.
  if (depth > 12) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) out.push(...findProtoFiles(full, depth + 1))
    else if (entry.endsWith('.proto')) out.push(full)
  }
  return out
}

function relPath(dir: string, file: string): string {
  return relative(dir, file).split(sep).join('/')
}

function newRoot(dir: string): protobuf.Root {
  const root = new protobuf.Root()
  // Resolve imports against the source directory, the layout `protoc -I <dir>`
  // expects, so a tree copied out of a repo works untouched.
  root.resolvePath = (_origin, target) => {
    if (target.startsWith('/') || /^[A-Za-z]:/.test(target)) return target
    return join(dir, target)
  }
  return root
}

/**
 * Walks a namespace tree collecting message types.
 *
 * `onlyFile` restricts the result to types declared in one file, which matters
 * in per-file mode: loading `a.proto` also pulls its imports into that root,
 * and those types belong to their own file's entry rather than this one.
 */
function collectTypes(
  node: protobuf.NamespaceBase,
  dir: string,
  out: ProtoTypeInfo[],
  onlyFile?: string
): void {
  for (const child of node.nestedArray) {
    if (child instanceof protobuf.Type) {
      if (!onlyFile || child.filename === onlyFile) {
        out.push({
          fullName: child.fullName.replace(/^\./, ''),
          file: child.filename ? relPath(dir, child.filename) : '',
          fieldCount: child.fieldsArray.length
        })
      }
      collectTypes(child, dir, out, onlyFile)
    } else if (child instanceof protobuf.Namespace) {
      collectTypes(child, dir, out, onlyFile)
    }
  }
}

/** Loads every `.proto` under a directory, caching the parsed result. */
export function loadProtoSource(name: string, dir: string, id?: string): ProtoSource {
  const files = findProtoFiles(dir)
  if (files.length === 0) {
    return upsertProtoSource({
      id,
      name,
      dir,
      types: [],
      error: 'No .proto files were found in that directory.'
    })
  }

  // Preferred path: one root, so cross-file references resolve naturally.
  try {
    const root = newRoot(dir)
    root.loadSync(files, { keepCase: true })
    root.resolveAll()

    const types: ProtoTypeInfo[] = []
    collectTypes(root, dir, types)
    types.sort((a, b) => a.fullName.localeCompare(b.fullName))

    const source = upsertProtoSource({ id, name, dir, types, loadedAt: Date.now() })
    loaded.set(source.id, { mode: 'single', root })
    log.info(`Loaded ${types.length} protobuf types from ${dir}`)
    return source
  } catch (err) {
    log.info(
      `Single-root load failed for ${dir} (${err instanceof Error ? err.message : 'error'}); ` +
        'falling back to one root per file'
    )
  }

  // Fallback: a root per file, mirroring how protoc compiled them.
  const roots = new Map<string, protobuf.Root>()
  const types: ProtoTypeInfo[] = []
  const failures: { file: string; reason: string }[] = []

  for (const file of files) {
    const rel = relPath(dir, file)
    try {
      const root = newRoot(dir)
      root.loadSync(file, { keepCase: true })
      root.resolveAll()
      roots.set(rel, root)
      collectTypes(root, dir, types, file)
    } catch (err) {
      // One unparseable file must not cost the user all the others.
      failures.push({
        file: rel,
        reason: err instanceof Error ? err.message : 'parse failed'
      })
    }
  }

  types.sort((a, b) => a.fullName.localeCompare(b.fullName) || a.file.localeCompare(b.file))

  if (roots.size === 0) {
    return upsertProtoSource({
      id,
      name,
      dir,
      types: [],
      error: failures[0]
        ? `${failures[0].file}: ${failures[0].reason}`
        : 'None of the .proto files could be parsed.',
      skipped: failures
    })
  }

  const source = upsertProtoSource({
    id,
    name,
    dir,
    types,
    loadedAt: Date.now(),
    // A warning, not an error: the source is usable, just not complete.
    warning:
      failures.length > 0
        ? `${failures.length} of ${files.length} files were skipped: two files in their import ` +
          'graph declare the same type name. In schemas with no `package` this is a real ' +
          'conflict — the same file would fail to load in Java too. Every other file is usable.'
        : undefined,
    skipped: failures.length > 0 ? failures : undefined
  })
  loaded.set(source.id, { mode: 'per-file', roots })
  log.info(
    `Loaded ${types.length} protobuf types from ${dir} across ${roots.size} files ` +
      `(per-file mode, ${failures.length} skipped)`
  )
  return source
}

function sourceFor(sourceId: string): LoadedSource {
  const cached = loaded.get(sourceId)
  if (cached) return cached

  const source = getProtoSource(sourceId)
  if (!source) {
    throw new KlarityError('SERDE_CONFIG', 'The configured .proto source no longer exists.')
  }
  loadProtoSource(source.name, source.dir, source.id)

  const now = loaded.get(sourceId)
  if (!now) {
    throw new KlarityError(
      'SCHEMA_LOAD_FAILED',
      `Could not load .proto files from ${source.dir}.`,
      source.error
    )
  }
  return now
}

/**
 * Resolves a message type. `file` disambiguates in per-file mode, where the
 * same type name can legitimately exist in several files.
 */
export function lookupType(sourceId: string, typeName: string, file?: string): protobuf.Type {
  const source = sourceFor(sourceId)

  if (source.mode === 'single') {
    try {
      return source.root.lookupType(typeName)
    } catch {
      throw new KlarityError(
        'SERDE_CONFIG',
        `Message type "${typeName}" is not in that .proto source.`,
        'Reload the source, or pick a different type.'
      )
    }
  }

  if (file) {
    const root = source.roots.get(file)
    if (!root) {
      throw new KlarityError(
        'SERDE_CONFIG',
        `File "${file}" is not in that .proto source.`,
        'Reload the source, or pick the type again.'
      )
    }
    try {
      return root.lookupType(typeName)
    } catch {
      throw new KlarityError(
        'SERDE_CONFIG',
        `Message type "${typeName}" is not declared in ${file}.`
      )
    }
  }

  // No file recorded (an older saved config): accept it only when the name is
  // unambiguous, rather than silently picking whichever file sorts first.
  const matches: protobuf.Type[] = []
  for (const root of source.roots.values()) {
    try {
      matches.push(root.lookupType(typeName))
    } catch {
      // Not in this file.
    }
  }
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) {
    throw new KlarityError('SERDE_CONFIG', `Message type "${typeName}" is not in that source.`)
  }
  throw new KlarityError(
    'SERDE_CONFIG',
    `"${typeName}" is declared in ${matches.length} files.`,
    'Choose the type again so the file is recorded with it.'
  )
}

/**
 * Decodes to a plain object. `defaults` fills unset scalars so the output shows
 * the full shape rather than only the fields that happened to be on the wire,
 * and `longs: String` keeps int64 out of float range.
 */
export function decodeProtobuf(
  buffer: Buffer,
  sourceId: string,
  typeName: string,
  file?: string
): string {
  const type = lookupType(sourceId, typeName, file)
  const message = type.decode(buffer)
  const object = type.toObject(message, {
    longs: String,
    enums: String,
    bytes: String,
    defaults: true,
    arrays: true,
    objects: true
  })
  return JSON.stringify(object, null, 2)
}

/** protobufjs scalar field types; anything else names a message, map or enum. */
const SCALAR_TYPES = new Set([
  'double', 'float', 'int32', 'uint32', 'sint32', 'fixed32', 'sfixed32',
  'int64', 'uint64', 'sint64', 'fixed64', 'sfixed64', 'bool', 'string', 'bytes'
])

/**
 * Catches the two mistakes protobufjs accepts silently, both of which would put
 * wrong bytes on a topic:
 *
 *  - an unknown field name (a typo, or camelCase where the schema uses
 *    snake_case) is dropped without a word, so the message ships missing data;
 *  - an object or array handed to a scalar field is coerced with `String()`,
 *    which is how a nested object becomes the literal `[object Object]`.
 *
 * ponytail: top-level fields only. That is where hand-edited JSON goes wrong;
 * recursing into every nested message would mean reimplementing `verify`.
 */
function assertShape(type: protobuf.Type, parsed: unknown): void {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new KlarityError(
      'SERDE_CONFIG',
      `A ${type.fullName} message must be a JSON object.`
    )
  }

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const field = type.fields[key]
    if (!field) {
      throw new KlarityError(
        'SERDE_CONFIG',
        `"${key}" is not a field of ${type.fullName}.`,
        `Fields: ${Object.keys(type.fields).join(', ')}`
      )
    }

    const isScalar = SCALAR_TYPES.has(field.type) && !field.repeated && !field.map
    if (isScalar && typeof value === 'object' && value !== null) {
      throw new KlarityError(
        'SERDE_CONFIG',
        `Field "${key}" of ${type.fullName} is a ${field.type}, but the value is ` +
          `${Array.isArray(value) ? 'an array' : 'an object'}.`
      )
    }
  }
}

/**
 * Encodes a JSON document for producing.
 *
 * `fromObject` runs *before* `verify` on purpose: decoding emits int64 as a
 * string (see `longs: String` above), and `verify` rejects a string for an
 * int64 field. Validating the raw JSON would therefore reject the exact
 * document this app just produced from the wire — converting first makes the
 * decode -> edit -> produce round trip work.
 */
export function encodeProtobuf(
  json: string,
  sourceId: string,
  typeName: string,
  file?: string
): Buffer {
  const type = lookupType(sourceId, typeName, file)
  const parsed: unknown = JSON.parse(json)
  assertShape(type, parsed)

  let message: protobuf.Message<Record<string, unknown>>
  try {
    message = type.fromObject(parsed as Record<string, unknown>)
  } catch (err) {
    throw new KlarityError(
      'SERDE_CONFIG',
      `Message does not match ${typeName}: ${err instanceof Error ? err.message : 'invalid'}`
    )
  }

  const invalid = type.verify(message)
  if (invalid) {
    throw new KlarityError('SERDE_CONFIG', `Message does not match ${typeName}: ${invalid}`)
  }
  return Buffer.from(type.encode(message).finish())
}

/** Drops cached roots so the next decode re-reads from disk. */
export function invalidateProtoCache(sourceId?: string): void {
  if (sourceId) loaded.delete(sourceId)
  else loaded.clear()
}
