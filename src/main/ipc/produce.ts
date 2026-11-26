import { dialog } from 'electron'
import type { InvokeHandlers } from '@shared/ipc'
import { produceFromFile, produceSingle } from '../kafka/producer'
import { invalid } from '../util/errors'

export const produceHandlers: Pick<InvokeHandlers, 'produce:single' | 'produce:fromFile'> = {
  'produce:single': (req) => produceSingle(req),

  /** An empty `filePath` opens the picker, matching the serde channels. */
  'produce:fromFile': async (req) => {
    let filePath = req.filePath
    if (!filePath) {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Send file as ' + req.target,
        properties: ['openFile']
      })
      if (canceled || !filePaths[0]) throw invalid('No file was chosen.')
      filePath = filePaths[0]
    }
    return produceFromFile({ ...req, filePath })
  }
}
