import type { InvokeHandlers } from '@shared/ipc'
import { deleteTabGroup, listTabGroups, saveTabGroup } from '../store/tabGroups'

export const tabGroupHandlers: Pick<
  InvokeHandlers,
  'tabGroups:list' | 'tabGroups:save' | 'tabGroups:delete'
> = {
  'tabGroups:list': (clusterId) => listTabGroups(clusterId),
  'tabGroups:save': (input) => saveTabGroup(input),
  'tabGroups:delete': (id) => deleteTabGroup(id)
}
