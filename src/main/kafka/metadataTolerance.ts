import { createRequire } from 'node:module'
import { logger } from '../util/log'

const log = logger('metadata')
const require = createRequire(import.meta.url)

/**
 * Metadata response versions kafkajs implements (`protocol/requests/metadata`).
 * Each version module exports its own `parse` reference — v1-v6 capture v0's
 * function at import time — so every one has to be patched individually.
 */
const METADATA_VERSIONS = [0, 1, 2, 3, 4, 5, 6]

interface MetadataResponseModule {
  parse: (data: unknown) => Promise<unknown>
  __klarityTolerant?: boolean
}

/**
 * Makes kafkajs tolerate per-topic and per-partition metadata errors, the way
 * the Java client does.
 *
 * The problem: `describeCluster()`, `listTopics()` and `fetchTopicMetadata()`
 * all issue a Metadata request for *every* topic — kafkajs's encoder treats an
 * empty topics array as "all topics", and exposes no way to ask for fewer. Its
 * response parser then throws on the **first** topic or partition anywhere in
 * that response carrying a non-zero error code:
 *
 *     const topicsWithErrors = data.topicMetadata.filter(t => failure(t.topicErrorCode))
 *     if (topicsWithErrors.length > 0) throw createErrorFromCode(...)
 *
 * So one partition mid-leadership-election — routine background noise on a
 * cluster with thousands of them — fails the entire call, including the broker
 * list the caller actually wanted. On `p04` this made the app unusable: 60s of
 * continuous retrying never found a moment when every partition was clean.
 *
 * Java's `AdminClient` does not work this way. `MetadataResponse` carries the
 * error code per topic as data, and callers decide what to do about the topics
 * they care about — which is why Offset Explorer connects to the same cluster
 * and lists the same topics without complaint.
 *
 * This replaces each version's `parse` with one that passes the decoded data
 * through untouched. The error codes are still in the data (`topicErrorCode`,
 * `partitionErrorCode`, and `leader: -1` on a partition with no leader), so
 * nothing is hidden — it simply stops one sick topic from denying knowledge of
 * the other nine hundred.
 *
 * Monkey-patching a dependency is not free, so it is deliberately narrow: one
 * function, one protocol, verified at startup. If kafkajs moves these modules,
 * `patchCount` is 0 and this throws at boot rather than silently reverting to
 * a client that cannot connect to half the estate.
 */
export function tolerateTopicMetadataErrors(): void {
  let patched = 0

  for (const version of METADATA_VERSIONS) {
    let mod: MetadataResponseModule
    try {
      mod = require(`kafkajs/src/protocol/requests/metadata/v${version}/response`)
    } catch (err) {
      log.warn(`Metadata response v${version} could not be loaded`, err)
      continue
    }

    if (typeof mod?.parse !== 'function') continue
    if (mod.__klarityTolerant) {
      patched += 1
      continue
    }

    mod.parse = async (data: unknown) => data
    mod.__klarityTolerant = true
    patched += 1
  }

  if (patched === 0) {
    throw new Error(
      'Could not make kafkajs tolerate per-topic metadata errors: its metadata response ' +
        'modules were not found. Check kafkajs internals after an upgrade — without this, ' +
        'clusters with a partition mid-election cannot be connected to at all.'
    )
  }

  log.info(`Metadata parsing tolerates per-topic errors (${patched} response versions)`)
}
