import { basename, dirname, join } from 'node:path'
import { app, dialog } from 'electron'
import type { InvokeHandlers } from '@shared/ipc'
import type { DecodeTestResult } from '@shared/serde'
import { peekOne } from '../kafka/scanner'
import { adminFor } from '../kafka/connectionPool'
import { compare } from '../kafka/offsets'
import { getTopicSerde, setTopicSerde } from '../store/serdeStore'
import {
  getFbsSchema,
  getProtoSource,
  listFbsSchemas,
  listProtoSources,
  removeFbsSchema,
  removeProtoSource
} from '../store/schemaStore'
import { invalidateProtoCache, loadProtoSource } from '../serde/protobuf'
import { flatcStatus, loadFbsSchema } from '../serde/flatbuffers'
import { importProtosFromJars } from '../serde/jarImport'
import { KlarityError, invalid } from '../util/errors'

/** Keeps a user-supplied name safe to use as a directory segment. */
function sanitize(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'jars'
}

export const serdeHandlers: Pick<
  InvokeHandlers,
  | 'serde:getTopicConfig'
  | 'serde:setTopicConfig'
  | 'serde:addProtoSource'
  | 'serde:listProtoSources'
  | 'serde:reloadProtoSource'
  | 'serde:removeProtoSource'
  | 'serde:listProtoTypes'
  | 'serde:importJars'
  | 'serde:addFbsSchema'
  | 'serde:listFbsSchemas'
  | 'serde:removeFbsSchema'
  | 'serde:testDecode'
  | 'serde:flatcStatus'
> = {
  'serde:getTopicConfig': (clusterId, topic) => getTopicSerde(clusterId, topic),
  'serde:setTopicConfig': (clusterId, topic, cfg) => setTopicSerde(clusterId, topic, cfg),

  // --- protobuf ----------------------------------------------------------
  'serde:addProtoSource': async (name, dir) => {
    let directory = dir
    if (!directory) {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Choose a directory of .proto files',
        properties: ['openDirectory']
      })
      if (canceled || filePaths.length === 0) throw invalid('No directory was chosen.')
      directory = filePaths[0]
    }
    return loadProtoSource(name.trim() || basename(directory), directory)
  },

  'serde:listProtoSources': () => listProtoSources(),

  'serde:reloadProtoSource': (id) => {
    const source = getProtoSource(id)
    if (!source) throw invalid('That .proto source no longer exists.')
    // Drop the parsed root so edits on disk are picked up.
    invalidateProtoCache(id)
    return loadProtoSource(source.name, source.dir, source.id)
  },

  'serde:removeProtoSource': (id) => {
    invalidateProtoCache(id)
    removeProtoSource(id)
  },

  'serde:listProtoTypes': (sourceId) => getProtoSource(sourceId)?.types ?? [],

  /**
   * Recovers schemas from jars of compiled protobuf classes. The extracted
   * `.proto` files are written under userData and then registered through the
   * ordinary source path, so decoding, type lookup and the serde dialog all
   * work exactly as they do for a hand-picked directory.
   */
  'serde:importJars': async (name, jarPaths, outDir) => {
    let jars = jarPaths
    if (!jars || jars.length === 0) {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Choose jar files containing compiled protobuf classes',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Java archive', extensions: ['jar', 'zip'] }]
      })
      if (canceled || filePaths.length === 0) throw invalid('No jar files were chosen.')
      jars = filePaths
    }

    const label = name.trim() || basename(jars[0], '.jar')

    // The recovered schemas are ordinary files the user will want to keep,
    // diff and reuse, so they go to a folder of the user's choosing rather
    // than somewhere inside app state. userData only supplies the default.
    let destination = outDir
    if (!destination) {
      const suggested = join(app.getPath('userData'), 'proto-from-jars', sanitize(label))
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Choose a folder to save the recovered .proto files',
        defaultPath: suggested,
        buttonLabel: 'Save schemas here',
        properties: ['openDirectory', 'createDirectory']
      })
      if (canceled || filePaths.length === 0) throw invalid('No destination folder was chosen.')
      destination = filePaths[0]
    }

    const result = importProtosFromJars(jars, destination)

    if (result.files.length === 0) {
      throw new KlarityError(
        'SCHEMA_LOAD_FAILED',
        'No protobuf schemas were found in those jars.',
        `Scanned ${result.classesScanned} classes. The jar may not contain protoc-generated classes.`
      )
    }

    // Reuse an existing source pointing at the same directory rather than
    // stacking duplicates on every re-import.
    const existing = listProtoSources().find((s) => s.dir === destination)
    invalidateProtoCache(existing?.id)
    loadProtoSource(label, destination, existing?.id)
    return result
  },

  // --- flatbuffers -------------------------------------------------------
  'serde:addFbsSchema': async (name, path) => {
    let file = path
    if (!file) {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Choose a .fbs schema',
        properties: ['openFile'],
        filters: [{ name: 'FlatBuffers schema', extensions: ['fbs'] }]
      })
      if (canceled || filePaths.length === 0) throw invalid('No schema file was chosen.')
      file = filePaths[0]
    }
    return loadFbsSchema(name.trim() || basename(file), file)
  },

  'serde:listFbsSchemas': () => listFbsSchemas(),
  'serde:removeFbsSchema': (id) => removeFbsSchema(id),
  'serde:flatcStatus': () => flatcStatus(),

  // --- try it ------------------------------------------------------------
  /** Decodes the newest available record with a candidate config. */
  'serde:testDecode': async (clusterId, topic, cfg): Promise<DecodeTestResult> => {
    const admin = adminFor(clusterId)
    const offsets = await admin.fetchTopicOffsets(topic)
    const target = offsets.find((o) => compare(o.low, o.high) < 0)
    if (!target) {
      return { ok: false, preview: '', format: 'none', error: 'The topic is empty.' }
    }

    // Config is passed in rather than read from the store, so the dialog can
    // try a candidate before the user commits to it.
    const message = await peekOne({ clusterId, topic, partition: target.partition }, cfg)
    if (!message) {
      return { ok: false, preview: '', format: 'none', error: 'No message could be read.' }
    }

    return {
      ok: !message.value.decodeError,
      preview: message.value.text,
      format: message.value.format,
      sampledFrom: { partition: message.partition, offset: message.offset },
      error: message.value.decodeError
    }
  }
}

/** Re-exported for the settings UI, which shows where a schema came from. */
export function describeSchemaLocation(id: string): string | undefined {
  const proto = getProtoSource(id)
  if (proto) return proto.dir
  const fbs = getFbsSchema(id)
  return fbs ? dirname(fbs.path) : undefined
}
