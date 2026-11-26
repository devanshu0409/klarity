/**
 * Recovers protobuf `FileDescriptorProto` blobs from compiled Java classes.
 *
 * protoc's Java generator embeds the full serialized descriptor of a `.proto`
 * file directly into the generated outer class:
 *
 *   java.lang.String[] descriptorData = { "\n\022order.proto\022\017acme..." };
 *   descriptor = FileDescriptor.internalBuildGeneratedFileFrom(descriptorData, ...)
 *
 * Each descriptor byte is written as a Java `char` in the range 0x00-0xFF, and
 * the literal lands in the class file's constant pool as a CONSTANT_Utf8 entry
 * in *modified* UTF-8. Decoding that entry back to char codes and masking each
 * to a byte reproduces the original descriptor bytes exactly — which means a
 * schema can be recovered from a jar of compiled classes with no JVM and no
 * access to the original `.proto` files.
 */

const MAGIC = 0xcafebabe

const enum Tag {
  Utf8 = 1,
  Integer = 3,
  Float = 4,
  Long = 5,
  Double = 6,
  Class = 7,
  String = 8,
  Fieldref = 9,
  Methodref = 10,
  InterfaceMethodref = 11,
  NameAndType = 12,
  MethodHandle = 15,
  MethodType = 16,
  Dynamic = 17,
  InvokeDynamic = 18,
  Module = 19,
  Package = 20
}

/**
 * Decodes Java's modified UTF-8 into char codes.
 *
 * It differs from standard UTF-8 in two ways that matter here: NUL is encoded
 * as the two bytes C0 80 (so it never appears as a raw 0 inside a string), and
 * supplementary characters are written as two 3-byte surrogate halves. Since
 * descriptor payloads only ever use chars 0x00-0xFF, the 1- and 2-byte forms
 * carry everything; the 3-byte branch is handled for completeness so that
 * ordinary class strings do not derail the scan.
 */
function decodeModifiedUtf8(bytes: Buffer): number[] | null {
  const chars: number[] = []
  let i = 0
  while (i < bytes.length) {
    const a = bytes[i]
    if (a === 0) return null // a raw NUL is invalid in modified UTF-8
    if (a < 0x80) {
      chars.push(a)
      i += 1
    } else if ((a & 0xe0) === 0xc0) {
      if (i + 1 >= bytes.length) return null
      const b = bytes[i + 1]
      if ((b & 0xc0) !== 0x80) return null
      chars.push(((a & 0x1f) << 6) | (b & 0x3f))
      i += 2
    } else if ((a & 0xf0) === 0xe0) {
      if (i + 2 >= bytes.length) return null
      const b = bytes[i + 1]
      const c = bytes[i + 2]
      if ((b & 0xc0) !== 0x80 || (c & 0xc0) !== 0x80) return null
      chars.push(((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f))
      i += 3
    } else {
      return null
    }
  }
  return chars
}

/**
 * Parsed constant pool: the UTF-8 entries in pool order, plus the names of
 * every class the file references.
 *
 * The class references matter for jar import. When a `.proto` name is ambiguous
 * (several source trees each defining `ports.proto`), the generated class's
 * reference to its dependency class — `.../agent/PortsProto` versus
 * `.../vm/scan/PortsProto` — is the only record of which variant that file was
 * actually compiled against.
 */
export interface ConstantPool {
  utf8: string[]
  classNames: string[]
}

export function parseConstantPool(classFile: Buffer): ConstantPool {
  if (classFile.length < 10 || classFile.readUInt32BE(0) !== MAGIC) {
    return { utf8: [], classNames: [] }
  }

  const count = classFile.readUInt16BE(8)
  const utf8ByIndex = new Map<number, string>()
  const utf8: string[] = []
  const classNameIndices: number[] = []
  let offset = 10

  // Pool indices are 1-based, and Long/Double occupy two slots each.
  for (let index = 1; index < count; index++) {
    if (offset >= classFile.length) break
    const tag = classFile[offset]
    offset += 1

    switch (tag) {
      case Tag.Utf8: {
        if (offset + 2 > classFile.length) return { utf8, classNames: [] }
        const length = classFile.readUInt16BE(offset)
        offset += 2
        const raw = classFile.subarray(offset, offset + length)
        offset += length
        const chars = decodeModifiedUtf8(raw)
        const value = chars === null ? '' : String.fromCharCode(...chars)
        utf8ByIndex.set(index, value)
        utf8.push(value)
        break
      }
      case Tag.Class: {
        if (offset + 2 > classFile.length) return { utf8, classNames: [] }
        classNameIndices.push(classFile.readUInt16BE(offset))
        offset += 2
        break
      }
      case Tag.Integer:
      case Tag.Float:
      case Tag.Fieldref:
      case Tag.Methodref:
      case Tag.InterfaceMethodref:
      case Tag.NameAndType:
      case Tag.Dynamic:
      case Tag.InvokeDynamic:
        offset += 4
        break
      case Tag.Long:
      case Tag.Double:
        offset += 8
        index += 1 // these consume two constant-pool slots
        break
      case Tag.String:
      case Tag.MethodType:
      case Tag.Module:
      case Tag.Package:
        offset += 2
        break
      case Tag.MethodHandle:
        offset += 3
        break
      default:
        // An unknown tag means the walk has desynchronised; stop rather than
        // emit garbage.
        return {
          utf8,
          classNames: classNameIndices
            .map((i) => utf8ByIndex.get(i))
            .filter((n): n is string => !!n)
        }
    }
  }

  return {
    utf8,
    classNames: classNameIndices
      .map((i) => utf8ByIndex.get(i))
      .filter((n): n is string => !!n)
  }
}

/** Every CONSTANT_Utf8 entry, in pool order. */
export function readUtf8Constants(classFile: Buffer): string[] {
  return parseConstantPool(classFile).utf8
}

/** Names of the classes this class file references, in internal `a/b/C` form. */
export function readClassReferences(classFile: Buffer): string[] {
  return parseConstantPool(classFile).classNames
}

/** True when every char fits in a byte, i.e. the string may be descriptor bytes. */
function isByteString(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0xff) return false
  }
  return true
}

function toBytes(value: string): Buffer {
  const bytes = Buffer.allocUnsafe(value.length)
  for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 0xff
  return bytes
}

/**
 * Returns candidate descriptor byte blobs found in a class file, largest first.
 *
 * A serialized FileDescriptorProto starts with field 1 (`name`), which on the
 * wire is tag byte 0x0A followed by a varint length and the file name — so
 * candidates are anchored on 0x0A and validated by the caller actually decoding
 * them. Consecutive byte-strings are also joined, to cover descriptors that
 * protoc had to split across multiple literals.
 */
export function findDescriptorCandidates(classFile: Buffer): Buffer[] {
  const constants = parseConstantPool(classFile).utf8
  const candidates: Buffer[] = []

  for (let i = 0; i < constants.length; i++) {
    const value = constants[i]
    // The shortest plausible descriptor still carries a file name.
    if (value.length < 8 || value.charCodeAt(0) !== 0x0a) continue
    if (!isByteString(value)) continue

    candidates.push(toBytes(value))

    // Rejoin continuation literals: protoc emits chunks of just under 64KB, so
    // only try this when the first chunk is at the limit.
    if (value.length >= 0xfff0) {
      let joined = value
      for (let j = i + 1; j < constants.length; j++) {
        const next = constants[j]
        if (next.length === 0 || !isByteString(next)) break
        joined += next
        candidates.push(toBytes(joined))
        if (next.length < 0xfff0) break
      }
    }
  }

  // Longer candidates first: a full descriptor beats an incidental prefix.
  return candidates.sort((a, b) => b.length - a.length)
}
