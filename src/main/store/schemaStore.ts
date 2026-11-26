import { randomUUID } from 'node:crypto'
import type { FbsSchemaInfo, ProtoSource } from '@shared/serde'
import { JsonFile } from './jsonFile'

interface SchemaFile {
  version: 1
  protoSources: ProtoSource[]
  fbsSchemas: FbsSchemaInfo[]
}

let file: JsonFile<SchemaFile> | null = null

function store(): JsonFile<SchemaFile> {
  if (!file) {
    file = new JsonFile<SchemaFile>('schemas.json', {
      version: 1,
      protoSources: [],
      fbsSchemas: []
    })
  }
  return file
}

// ---------------------------------------------------------------------------
// Protobuf sources
// ---------------------------------------------------------------------------

export function listProtoSources(): ProtoSource[] {
  return store().get().protoSources
}

export function getProtoSource(id: string): ProtoSource | undefined {
  return store().get().protoSources.find((s) => s.id === id)
}

export function upsertProtoSource(source: Omit<ProtoSource, 'id'> & { id?: string }): ProtoSource {
  const record: ProtoSource = { ...source, id: source.id ?? randomUUID() }
  store().update((draft) => {
    const index = draft.protoSources.findIndex((s) => s.id === record.id)
    if (index === -1) draft.protoSources.push(record)
    else draft.protoSources[index] = record
  })
  return record
}

export function removeProtoSource(id: string): void {
  store().update((draft) => {
    draft.protoSources = draft.protoSources.filter((s) => s.id !== id)
  })
}

// ---------------------------------------------------------------------------
// FlatBuffers schemas
// ---------------------------------------------------------------------------

export function listFbsSchemas(): FbsSchemaInfo[] {
  return store().get().fbsSchemas
}

export function getFbsSchema(id: string): FbsSchemaInfo | undefined {
  return store().get().fbsSchemas.find((s) => s.id === id)
}

export function upsertFbsSchema(schema: Omit<FbsSchemaInfo, 'id'> & { id?: string }): FbsSchemaInfo {
  const record: FbsSchemaInfo = { ...schema, id: schema.id ?? randomUUID() }
  store().update((draft) => {
    const index = draft.fbsSchemas.findIndex((s) => s.id === record.id)
    if (index === -1) draft.fbsSchemas.push(record)
    else draft.fbsSchemas[index] = record
  })
  return record
}

export function removeFbsSchema(id: string): void {
  store().update((draft) => {
    draft.fbsSchemas = draft.fbsSchemas.filter((s) => s.id !== id)
  })
}
