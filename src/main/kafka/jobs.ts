import { randomUUID } from 'node:crypto'
import type { JobDone, JobPhase, JobProgress } from '@shared/models'
import { MESSAGE_BATCH_SIZE, type DecodedMessage } from '@shared/models'
import { emit } from '../ipc'
import { toAppError } from '../util/errors'
import { logger } from '../util/log'

const log = logger('jobs')

export interface JobContext {
  readonly id: string
  /** False once the job has been cancelled; long loops must check it. */
  readonly isRunning: () => boolean
  progress: (update: Omit<JobProgress, 'jobId'>) => void
  /** Buffers messages and flushes in batches, so IPC is not hit per record. */
  push: (message: DecodedMessage) => void
  flush: () => void
}

interface ActiveJob {
  id: string
  cancelled: boolean
  cleanup?: () => Promise<void>
}

const jobs = new Map<string, ActiveJob>()

/**
 * Starts a cancellable background job. The handle is returned immediately;
 * everything else reaches the renderer through `job:*` events.
 *
 * `run` receives a context whose `push` batches messages — a scan that emitted
 * one IPC message per record would spend all its time in serialization.
 */
export function startJob(
  phase: JobPhase,
  run: (ctx: JobContext) => Promise<Omit<JobDone, 'jobId' | 'elapsedMs'>>,
  registerCleanup?: (cleanup: () => Promise<void>) => void
): string {
  const id = randomUUID()
  const job: ActiveJob = { id, cancelled: false }
  jobs.set(id, job)

  const started = Date.now()
  let buffer: DecodedMessage[] = []

  const flush = (): void => {
    if (buffer.length === 0) return
    emit('job:messages', { jobId: id, messages: buffer })
    buffer = []
  }

  const ctx: JobContext = {
    id,
    isRunning: () => !job.cancelled,
    progress: (update) => emit('job:progress', { jobId: id, ...update }),
    push: (message) => {
      buffer.push(message)
      if (buffer.length >= MESSAGE_BATCH_SIZE) flush()
    },
    flush
  }

  registerCleanup?.(async () => {
    job.cancelled = true
  })

  emit('job:progress', { jobId: id, phase, scanned: 0, matched: 0 })

  void (async () => {
    try {
      const summary = await run(ctx)
      flush()
      if (!job.cancelled) {
        emit('job:done', { jobId: id, elapsedMs: Date.now() - started, ...summary })
      } else {
        // A cancelled job still reports what it managed to collect, so the UI
        // can keep partial results instead of blanking the table.
        emit('job:done', {
          jobId: id,
          elapsedMs: Date.now() - started,
          ...summary,
          stoppedByGuard: true
        })
      }
    } catch (err) {
      flush()
      log.error(`Job ${id} failed`, err)
      emit('job:error', { jobId: id, error: toAppError(err) })
    } finally {
      const active = jobs.get(id)
      jobs.delete(id)
      await active?.cleanup?.().catch(() => undefined)
    }
  })()

  return id
}

/** Marks a job cancelled and runs its cleanup (disconnecting consumers). */
export function cancelJob(jobId: string): void {
  const job = jobs.get(jobId)
  if (!job) return
  job.cancelled = true
  void job.cleanup?.().catch((err: unknown) => log.warn(`Cleanup for ${jobId} failed`, err))
}

/** Registers the teardown for a running job (called by the scanner). */
export function setJobCleanup(jobId: string, cleanup: () => Promise<void>): void {
  const job = jobs.get(jobId)
  if (job) job.cleanup = cleanup
}

export function isCancelled(jobId: string): boolean {
  return jobs.get(jobId)?.cancelled ?? true
}

/** Cancels everything — used when a cluster disconnects or the window closes. */
export function cancelAllJobs(): void {
  for (const id of [...jobs.keys()]) cancelJob(id)
}
