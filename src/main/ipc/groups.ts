import type { InvokeHandlers } from '@shared/ipc'
import { emit } from '../ipc'
import { startJob, type JobContext } from '../kafka/jobs'
import {
  deleteGroup,
  describeGroup,
  fetchLag,
  listGroups,
  resetOffsets,
  resetPreview
} from '../kafka/groups'
import { invalid, requireConfirm } from '../util/errors'
import { logger } from '../util/log'

const log = logger('groups')

/** Matches the lag refresh cadence promised in PLAN.md §8 Phase 4. */
const POLL_MS = 2_000

/** A blip on one poll should not kill a monitor someone is watching. */
const MAX_CONSECUTIVE_FAILURES = 3

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Live lag monitor. Unlike a scan this never completes on its own — it polls
 * until cancelled, so the "scanned" count it reports is the number of samples.
 */
async function runLagJob(
  ctx: JobContext,
  clusterId: string,
  groupId: string,
  topic: string
): Promise<{ scanned: number; matched: number; partitionOffsets: Record<number, string> }> {
  let polls = 0
  let failures = 0
  let partitionOffsets: Record<number, string> = {}

  while (ctx.isRunning()) {
    try {
      const { rows, totalLag } = await fetchLag(clusterId, groupId, topic)
      if (!ctx.isRunning()) break

      failures = 0
      polls += 1
      partitionOffsets = Object.fromEntries(rows.map((r) => [r.partition, r.endOffset]))
      emit('lag:update', { jobId: ctx.id, groupId, topic, rows, totalLag, ts: Date.now() })
    } catch (err) {
      failures += 1
      log.warn(`Lag poll ${failures}/${MAX_CONSECUTIVE_FAILURES} for "${groupId}" failed`, err)
      if (failures >= MAX_CONSECUTIVE_FAILURES) throw err
    }

    // Cancellation is checked at the top of the loop, so a cancel during the
    // sleep costs at most one interval before the job winds down.
    await sleep(POLL_MS)
  }

  return { scanned: polls, matched: polls, partitionOffsets }
}

export const groupHandlers: Pick<
  InvokeHandlers,
  | 'groups:list'
  | 'groups:describe'
  | 'groups:lag:start'
  | 'groups:resetPreview'
  | 'groups:resetOffsets'
  | 'groups:delete'
> = {
  'groups:list': (clusterId, topic) => listGroups(clusterId, topic),

  'groups:describe': (clusterId, groupId) => describeGroup(clusterId, groupId),

  'groups:lag:start': (clusterId, groupId, topic) => {
    if (!topic.trim()) throw invalid('Choose a topic to monitor lag for.')
    const jobId = startJob('polling', (ctx) => runLagJob(ctx, clusterId, groupId, topic))
    return { jobId }
  },

  'groups:resetPreview': (req) => resetPreview(req),

  'groups:resetOffsets': async (req, confirmToken) => {
    requireConfirm(req.groupId, confirmToken, 'Resetting offsets')
    await resetOffsets(req)
  },

  'groups:delete': async (clusterId, groupId, confirmToken) => {
    requireConfirm(groupId, confirmToken, 'Deleting a consumer group')
    await deleteGroup(clusterId, groupId)
  }
}
