import { dialog } from 'electron'
import { writeFileSync } from 'node:fs'
import type { ExportRequest } from '@shared/models'
import type { InvokeHandlers } from '@shared/ipc'
import { peekOne } from '../kafka/scanner'
import { getTopicSerde } from '../store/serdeStore'
import { KlarityError } from '../util/errors'

/** RFC 4180: quote when the value contains a delimiter, quote, or newline. */
function csvCell(value: string | number | boolean | null): string {
  if (value === null) return ''
  const text = String(value)
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function toCsv(rows: ExportRequest['rows']): string {
  if (rows.length === 0) return ''
  // Union of keys across rows, not just the first: a row that gained a field
  // later would otherwise have it silently dropped.
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))]
  const lines = [columns.join(',')]
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(row[c] ?? null)).join(','))
  }
  return lines.join('\r\n')
}

export const exportHandlers: Pick<InvokeHandlers, 'export:rows' | 'export:messageFile'> = {
  'export:rows': async (req) => {
    const ext = req.format
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export',
      defaultPath: `${req.suggestedName}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    })
    if (canceled || !filePath) return null

    const body =
      req.format === 'json' ? JSON.stringify(req.rows, null, 2) : toCsv(req.rows)
    writeFileSync(filePath, body, 'utf8')
    return filePath
  },

  /**
   * Saves one record's key or value. `binary` writes the exact bytes off the
   * wire — that is the mode that round-trips through `produce:fromFile`, so it
   * must not go anywhere near the decoders.
   */
  'export:messageFile': async (req) => {
    const message = await peekOne(
      {
        clusterId: req.clusterId,
        topic: req.topic,
        partition: req.partition,
        offset: req.offset,
        includeRaw: true
      },
      getTopicSerde(req.clusterId, req.topic)
    )
    if (!message) {
      throw new KlarityError(
        'INVALID_INPUT',
        `No message at ${req.topic}[${req.partition}] offset ${req.offset}.`
      )
    }

    const field = req.target === 'key' ? message.key : message.value
    const isBinary = req.mode === 'binary'
    if (isBinary && !field.rawBase64) {
      throw new KlarityError(
        'INVALID_INPUT',
        `The ${req.target} of this message is empty.`,
        'There are no bytes to write.'
      )
    }

    const extension = isBinary ? 'bin' : field.format === 'json' ? 'json' : 'txt'
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: `Save message ${req.target}`,
      defaultPath: `${req.topic}-p${req.partition}-${req.offset}-${req.target}.${extension}`,
      filters: [{ name: isBinary ? 'Binary' : 'Text', extensions: [extension] }]
    })
    if (canceled || !filePath) return null

    if (isBinary) writeFileSync(filePath, Buffer.from(field.rawBase64 as string, 'base64'))
    else writeFileSync(filePath, field.text, 'utf8')

    return filePath
  }
}
