/**
 * Renders a `FileDescriptorProto` back into `.proto` source text.
 *
 * Descriptors recovered from compiled Java classes are complete but binary;
 * writing them back out as readable `.proto` files means the rest of the app
 * needs no new concepts — the extracted directory registers as an ordinary
 * Protobuf source and every existing decode path applies unchanged.
 */

/** Wire types from descriptor.proto's FieldDescriptorProto.Type. */
const SCALAR_TYPES: Record<number, string> = {
  1: 'double',
  2: 'float',
  3: 'int64',
  4: 'uint64',
  5: 'int32',
  6: 'fixed64',
  7: 'fixed32',
  8: 'bool',
  9: 'string',
  10: 'group',
  11: 'message',
  12: 'bytes',
  13: 'uint32',
  14: 'enum',
  15: 'sfixed32',
  16: 'sfixed64',
  17: 'sint32',
  18: 'sint64'
}

/**
 * Descriptor enums arrive either as numbers (binary decode) or as their proto
 * names (`toJSON()` output, and most JSON descriptor dumps). Normalising both
 * shapes here keeps every call site free of the distinction.
 */
const TYPE_NAMES: Record<string, number> = {
  TYPE_DOUBLE: 1,
  TYPE_FLOAT: 2,
  TYPE_INT64: 3,
  TYPE_UINT64: 4,
  TYPE_INT32: 5,
  TYPE_FIXED64: 6,
  TYPE_FIXED32: 7,
  TYPE_BOOL: 8,
  TYPE_STRING: 9,
  TYPE_GROUP: 10,
  TYPE_MESSAGE: 11,
  TYPE_BYTES: 12,
  TYPE_UINT32: 13,
  TYPE_ENUM: 14,
  TYPE_SFIXED32: 15,
  TYPE_SFIXED64: 16,
  TYPE_SINT32: 17,
  TYPE_SINT64: 18
}

const LABEL_NAMES: Record<string, number> = {
  LABEL_OPTIONAL: 1,
  LABEL_REQUIRED: 2,
  LABEL_REPEATED: 3
}

function fieldType(field: FieldProto): number {
  const raw = field.type
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') return TYPE_NAMES[raw] ?? 0
  return 0
}

function fieldLabel(field: FieldProto): number {
  const raw = field.label
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') return LABEL_NAMES[raw] ?? LABEL_OPTIONAL
  return LABEL_OPTIONAL
}

const LABEL_OPTIONAL = 1
const LABEL_REQUIRED = 2
const LABEL_REPEATED = 3
const TYPE_MESSAGE = 11
const TYPE_ENUM = 14
const TYPE_STRING = 9
const TYPE_BYTES = 12

interface FieldProto {
  name?: string
  number?: number
  label?: number | string
  type?: number | string
  typeName?: string
  jsonName?: string
  oneofIndex?: number
  proto3Optional?: boolean
  defaultValue?: string
  options?: { packed?: boolean; deprecated?: boolean }
}

interface EnumProto {
  name?: string
  value?: { name?: string; number?: number; options?: { deprecated?: boolean } }[]
  options?: { allowAlias?: boolean; deprecated?: boolean }
}

interface MessageProto {
  name?: string
  field?: FieldProto[]
  nestedType?: MessageProto[]
  enumType?: EnumProto[]
  oneofDecl?: { name?: string }[]
  options?: { mapEntry?: boolean; deprecated?: boolean }
  reservedRange?: { start?: number; end?: number }[]
  reservedName?: string[]
}

interface ServiceProto {
  name?: string
  method?: {
    name?: string
    inputType?: string
    outputType?: string
    clientStreaming?: boolean
    serverStreaming?: boolean
  }[]
}

export interface FileProto {
  name?: string
  package?: string
  dependency?: string[]
  messageType?: MessageProto[]
  enumType?: EnumProto[]
  service?: ServiceProto[]
  syntax?: string
  options?: Record<string, unknown>
}

const FILE_OPTION_KEYS: [string, string][] = [
  ['javaPackage', 'java_package'],
  ['javaOuterClassname', 'java_outer_classname'],
  ['javaMultipleFiles', 'java_multiple_files'],
  ['goPackage', 'go_package'],
  ['objcClassPrefix', 'objc_class_prefix'],
  ['csharpNamespace', 'csharp_namespace'],
  ['phpNamespace', 'php_namespace'],
  ['deprecated', 'deprecated']
]

/** Strips the leading dot protoc puts on fully-qualified type references. */
function typeRef(name: string | undefined): string {
  return (name ?? '').replace(/^\./, '')
}

function indent(depth: number): string {
  return '  '.repeat(depth)
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function fieldTypeName(field: FieldProto): string {
  const type = fieldType(field)
  if (type === TYPE_MESSAGE || type === TYPE_ENUM) return typeRef(field.typeName)
  return SCALAR_TYPES[type] ?? 'bytes'
}

function fieldOptions(field: FieldProto, isProto3: boolean): string {
  const parts: string[] = []
  // proto2 defaults must be preserved or the schema changes meaning.
  if (field.defaultValue !== undefined && field.defaultValue !== '') {
    const type = fieldType(field)
    const literal =
      type === TYPE_STRING || type === TYPE_BYTES
        ? quote(field.defaultValue)
        : field.defaultValue
    parts.push(`default = ${literal}`)
  }
  // `packed` is the proto2 default-off case worth emitting; proto3 packs by default.
  if (field.options?.packed === true && !isProto3) parts.push('packed = true')
  if (field.options?.packed === false && isProto3) parts.push('packed = false')
  if (field.options?.deprecated) parts.push('deprecated = true')
  return parts.length > 0 ? ` [${parts.join(', ')}]` : ''
}

/**
 * Map fields are sugar over a repeated synthetic entry message. Detect them so
 * the output reads `map<string, Foo>` instead of leaking the generated
 * `FooEntry` type that protoc invented.
 */
function mapEntryFor(
  field: FieldProto,
  parent: MessageProto
): { key: string; value: string } | null {
  if (fieldLabel(field) !== LABEL_REPEATED || fieldType(field) !== TYPE_MESSAGE) return null
  const entryName = typeRef(field.typeName).split('.').pop()
  const nested = parent.nestedType?.find((n) => n.name === entryName)
  if (!nested?.options?.mapEntry) return null

  const key = nested.field?.find((f) => f.number === 1)
  const value = nested.field?.find((f) => f.number === 2)
  if (!key || !value) return null
  return { key: fieldTypeName(key), value: fieldTypeName(value) }
}

function renderEnum(node: EnumProto, depth: number): string[] {
  const lines: string[] = [`${indent(depth)}enum ${node.name} {`]
  if (node.options?.allowAlias) lines.push(`${indent(depth + 1)}option allow_alias = true;`)
  for (const value of node.value ?? []) {
    const deprecated = value.options?.deprecated ? ' [deprecated = true]' : ''
    lines.push(`${indent(depth + 1)}${value.name} = ${value.number ?? 0}${deprecated};`)
  }
  lines.push(`${indent(depth)}}`)
  return lines
}

function renderMessage(node: MessageProto, depth: number, isProto3: boolean): string[] {
  const lines: string[] = [`${indent(depth)}message ${node.name} {`]
  const inner = depth + 1

  if (node.options?.deprecated) lines.push(`${indent(inner)}option deprecated = true;`)

  for (const range of node.reservedRange ?? []) {
    const start = range.start ?? 0
    const end = (range.end ?? start + 1) - 1
    lines.push(`${indent(inner)}reserved ${start === end ? start : `${start} to ${end}`};`)
  }
  if (node.reservedName?.length) {
    lines.push(`${indent(inner)}reserved ${node.reservedName.map(quote).join(', ')};`)
  }

  // Nested types that are not synthetic map entries.
  const mapEntryNames = new Set(
    (node.field ?? [])
      .map((f) => (mapEntryFor(f, node) ? typeRef(f.typeName).split('.').pop() : undefined))
      .filter((n): n is string => !!n)
  )
  for (const nested of node.nestedType ?? []) {
    if (nested.name && mapEntryNames.has(nested.name)) continue
    lines.push(...renderMessage(nested, inner, isProto3))
  }
  for (const enumNode of node.enumType ?? []) {
    lines.push(...renderEnum(enumNode, inner))
  }

  // Group fields by oneof so the declarations round-trip.
  const oneofs = node.oneofDecl ?? []
  const plainFields = (node.field ?? []).filter(
    (f) => f.oneofIndex === undefined || f.proto3Optional === true
  )
  for (const field of plainFields) {
    lines.push(...renderField(field, node, inner, isProto3))
  }

  oneofs.forEach((oneof, index) => {
    const members = (node.field ?? []).filter(
      (f) => f.oneofIndex === index && f.proto3Optional !== true
    )
    // A proto3 `optional` field is modelled as a synthetic single-member oneof;
    // emitting it as a real oneof would be wrong.
    if (members.length === 0) return
    lines.push(`${indent(inner)}oneof ${oneof.name} {`)
    for (const field of members) {
      const type = fieldTypeName(field)
      lines.push(
        `${indent(inner + 1)}${type} ${field.name} = ${field.number}${fieldOptions(field, isProto3)};`
      )
    }
    lines.push(`${indent(inner)}}`)
  })

  lines.push(`${indent(depth)}}`)
  return lines
}

function renderField(
  field: FieldProto,
  parent: MessageProto,
  depth: number,
  isProto3: boolean
): string[] {
  const map = mapEntryFor(field, parent)
  if (map) {
    return [
      `${indent(depth)}map<${map.key}, ${map.value}> ${field.name} = ${field.number}${fieldOptions(field, isProto3)};`
    ]
  }

  const rawLabel = fieldLabel(field)
  let label = ''
  if (rawLabel === LABEL_REPEATED) label = 'repeated '
  else if (rawLabel === LABEL_REQUIRED) label = 'required '
  else if (rawLabel === LABEL_OPTIONAL) {
    // proto3 only writes `optional` for explicit-presence fields.
    label = isProto3 ? (field.proto3Optional ? 'optional ' : '') : 'optional '
  }

  return [
    `${indent(depth)}${label}${fieldTypeName(field)} ${field.name} = ${field.number}${fieldOptions(field, isProto3)};`
  ]
}

function renderService(node: ServiceProto): string[] {
  const lines: string[] = [`service ${node.name} {`]
  for (const method of node.method ?? []) {
    const input = `${method.clientStreaming ? 'stream ' : ''}${typeRef(method.inputType)}`
    const output = `${method.serverStreaming ? 'stream ' : ''}${typeRef(method.outputType)}`
    lines.push(`  rpc ${method.name}(${input}) returns (${output});`)
  }
  lines.push('}')
  return lines
}

/** Serializes a decoded FileDescriptorProto into `.proto` source text. */
export function descriptorToProto(file: FileProto): string {
  const syntax = file.syntax === 'proto3' ? 'proto3' : 'proto2'
  const isProto3 = syntax === 'proto3'
  const lines: string[] = [
    '// Recovered by Klarity from a compiled Java class.',
    '// Generated from the descriptor protoc embedded at build time.',
    '',
    `syntax = ${quote(syntax)};`,
    ''
  ]

  if (file.package) lines.push(`package ${file.package};`, '')

  const deps = file.dependency ?? []
  if (deps.length > 0) {
    for (const dep of deps) lines.push(`import ${quote(dep)};`)
    lines.push('')
  }

  const options = file.options ?? {}
  const optionLines: string[] = []
  for (const [key, protoName] of FILE_OPTION_KEYS) {
    const value = options[key]
    if (value === undefined || value === null) continue
    optionLines.push(
      `option ${protoName} = ${typeof value === 'string' ? quote(value) : String(value)};`
    )
  }
  if (optionLines.length > 0) lines.push(...optionLines, '')

  for (const message of file.messageType ?? []) {
    lines.push(...renderMessage(message, 0, isProto3), '')
  }
  for (const enumNode of file.enumType ?? []) {
    lines.push(...renderEnum(enumNode, 0), '')
  }
  for (const service of file.service ?? []) {
    lines.push(...renderService(service), '')
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}
