import type { InvokeHandlers } from '@shared/ipc'
import { notImplemented } from '../util/errors'

// Phase 5.
export const loadtestHandlers: Pick<
  InvokeHandlers,
  | 'loadtest:start'
  | 'loadtest:listSaved'
  | 'loadtest:saveConfig'
  | 'loadtest:deleteSaved'
  | 'loadtest:verify:start'
> = {
  'loadtest:start': () => notImplemented('loadtest:start'),
  'loadtest:listSaved': () => notImplemented('loadtest:listSaved'),
  'loadtest:saveConfig': () => notImplemented('loadtest:saveConfig'),
  'loadtest:deleteSaved': () => notImplemented('loadtest:deleteSaved'),
  'loadtest:verify:start': () => notImplemented('loadtest:verify:start')
}
