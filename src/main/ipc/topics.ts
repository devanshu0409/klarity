import type { InvokeHandlers } from '@shared/ipc'
import {
  addPartitions,
  createTopic,
  deleteTopic,
  describeTopic,
  listTopics,
  updateTopicConfig
} from '../kafka/admin'
import { requireConfirm } from '../util/errors'

export const topicHandlers: Pick<
  InvokeHandlers,
  | 'topics:list'
  | 'topics:describe'
  | 'topics:create'
  | 'topics:updateConfig'
  | 'topics:addPartitions'
  | 'topics:delete'
> = {
  'topics:list': (clusterId, refresh) => listTopics(clusterId, refresh),
  'topics:describe': (clusterId, topic) => describeTopic(clusterId, topic),
  'topics:create': (clusterId, spec) => createTopic(clusterId, spec),
  'topics:updateConfig': (clusterId, topic, configs) =>
    updateTopicConfig(clusterId, topic, configs),

  'topics:addPartitions': async (clusterId, topic, newTotal, confirmToken) => {
    requireConfirm(topic, confirmToken, 'Adding partitions')
    await addPartitions(clusterId, topic, newTotal)
  },

  'topics:delete': async (clusterId, topic, confirmToken) => {
    requireConfirm(topic, confirmToken, 'Deleting a topic')
    await deleteTopic(clusterId, topic)
  }
}
