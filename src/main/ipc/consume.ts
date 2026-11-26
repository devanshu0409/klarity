import type { InvokeHandlers } from '@shared/ipc'
import { cancelJob, startJob } from '../kafka/jobs'
import { peekOne, runSearch, runTail } from '../kafka/scanner'
import { getTopicSerde } from '../store/serdeStore'
import { invalid } from '../util/errors'

export const consumeHandlers: Pick<
  InvokeHandlers,
  'consume:search' | 'consume:peek' | 'consume:tail:start' | 'job:cancel'
> = {
  'consume:search': (req) => {
    if (!req.topic.trim()) throw invalid('Choose a topic to search.')
    if (req.maxResults < 1) throw invalid('Max results must be at least 1.')

    const serde = getTopicSerde(req.clusterId, req.topic)
    const jobId = startJob('scanning', (ctx) => runSearch(ctx, req, serde))
    return { jobId }
  },

  'consume:peek': (req) => peekOne(req, getTopicSerde(req.clusterId, req.topic)),

  'consume:tail:start': (req) => {
    if (!req.topic.trim()) throw invalid('Choose a topic to tail.')
    const serde = getTopicSerde(req.clusterId, req.topic)
    const jobId = startJob('tailing', (ctx) => runTail(ctx, req, serde))
    return { jobId }
  },

  'job:cancel': (jobId) => cancelJob(jobId)
}
