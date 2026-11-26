import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, posix } from 'node:path'
import AdmZip from 'adm-zip'
import descriptorExt from 'protobufjs/ext/descriptor.js'
import type { JarImportResult, JarImportedFile } from '@shared/serde'
import { KlarityError } from '../util/errors'
import { logger } from '../util/log'
import { findDescriptorCandidates, readClassReferences } from './javaClass'
import { descriptorToProto, type FileProto } from './descriptorToProto'

const log = logger('jar-import')

interface DescriptorTypes {
  FileDescriptorProto: {
    decode: (buffer: Buffer) => { $type: unknown; toJSON: () => unknown }
  }
  FileDescriptorSet: {
    decode: (buffer: Buffer) => { file?: unknown[] }
  }
}

const descriptorTypes = descriptorExt as unknown as DescriptorTypes

/**
 * A descriptor decodes "successfully" far too easily — protobuf is a permissive
 * wire format, so random bytes often parse. Requiring a plausible file name and
 * at least one declaration is what separates a real descriptor from noise.
 */
function looksLikeRealDescriptor(file: FileProto): boolean {
  if (!file.name || !/\.proto$/i.test(file.name)) return false
  const declarations =
    (file.messageType?.length ?? 0) + (file.enumType?.length ?? 0) + (file.service?.length ?? 0)
  return declarations > 0
}

function decodeFileDescriptor(bytes: Buffer): FileProto | null {
  try {
    const message = descriptorTypes.FileDescriptorProto.decode(bytes)
    const file = message.toJSON() as FileProto
    return looksLikeRealDescriptor(file) ? file : null
  } catch {
    return null
  }
}

/** Pulls every descriptor out of a `.desc` / FileDescriptorSet payload. */
function decodeDescriptorSet(bytes: Buffer): FileProto[] {
  try {
    const set = descriptorTypes.FileDescriptorSet.decode(bytes)
    const files: FileProto[] = []
    for (const entry of set.file ?? []) {
      const file = entry as FileProto
      if (looksLikeRealDescriptor(file)) files.push(file)
    }
    return files
  } catch {
    return []
  }
}

/**
 * One recovered descriptor, plus the evidence needed to resolve its imports.
 *
 * `owner` is the class it came from and `references` the classes that class
 * points at. When several source trees each define `ports.proto`, that
 * reference list is the only surviving record of which variant this file was
 * compiled against.
 */
interface Candidate {
  proto: FileProto
  /** Class name in internal form, e.g. `com/acme/agent/PortsProto`. */
  owner?: string
  references: string[]
  /** Directory of the owning class, used to namespace ambiguous names. */
  ownerDir: string
  source: string
  origin: JarImportedFile['origin']
  /** Identity of the content, so identical copies collapse. */
  hash: string
  /** Verbatim text for descriptors that arrived as real `.proto` files. */
  rawText?: string
  /** Assigned in a second pass once ambiguity is known. */
  outPath: string
}

function hashOf(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12)
}

function scanArchive(
  zipBuffer: Buffer,
  source: string,
  out: Candidate[],
  counters: { classesScanned: number },
  depth = 0
): void {
  // Fat jars (Spring Boot BOOT-INF/lib, shaded uber-jars) nest their real
  // dependencies as jars inside the jar.
  if (depth > 3) return

  let zip: AdmZip
  try {
    zip = new AdmZip(zipBuffer)
  } catch (err) {
    log.warn(`Could not read ${source} as an archive`, err)
    return
  }

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = entry.entryName
    const lower = name.toLowerCase()

    try {
      if (lower.endsWith('.proto')) {
        // Best case: the jar ships the original sources.
        const text = entry.getData().toString('utf8')
        out.push({
          proto: { name },
          references: [],
          ownerDir: posix.dirname(name),
          source,
          origin: 'proto',
          hash: hashOf(text),
          rawText: text,
          outPath: name
        })
      } else if (lower.endsWith('.desc') || lower.endsWith('.dsc') || lower.endsWith('.protoset')) {
        for (const proto of decodeDescriptorSet(entry.getData())) {
          out.push({
            proto,
            references: [],
            ownerDir: posix.dirname(proto.name as string),
            source: `${source}!${name}`,
            origin: 'descriptor-set',
            hash: hashOf(JSON.stringify(proto)),
            outPath: proto.name as string
          })
        }
      } else if (lower.endsWith('.class')) {
        counters.classesScanned += 1
        const data = entry.getData()
        for (const candidate of findDescriptorCandidates(data)) {
          const proto = decodeFileDescriptor(candidate)
          if (!proto) continue
          const owner = name.replace(/\.class$/, '')
          out.push({
            proto,
            owner,
            references: readClassReferences(data),
            ownerDir: posix.dirname(owner),
            source: `${source}!${name}`,
            origin: 'class',
            hash: hashOf(candidate.toString('base64')),
            outPath: proto.name as string
          })
          // The outer class holds exactly one descriptor; stop at the first hit.
          break
        }
      } else if (lower.endsWith('.jar') || lower.endsWith('.zip')) {
        scanArchive(entry.getData(), `${source}!${name}`, out, counters, depth + 1)
      }
    } catch (err) {
      log.debug(`Skipped ${name} in ${source}`, err)
    }
  }
}

/**
 * Assigns an output path to every candidate.
 *
 * A file needs one copy per Java package when anything in its import closure is
 * ambiguous — not merely when its own name is. `qualysCustomAttribute.proto` is
 * byte-identical across source trees, yet each build resolved its
 * `attributeAction.proto` import to a different variant. Sharing one copy would
 * drag a foreign `AttributeAction` into every importer's closure and collide.
 *
 * Everything untouched by ambiguity keeps its plain path, so the output stays
 * readable instead of burying 300 files under package directories.
 */
function assignPaths(candidates: Candidate[]): Map<string, Candidate> {
  const grouped = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const name = candidate.proto.name as string
    const list = grouped.get(name)
    if (list) list.push(candidate)
    else grouped.set(name, [candidate])
  }

  // A `.proto` the jar actually ships is the source of truth: it supersedes
  // every descriptor reconstructed for the same path.
  const effective = new Map<string, Candidate[]>()
  for (const [name, list] of grouped) {
    const shipped = list.filter((c) => c.origin === 'proto')
    effective.set(name, shipped.length > 0 ? shipped : list)
  }

  // Ambiguous names are those with more than one distinct content.
  const ambiguous = new Set<string>()
  for (const [name, list] of effective) {
    const hashes = new Set(list.map((c) => c.hash))
    if (hashes.size > 1) ambiguous.add(name)
  }

  // Propagate contamination up the import graph: importers of an ambiguous
  // file need per-package copies too.
  const importers = new Map<string, Set<string>>()
  for (const [name, list] of effective) {
    for (const candidate of list) {
      for (const dep of candidate.proto.dependency ?? []) {
        if (!importers.has(dep)) importers.set(dep, new Set())
        importers.get(dep)!.add(name)
      }
    }
  }

  const needsNamespace = new Set(ambiguous)
  const queue = [...ambiguous]
  while (queue.length > 0) {
    const current = queue.pop() as string
    for (const importer of importers.get(current) ?? []) {
      if (needsNamespace.has(importer)) continue
      needsNamespace.add(importer)
      queue.push(importer)
    }
  }

  const chosen = new Map<string, Candidate>()
  for (const [name, list] of effective) {
    if (!needsNamespace.has(name)) {
      // Untouched by ambiguity: one copy at its plain path.
      chosen.set(name, list[0])
      list[0].outPath = name
      continue
    }
    // One copy per owning package, so each compilation unit keeps its own
    // consistent view of its dependencies.
    for (const candidate of list) {
      const outPath = posix.join(candidate.ownerDir, name)
      candidate.outPath = outPath
      if (!chosen.has(outPath)) chosen.set(outPath, candidate)
    }
  }
  return chosen
}

/**
 * Rewrites a descriptor's `dependency` list to the concrete files that were
 * written, following the owning class's references so each importer gets the
 * exact variant it was compiled against.
 */
function resolveDependencies(
  candidate: Candidate,
  chosen: Map<string, Candidate>,
  byOwner: Map<string, Candidate>,
  byName: Map<string, Candidate[]>
): FileProto {
  const deps = candidate.proto.dependency
  if (!deps || deps.length === 0) return candidate.proto

  const referenced = new Set(candidate.references)
  const rewritten = deps.map((dep) => {
    const variants = byName.get(dep) ?? []
    if (variants.length === 0) return dep // e.g. google/protobuf/*.proto
    if (variants.length === 1) return variants[0].outPath

    // Ambiguous: pick the variant whose generating class this one references.
    const match = variants.find((v) => v.owner && referenced.has(v.owner))
    if (match) return match.outPath

    // No class reference survived (rare). Prefer a sibling from the same Java
    // package over an arbitrary pick — same-package files were built together.
    const sibling = variants.find((v) => v.ownerDir === candidate.ownerDir)
    return (sibling ?? variants[0]).outPath
  })

  void chosen
  void byOwner
  return { ...candidate.proto, dependency: rewritten }
}

/**
 * Extracts `.proto` schemas from jars of compiled protobuf classes and writes
 * them into `outDir`, ready to register as an ordinary Protobuf source.
 *
 * Three recovery routes, in descending order of fidelity:
 *   1. `.proto` files the jar already ships (copied verbatim)
 *   2. `.desc` / FileDescriptorSet payloads
 *   3. descriptors embedded in protoc-generated `.class` files
 */
export function importProtosFromJars(jarPaths: string[], outDir: string): JarImportResult {
  if (jarPaths.length === 0) throw new KlarityError('INVALID_INPUT', 'No jar files were chosen.')

  const candidates: Candidate[] = []
  const counters = { classesScanned: 0 }

  for (const jarPath of jarPaths) {
    let buffer: Buffer
    try {
      buffer = new AdmZip(jarPath).toBuffer()
    } catch (err) {
      throw new KlarityError(
        'SCHEMA_LOAD_FAILED',
        `Could not open ${jarPath}.`,
        err instanceof Error ? err.message : undefined
      )
    }
    scanArchive(buffer, jarPath, candidates, counters, 0)
  }

  const chosen = assignPaths(candidates)

  // Indexes used to resolve imports.
  const byOwner = new Map<string, Candidate>()
  const byName = new Map<string, Candidate[]>()
  for (const candidate of chosen.values()) {
    if (candidate.owner) byOwner.set(candidate.owner, candidate)
    const name = candidate.proto.name as string
    const list = byName.get(name)
    if (list) list.push(candidate)
    else byName.set(name, [candidate])
  }

  const files: JarImportedFile[] = []
  for (const candidate of [...chosen.values()].sort((a, b) => a.outPath.localeCompare(b.outPath))) {
    const content =
      candidate.rawText ??
      descriptorToProto(resolveDependencies(candidate, chosen, byOwner, byName))
    files.push({
      path: candidate.outPath,
      origin: candidate.origin,
      source: candidate.source,
      content
    })
  }

  for (const file of files) {
    // Descriptor names are proto paths (`acme/orders/v1/order.proto`); keeping
    // that layout is what makes the `import` statements between them resolve.
    const target = join(outDir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content, 'utf8')
  }

  const ambiguous = [...byName.values()].filter((v) => v.length > 1).length
  log.info(
    `Recovered ${files.length} .proto files from ${jarPaths.length} jar(s) ` +
      `(${counters.classesScanned} classes scanned, ${ambiguous} names had multiple variants) ` +
      `into ${outDir}`
  )

  return {
    outDir,
    classesScanned: counters.classesScanned,
    files: files.map(({ content: _content, ...rest }) => ({ ...rest, content: '' }))
  }
}
