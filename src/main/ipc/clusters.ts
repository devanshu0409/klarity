import type { InvokeHandlers } from '@shared/ipc'
import { cloneProfile, deleteProfile, listProfiles, saveProfile } from '../store/profiles'
import {
  connect,
  disconnect,
  healthFor,
  invalidate,
  testProfile,
  warmTopicMetadata
} from '../kafka/connectionPool'
import { invalidateRegistry } from '../serde/avro'
import { logger } from '../util/log'
import { emit } from './index'

const log = logger('clusters')

export const clusterHandlers: Pick<
  InvokeHandlers,
  | 'clusters:list'
  | 'clusters:save'
  | 'clusters:delete'
  | 'clusters:clone'
  | 'clusters:test'
  | 'clusters:connect'
  | 'clusters:disconnect'
  | 'clusters:health'
> = {
  'clusters:list': () => listProfiles(),

  'clusters:save': async (input) => {
    const saved = saveProfile(input)
    // Credentials or brokers may have changed under an open connection; drop it
    // so the next call reconnects with the new settings. The registry client
    // caches its own auth, so it goes too.
    await invalidate(saved.id)
    invalidateRegistry(saved.id)
    return saved
  },

  'clusters:delete': async (id) => {
    await invalidate(id)
    invalidateRegistry(id)
    deleteProfile(id)
  },

  'clusters:clone': (id) => cloneProfile(id),

  'clusters:test': (input) => testProfile(input),

  'clusters:connect': async (id) => {
    const health = await connect(id)
    emit('cluster:status', health)

    // Pull the topic metadata in the background: the topic list wants it within
    // seconds and it is the slowest call on a large cluster, so paying for it
    // before the user asks — without holding up "connected" — is the whole
    // difference between a snappy app and a ten-second stare.
    void warmTopicMetadata(id)
      .then(() => emit('cluster:status', healthFor(id)))
      .catch((err: unknown) => log.warn(`Topic metadata for ${id} could not be prefetched`, err))

    return health
  },

  'clusters:disconnect': async (id) => {
    await disconnect(id)
    emit('cluster:status', healthFor(id))
  },

  'clusters:health': (id) => healthFor(id)
}
