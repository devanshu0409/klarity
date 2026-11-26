import kafkajs from 'kafkajs'
import type {
  GroupDetail,
  GroupMember,
  GroupState,
  GroupSummary,
  LagRow,
  ResetOffsetsRequest,
  ResetPreviewRow,
  ResetStrategy
} from '@shared/models'
import { KlarityError, invalid } from '../util/errors'
import { adminFor, assertWritable } from './connectionPool'
import { add, clamp, isWithin, subtract, sum } from './offsets'
import { logger } from '../util/log'

// kafkajs is CommonJS; named exports Node's lexer misses (AssignerProtocol is
// one) only exist on the default export.
const { AssignerProtocol } = kafkajs

const log = logger('groups')

/** Kafka's sentinel for "this group has never committed here". */
const NO_OFFSET = '-1'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      const item = items[index]
      if (item !== undefined) results[index] = await fn(item)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Member assignments arrive as the raw bytes of the consumer protocol. Anything
 * that is not a kafkajs-style consumer (Connect, Streams internals, a client
 * using a custom assignor) puts other bytes there, so a decode failure is
 * normal and means "no assignment we can read", not an error.
 */
function decodeAssignment(raw: Buffer | null | undefined): GroupMember['assignments'] {
  if (!raw || raw.length === 0) return []
  try {
    const decoded = AssignerProtocol.MemberAssignment.decode(raw) as {
      assignment: Record<string, number[]>
    } | null
    if (!decoded?.assignment) return []
    return Object.entries(decoded.assignment).map(([topic, partitions]) => ({
      topic,
      partitions: [...partitions].sort((a, b) => a - b)
    }))
  } catch {
    return []
  }
}

interface RawMember {
  memberId: string
  clientId: string
  clientHost: string
  memberAssignment: Buffer
}

function toMember(raw: RawMember): GroupMember {
  return {
    memberId: raw.memberId,
    clientId: raw.clientId,
    clientHost: raw.clientHost,
    assignments: decodeAssignment(raw.memberAssignment)
  }
}

// ---------------------------------------------------------------------------
// List & describe
// ---------------------------------------------------------------------------

/** describeGroups takes a list; a big cluster's group list is chunked into it. */
const DESCRIBE_CHUNK = 50

/** Chunked describes run in parallel; more than this just queues on the coordinator. */
const DESCRIBE_CONCURRENCY = 4

/**
 * Above this many groups, describing all of them costs more than the states are
 * worth. Measured on a real cluster: 929 groups took 22s to describe and another
 * 7s to resolve idle-group topics, for a list nobody can use. Under the limit
 * the whole thing is a second or two, so small clusters keep the richer table.
 */
const ENRICH_LIMIT = 200

interface Enriched {
  summary: GroupSummary
  /** Topics taken from live member assignments — free, already in the response. */
  assigned: string[]
}

async function enrich(clusterId: string, groupIds: string[]): Promise<GroupSummary[]> {
  const admin = adminFor(clusterId)

  const chunks = chunk(groupIds, DESCRIBE_CHUNK)
  const described = await mapLimit(chunks, DESCRIBE_CONCURRENCY, (ids) =>
    admin.describeGroups(ids).then((r) => r.groups)
  )

  const rows: Enriched[] = described.flat().map((group) => {
    const members = group.members.map(toMember)
    const assigned = new Set<string>()
    for (const member of members) for (const a of member.assignments) assigned.add(a.topic)
    return {
      summary: {
        groupId: group.groupId,
        state: group.state as GroupState,
        memberCount: members.length,
        topics: [...assigned].sort(),
        protocolType: group.protocolType || undefined
      },
      assigned: [...assigned]
    }
  })

  // Idle groups have no members and therefore no assignments; their topics only
  // exist as committed offsets, which is one more round trip each.
  const idle = rows.filter((r) => r.assigned.length === 0)
  await mapLimit(idle, 8, async (row) => {
    try {
      const committed = await admin.fetchOffsets({ groupId: row.summary.groupId })
      row.summary.topics = committed
        .filter((t) => t.partitions.some((p) => p.offset !== NO_OFFSET))
        .map((t) => t.topic)
        .sort()
    } catch (err) {
      // A group can be reaped between listing and fetching; the row still shows.
      log.warn(`Committed topics for group "${row.summary.groupId}" unavailable`, err)
    }
  })

  return rows.map((r) => r.summary)
}

/**
 * Every group on the cluster.
 *
 * State, member count and topics need a `describeGroups` round trip per 50
 * groups plus a `fetchOffsets` per idle group, so they are filled in only when
 * the list is small enough to afford it, or when a topic filter is set — that
 * filter cannot be answered without them. Otherwise rows come back as names
 * with `Unknown` state, and `groups:describe` fills the detail pane for the one
 * group the user opened. Same lesson as the topic list in PLAN.md §10a.
 */
export async function listGroups(clusterId: string, topic?: string): Promise<GroupSummary[]> {
  const admin = adminFor(clusterId)
  const { groups } = await admin.listGroups()
  const ids = groups.map((g) => g.groupId)

  if (topic === undefined && ids.length > ENRICH_LIMIT) {
    log.info(`${ids.length} groups: listing names only (over the ${ENRICH_LIMIT} enrich limit)`)
    return groups
      .map((g) => ({
        groupId: g.groupId,
        state: 'Unknown' as GroupState,
        memberCount: 0,
        topics: [],
        protocolType: g.protocolType || undefined
      }))
      .sort((a, b) => a.groupId.localeCompare(b.groupId))
  }

  const summaries = await enrich(clusterId, ids)
  const visible = topic ? summaries.filter((s) => s.topics.includes(topic)) : summaries
  return visible.sort((a, b) => a.groupId.localeCompare(b.groupId))
}

export async function describeGroup(clusterId: string, groupId: string): Promise<GroupDetail> {
  const admin = adminFor(clusterId)
  const { groups } = await admin.describeGroups([groupId])
  const group = groups[0]
  if (!group) {
    throw new KlarityError('UNKNOWN', `Consumer group "${groupId}" was not found.`)
  }

  return {
    groupId: group.groupId,
    state: group.state as GroupState,
    protocol: group.protocol || undefined,
    protocolType: group.protocolType || undefined,
    members: group.members.map(toMember).sort((a, b) => a.memberId.localeCompare(b.memberId))
  }
}

// ---------------------------------------------------------------------------
// Lag
// ---------------------------------------------------------------------------

/** One lag sample: committed vs end offset per partition, plus who owns it. */
export async function fetchLag(
  clusterId: string,
  groupId: string,
  topic: string
): Promise<{ rows: LagRow[]; totalLag: string }> {
  const admin = adminFor(clusterId)

  const [committedTopics, bounds, described] = await Promise.all([
    admin.fetchOffsets({ groupId, topics: [topic] }),
    admin.fetchTopicOffsets(topic),
    // Ownership is a nicety; a group that rebalances mid-poll must not break
    // the numbers people are actually watching.
    admin.describeGroups([groupId]).catch(() => ({ groups: [] }))
  ])

  const committed = new Map(
    committedTopics.find((t) => t.topic === topic)?.partitions.map((p) => [p.partition, p.offset]) ??
      []
  )

  const owner = new Map<number, { memberId: string; clientId: string }>()
  for (const raw of described.groups[0]?.members ?? []) {
    const member = toMember(raw)
    for (const assignment of member.assignments) {
      if (assignment.topic !== topic) continue
      for (const partition of assignment.partitions) {
        owner.set(partition, { memberId: member.memberId, clientId: member.clientId })
      }
    }
  }

  const rows: LagRow[] = bounds
    .map((b) => {
      const raw = committed.get(b.partition)
      const hasCommit = raw !== undefined && raw !== NO_OFFSET
      return {
        partition: b.partition,
        committed: hasCommit ? raw : null,
        endOffset: b.high,
        // Without a commit the group would start at the beginning of the
        // partition, so everything still retained counts as lag.
        lag: hasCommit ? subtract(b.high, raw) : subtract(b.high, b.low),
        ...owner.get(b.partition)
      }
    })
    .sort((a, b) => a.partition - b.partition)

  return { rows, totalLag: sum(rows.map((r) => r.lag)) }
}

// ---------------------------------------------------------------------------
// Offset reset
// ---------------------------------------------------------------------------

export interface PartitionContext {
  partition: number
  earliest: string
  latest: string
  /** Committed offset, or null when the group never committed here. */
  current: string | null
  /** Offset returned by offsetsForTimes, only for the to-datetime strategy. */
  atTimestamp?: string
}

/**
 * Where one partition would land under a strategy. Pure, so the reset rules are
 * testable without a broker; `resetPreview` supplies the live numbers.
 */
export function nextOffset(strategy: ResetStrategy, ctx: PartitionContext): string {
  switch (strategy.kind) {
    case 'earliest':
      return ctx.earliest
    case 'latest':
      return ctx.latest
    case 'to-datetime':
      // kafkajs reports -1 when no record sits at or after the timestamp, which
      // means everything is older than it — the end of the partition.
      return ctx.atTimestamp === undefined || ctx.atTimestamp === NO_OFFSET
        ? ctx.latest
        : ctx.atTimestamp
    case 'shift-by':
      // A group with no commit has nowhere to shift from; the retained start is
      // the only defensible base.
      return add(ctx.current ?? ctx.earliest, strategy.delta)
    case 'explicit':
      return strategy.offsets[ctx.partition] ?? ctx.current ?? ctx.earliest
  }
}

/**
 * What a reset would set, per partition. The same computation backs the apply
 * path, so the grid the user confirms is exactly what gets committed.
 */
export async function resetPreview(req: ResetOffsetsRequest): Promise<ResetPreviewRow[]> {
  const admin = adminFor(req.clusterId)
  const { strategy } = req

  const [bounds, committedTopics] = await Promise.all([
    admin.fetchTopicOffsets(req.topic),
    admin.fetchOffsets({ groupId: req.groupId, topics: [req.topic] })
  ])

  const committed = new Map(
    committedTopics
      .find((t) => t.topic === req.topic)
      ?.partitions.map((p) => [p.partition, p.offset]) ?? []
  )

  let atTimestamp: Map<number, string> | undefined
  if (strategy.kind === 'to-datetime') {
    const found = await admin.fetchTopicOffsetsByTimestamp(req.topic, strategy.timestampMs)
    atTimestamp = new Map(found.map((o) => [o.partition, o.offset]))
  }

  const wanted =
    strategy.kind === 'explicit'
      ? new Set(Object.keys(strategy.offsets).map(Number))
      : req.partitions
        ? new Set(req.partitions)
        : null

  return bounds
    .filter((b) => !wanted || wanted.has(b.partition))
    .map((b) => {
      const raw = committed.get(b.partition)
      const current = raw !== undefined && raw !== NO_OFFSET ? raw : null

      const next = nextOffset(strategy, {
        partition: b.partition,
        earliest: b.low,
        latest: b.high,
        current,
        atTimestamp: atTimestamp?.get(b.partition)
      })

      return {
        partition: b.partition,
        current,
        next,
        earliest: b.low,
        latest: b.high,
        outOfRange: !isWithin(next, b.low, b.high)
      }
    })
    .sort((a, b) => a.partition - b.partition)
}

export async function resetOffsets(req: ResetOffsetsRequest): Promise<void> {
  assertWritable(req.clusterId, 'Resetting consumer group offsets')

  // Kafka rejects offset commits for a group that has members, and its error is
  // opaque; check first so the user gets told what to do about it.
  const detail = await describeGroup(req.clusterId, req.groupId)
  if (detail.members.length > 0) {
    throw new KlarityError(
      'GROUP_NOT_EMPTY',
      `Consumer group "${req.groupId}" has ${detail.members.length} active member(s).`,
      'Stop the consumers first — Kafka only allows offset changes on an empty group.'
    )
  }

  const rows = await resetPreview(req)
  if (rows.length === 0) throw invalid('No partitions selected to reset.')

  const admin = adminFor(req.clusterId)
  // Measured ~11s on a 1865-topic cluster: kafkajs refreshes cluster metadata
  // before committing. The UI must stay in a busy state for the whole call.
  await admin.setOffsets({
    groupId: req.groupId,
    topic: req.topic,
    // Clamping mirrors kafka-consumer-groups: a shift past either end lands on
    // the end rather than failing the whole reset. The preview flagged it.
    partitions: rows.map((r) => ({
      partition: r.partition,
      offset: clamp(r.next, r.earliest, r.latest)
    }))
  })

  log.info(`Reset "${req.groupId}" on ${req.topic} (${rows.length} partitions)`)
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteGroup(clusterId: string, groupId: string): Promise<void> {
  assertWritable(clusterId, 'Deleting a consumer group')

  const detail = await describeGroup(clusterId, groupId)
  if (detail.members.length > 0) {
    throw new KlarityError(
      'GROUP_NOT_EMPTY',
      `Consumer group "${groupId}" still has ${detail.members.length} active member(s).`,
      'Kafka can only delete a group with no members. Stop the consumers first.'
    )
  }

  const admin = adminFor(clusterId)

  // kafkajs reports a rejected delete two different ways: an errorCode on the
  // row, or a thrown KafkaJSDeleteGroupsError whose message is just "Error in
  // DeleteGroups". Both become one message that says which group and why.
  const results = await admin.deleteGroups([groupId]).catch((err: unknown) => {
    throw new KlarityError(
      'UNKNOWN',
      `Kafka refused to delete "${groupId}".`,
      'The group is usually still active, or the broker denied the operation. ' +
        (err instanceof Error ? err.message : String(err))
    )
  })

  const failed = results.find((r) => r.groupId === groupId && r.errorCode)
  if (failed) {
    throw new KlarityError(
      'UNKNOWN',
      `Kafka refused to delete "${groupId}".`,
      `Broker error code ${failed.errorCode}.`
    )
  }
}
