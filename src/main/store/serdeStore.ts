import type { SerdeConfig } from '@shared/serde'
import { DEFAULT_SERDE } from '@shared/serde'
import { JsonFile } from './jsonFile'

interface SerdeFile {
  version: 1
  /** Keyed by `clusterId::topic` so the same topic name can differ per cluster. */
  topics: Record<string, SerdeConfig>
}

let file: JsonFile<SerdeFile> | null = null

function store(): JsonFile<SerdeFile> {
  if (!file) file = new JsonFile<SerdeFile>('serde.json', { version: 1, topics: {} })
  return file
}

const key = (clusterId: string, topic: string): string => `${clusterId}::${topic}`

export function getTopicSerde(clusterId: string, topic: string): SerdeConfig {
  return store().get().topics[key(clusterId, topic)] ?? DEFAULT_SERDE
}

export function setTopicSerde(clusterId: string, topic: string, config: SerdeConfig): void {
  store().update((draft) => {
    draft.topics[key(clusterId, topic)] = config
  })
}
