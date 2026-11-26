import type { InvokeHandlers } from '@shared/ipc'
import { describeBrokerConfigs, listBrokers } from '../kafka/admin'

export const brokerHandlers: Pick<
  InvokeHandlers,
  'brokers:list' | 'brokers:describeConfigs'
> = {
  'brokers:list': (clusterId) => listBrokers(clusterId),
  'brokers:describeConfigs': (clusterId, brokerId) =>
    describeBrokerConfigs(clusterId, brokerId)
}
