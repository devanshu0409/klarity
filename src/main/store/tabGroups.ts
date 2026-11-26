import { randomUUID } from 'node:crypto'
import type { TabGroup, TabGroupInput } from '@shared/models'
import { invalid } from '../util/errors'
import { logger } from '../util/log'
import { JsonFile } from './jsonFile'

const log = logger('tabGroups')

interface TabGroupsFile {
  version: 1
  groups: TabGroup[]
}

let file: JsonFile<TabGroupsFile> | null = null

function store(): JsonFile<TabGroupsFile> {
  if (!file) file = new JsonFile<TabGroupsFile>('tabGroups.json', { version: 1, groups: [] })
  return file
}

export function listTabGroups(clusterId: string): TabGroup[] {
  return store()
    .get()
    .groups.filter((g) => g.clusterId === clusterId)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function saveTabGroup(input: TabGroupInput): TabGroup {
  if (!input.name.trim()) throw invalid('Give the group a name.')
  if (input.topics.length === 0) throw invalid('A group needs at least one topic.')

  const now = Date.now()
  const existing = input.id
    ? store()
        .get()
        .groups.find((g) => g.id === input.id)
    : undefined

  const saved: TabGroup = {
    id: existing?.id ?? input.id ?? randomUUID(),
    clusterId: input.clusterId,
    name: input.name.trim(),
    // De-duplicate while keeping first-seen order, so re-adding an already
    // open topic to a group is a no-op rather than a second tab.
    topics: [...new Set(input.topics)],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }

  store().update((draft) => {
    const index = draft.groups.findIndex((g) => g.id === saved.id)
    if (index === -1) draft.groups.push(saved)
    else draft.groups[index] = saved
  })

  log.info(`Saved tab group "${saved.name}" (${saved.topics.length} topics)`)
  return saved
}

export function deleteTabGroup(id: string): void {
  store().update((draft) => {
    draft.groups = draft.groups.filter((g) => g.id !== id)
  })
  log.info(`Deleted tab group ${id}`)
}
