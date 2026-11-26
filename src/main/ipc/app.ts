import { app } from 'electron'
import type { InvokeHandlers } from '@shared/ipc'
import { getSettings, setSettings } from '../store/settings'
import { invalidateFlatcStatus } from '../serde/flatbuffers'
import { checkForUpdates, downloadUpdate, quitAndInstall } from '../updater'

export const appHandlers: Pick<
  InvokeHandlers,
  'settings:get' | 'settings:set' | 'app:version' | 'update:check' | 'update:download' | 'update:install'
> = {
  'settings:get': () => getSettings(),
  'settings:set': (patch) => {
    // The flatc probe is cached; a new path must be re-tested.
    if ('flatcPath' in patch) invalidateFlatcStatus()
    return setSettings(patch)
  },
  'app:version': () => app.getVersion(),
  'update:check': () => checkForUpdates(),
  'update:download': () => downloadUpdate(),
  'update:install': () => quitAndInstall()
}
