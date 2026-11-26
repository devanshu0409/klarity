# Kafka GUI — Build Plan & Architecture

> Working name: **Klarity** (sibling of Lodestone — grep for `klarity`).
> Separate repo/app from Lodestone. Distinct visual identity. Light + dark mode required.
>
> This document is the single source of truth for the dev agent. Follow phases in order.
> Each phase has explicit tasks and acceptance criteria. Do not start a phase before the
> previous phase's acceptance criteria pass.

---

## 0. Status & next step — read this first

_Last updated: 2026-08-21._

### Done

| Phase | State | Notes |
|---|---|---|
| 0 — Scaffold | ✅ | Electron + React + Tailwind v4, full typed IPC contract, light/dark tokens, icons, CI |
| 1 — Clusters & topics | ✅ | Profiles (TLS/SASL/registry, OS-vault secrets, read-only enforced in main), topic list/detail/admin, brokers, CSV+JSON export |
| 2 — Message browsing | ✅ | Search / peek / live tail as cancellable jobs, multi-tab search, virtualized results, view-as Auto/JSON/Text/Hex, save-bytes |
| 3 — Schema decode | ✅ | Protobuf (+ recovery from jars of compiled classes), FlatBuffers via `flatc`, Avro/Schema Registry, per-topic serde dialog with "try it" |
| 4a — Consumer groups | ✅ | List/describe, live lag job + trend sparkline, offset reset (all five strategies, with preview), group delete. Verified against `p19-dev` |
| 4b — Produce | ✅ | `produce:single` + `produce:fromFile` (binary bytes untouched), serde encode for json/string/proto/proto-string/fbs/avro-sr, headers, explicit partition |

### Next: apply `DESIGN.md`, then Phase 5

Phase 4 is complete. **`DESIGN.md` is applied** — `styles/tokens.css` is derived from it (warm
cream canvas, ink-black primary actions, two-tier radius scale, weight-450 body), and every
component resolves color through those tokens, so it is no longer outstanding work. Next is
Phase 5 (load test + verify consumption). 5 IPC handlers are still `notImplemented` stubs, all
of them Phase 5 load-test channels.

Still unverified in the running app: the groups and produce screens have been exercised through
their engines (unit tests + scripted runs against `p19-dev`), but nobody has clicked through
them in Electron yet.

### After Phase 4

- Phase 5 (load test + verify consumption), then Phase 6 (polish, installers, e2e).

### Carried constraints

- **`flatc` is not bundled** — resolves bundled → user path in Settings → `PATH`. Bundling is
  a CI packaging step (the binary could not be downloaded on this network).
- **Avro / Schema Registry is untested** — no registry has been reachable.
- **Installers cannot be built locally** (see §10a); CI builds them on tags.
- **The groups list is name-only above 200 groups** (see §10a) — state and topics arrive when a
  group is selected, or when a topic filter forces the full scan.
- **Verify against the real cluster**, not just tests. `p19-dev` (6 brokers, ~1865 topics,
  Snappy) surfaced several bugs that green unit tests missed.

---

## 1. Product summary

Open-source desktop GUI for Apache Kafka. Electron app. Core promise:

1. **Browse and search messages** on any topic — including **Protobuf, FlatBuffers, and
   Avro** payloads decoded to readable JSON (the #1 differentiator; most Kafka GUIs punt
   on FlatBuffers entirely).
2. **Operate clusters safely**: topics, consumer groups, lag, offset resets — with
   type-to-confirm destructive ops and main-process-enforced read-only mode.
3. **Load-test**: templated message production with field mutation, then verify
   consumption by watching consumer-group offsets.

Inspiration: feature set of the internal Java "Kafka Pilot" app (search/peek/tail, push
engine with auto-increment/rotation/UUID mutators, verify-consumption, topic admin, live
lag monitor, offset reset) — rebuilt with modern UX and no JVM. Plus full feature parity
with **Offset Explorer** (ex-Kafka Tool): brokers view, add-partitions, manual offset
editing, group deletion, message save-to-file / produce-from-file, hex viewer.

Non-goals (v1): Kafka Connect management, KSQL, ACL management, cluster installation,
multi-user/server deployment, **Zookeeper browsing** (KRaft era; Offset Explorer has it,
we deliberately don't), Java-style decorator plugins (serde engine replaces them; a JS
plugin API is backlog).

---

## 2. Tech stack (fixed — do not substitute)

| Concern | Choice | Notes |
|---|---|---|
| Shell | Electron (latest stable) + electron-vite + electron-builder | Same toolchain as Lodestone — proven, reuse `electron-builder.yml` patterns for Win/mac installers + auto-update via electron-updater |
| Language | TypeScript everywhere, strict mode | |
| UI | React 19 + zustand + Radix primitives + lucide-react icons | |
| Styling | Tailwind CSS v4 + CSS custom-property design tokens | Tokens carry theming (see §7) |
| Editor | Monaco | JSON template editing, message viewing |
| Tables/lists | `react-virtuoso` | Every message list MUST be virtualized. Never render unbounded lists |
| Charts | `lightweight-charts` or `recharts` | Lag trend + throughput charts. Pick one, use everywhere |
| Kafka client | `kafkajs` | Pure JS, runs in **main process only**. If consume throughput proves insufficient in Phase 2 benchmarks (<20k msg/s scan), swap scan path to `node-rdkafka` behind the same interface |
| Protobuf | `protobufjs` | Runtime `.proto` loading, no codegen |
| FlatBuffers | bundled `flatc` binary (per-platform) | Decode via `flatc --json`; see §6 |
| Avro / Schema Registry | `@kafkajs/confluent-schema-registry` | Handles magic-byte wire format for Avro, Protobuf, JSON Schema |
| Secrets | Electron `safeStorage` | Passwords/SASL creds encrypted with OS keychain. Never plaintext on disk |
| Persistence | JSON files in `app.getPath('userData')` | Profiles, per-topic serde config, UI state. No database |
| Tests | Vitest (unit), Playwright (e2e smoke) | Kafka integration tests run against `testcontainers` Redpanda or docker-compose Kafka |

---

## 3. Repository layout

```
kafka-gui/
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ package.json
├─ tsconfig.json / tsconfig.node.json / tsconfig.web.json
├─ resources/                  # app icons, bundled flatc binaries per platform
│  └─ flatc/{win32-x64,darwin-x64,darwin-arm64,linux-x64}/
├─ src/
│  ├─ shared/                  # types shared main<->renderer. NO runtime deps
│  │  ├─ ipc.ts                # the full typed IPC contract (§5)
│  │  ├─ models.ts             # ClusterProfile, TopicInfo, DecodedMessage, ...
│  │  └─ serde.ts              # SerdeConfig types
│  ├─ main/
│  │  ├─ index.ts              # app lifecycle, window, single-instance lock
│  │  ├─ ipc/                  # one file per IPC domain, registers handlers
│  │  │  ├─ clusters.ts  brokers.ts  topics.ts  consume.ts  produce.ts
│  │  │  ├─ groups.ts  loadtest.ts  serde.ts  export.ts
│  │  ├─ kafka/
│  │  │  ├─ connectionPool.ts  # one Kafka instance per cluster profile, lazy, isolated
│  │  │  ├─ admin.ts           # topic/group admin wrappers
│  │  │  ├─ scanner.ts         # search/peek/tail engine (§6.1)
│  │  │  └─ producer.ts        # single-send + load-test engine
│  │  ├─ serde/
│  │  │  ├─ registry.ts        # serde resolution pipeline (§6.2)
│  │  │  ├─ json.ts  protobuf.ts  flatbuffers.ts  avro.ts  raw.ts
│  │  ├─ store/
│  │  │  ├─ profiles.ts        # cluster profiles + safeStorage secret handling
│  │  │  └─ settings.ts        # theme, serde mappings, window state
│  │  └─ util/log.ts
│  ├─ preload/index.ts         # contextBridge: exposes typed api from shared/ipc.ts
│  └─ renderer/src/
│     ├─ App.tsx  main.tsx
│     ├─ stores/               # zustand: connection, topics, messages, groups, loadtest, ui
│     ├─ components/
│     │  ├─ shell/             # sidebar, cluster switcher, statusbar, theme toggle
│     │  ├─ common/            # Button, DataTable(virtualized), ConfirmDialog(type-to-confirm),
│     │  │                     # JsonViewer, Toast, EmptyState
│     │  ├─ clusters/  topics/  messages/  groups/  produce/  loadtest/
│     ├─ styles/
│     │  ├─ tokens.css         # design tokens, light + dark (§7)
│     │  └─ globals.css
│     └─ lib/                  # formatters, ipc client wrapper, hooks
└─ tests/
```

---

## 4. Process architecture & security model

```
┌────────────────────────── renderer (sandboxed) ──────────────────────────┐
│  React UI. No Node access. contextIsolation: true, nodeIntegration off.  │
│  Talks ONLY through window.api.* (preload contextBridge).                │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ typed IPC (invoke + event streams)
┌──────────────────────────────────▼───────────────────────────────────────┐
│ main process                                                             │
│  ┌───────────────┐  ┌──────────────┐  ┌─────────────────────────────┐    │
│  │ connectionPool│  │ serde engine │  │ stores (profiles/settings)  │    │
│  │ 1 client per  │─▶│ decode/encode│  │ safeStorage for secrets     │    │
│  │ cluster, lazy │  │ (§6)         │  └─────────────────────────────┘    │
│  └───────┬───────┘  └──────────────┘                                     │
│          │ kafkajs (admin / consumer / producer)                         │
└──────────┼───────────────────────────────────────────────────────────────┘
           ▼
      Kafka clusters
```

Rules (enforce in code review):

- **All Kafka + fs + subprocess work in main.** Renderer never imports kafkajs, never
  touches fs. Payloads cross IPC already decoded and truncated (§6.3).
- **Connection isolation**: every cluster profile gets its own kafkajs instance. A
  request handler receives `clusterId` and resolves the client from the pool — a request
  physically cannot hit a different cluster than the UI pane it came from (Lodestone
  lesson, keep it).
- **Read-only mode** is a flag on the cluster profile checked **in main-process
  handlers** (produce, topic create/update/delete, offset reset, group delete throw
  `ReadOnlyModeError`), not just hidden buttons.
- **Destructive ops** (delete topic, reset offsets, delete group) require the renderer
  to pass `confirmToken: <resource name typed by user>`; main verifies it matches.
- Long-running work (search scan, tail, load test, verification) runs as a **job**:
  `start` returns `jobId`, progress/results stream via `webContents.send` events,
  `cancel(jobId)` stops it. One registry of active jobs in main; all jobs killed on
  window close or cluster disconnect.

---

## 5. IPC contract (define completely in Phase 0, in `src/shared/ipc.ts`)

Single source of truth. Preload generates `window.api` from it. Pattern:

```ts
// invoke channels: request/response
export interface InvokeApi {
  // clusters
  'clusters:list': () => ClusterProfile[]
  'clusters:save': (p: ClusterProfileInput) => ClusterProfile   // secrets in, stored via safeStorage
  'clusters:delete': (id: string) => void
  'clusters:connect': (id: string) => ClusterHealth             // validates + caches metadata
  'clusters:disconnect': (id: string) => void

  // brokers
  'brokers:list': (clusterId: string) => BrokerInfo[]           // id, host, port, rack, controller flag
  'brokers:describeConfigs': (clusterId: string, brokerId: number) => ConfigEntry[]

  // topics
  'topics:list': (clusterId: string) => TopicSummary[]
  'topics:describe': (clusterId: string, topic: string) => TopicDetail  // partitions, offsets, counts, configs
  'topics:create': (clusterId: string, spec: TopicSpec) => void
  'topics:updateConfig': (clusterId: string, topic: string, configs: Record<string,string>) => void
  'topics:addPartitions': (clusterId: string, topic: string, newTotal: number, confirmToken: string) => void
    // irreversible + breaks key ordering — confirm required
  'topics:delete': (clusterId: string, topic: string, confirmToken: string) => void

  // consume (jobs)
  'consume:search': (req: SearchRequest) => { jobId: string }   // filters: text AND/OR, partition, offset, time range, max results
  'consume:peek': (req: PeekRequest) => DecodedMessage | null
  'consume:tail:start': (req: TailRequest) => { jobId: string }
  'job:cancel': (jobId: string) => void

  // serde
  'serde:setTopicConfig': (clusterId: string, topic: string, cfg: SerdeConfig) => void
  'serde:getTopicConfig': (clusterId: string, topic: string) => SerdeConfig
  'serde:loadProtoDir': (dir: string) => ProtoTypeInfo[]        // parse .proto files, list message types
  'serde:loadFbsFile': (path: string) => FbsSchemaInfo
  'serde:testDecode': (clusterId: string, topic: string, cfg: SerdeConfig) => DecodeTestResult // decode 1 sample msg

  // produce
  'produce:single': (req: ProduceRequest) => ProduceResult      // key, headers, partition, serde
  'loadtest:start': (cfg: LoadTestConfig) => { jobId: string }
  'loadtest:verify:start': (cfg: VerifyConfig) => { jobId: string }

  // groups
  'groups:list': (clusterId: string, topic?: string) => GroupSummary[]
  'groups:describe': (clusterId: string, groupId: string) => GroupDetail
  'groups:lag:start': (clusterId: string, groupId: string, topic: string) => { jobId: string } // live poll job
  'groups:resetOffsets': (req: ResetOffsetsRequest, confirmToken: string) => void
    // strategies: 'earliest' | 'latest' | 'to-datetime' | 'shift-by'
    //           | 'explicit' — per-partition {partition: offset} map, edited in a grid
    //             (Offset Explorer's manual offset editing; group must be empty/inactive)
  'groups:delete': (clusterId: string, groupId: string, confirmToken: string) => void

  // export
  'export:messages' | 'export:table': (payload, format: 'json'|'csv') => string // returns saved path
  'export:messageFile': (clusterId, topic, partition, offset, target: 'key'|'value',
                         mode: 'binary'|'text') => string
    // save single message payload to file, raw bytes untouched in binary mode
  'produce:fromFile': (req: ProduceFromFileRequest) => ProduceResult
    // file contents as key or value payload, 'binary' (bytes as-is) or 'text' mode
}

// event channels: main -> renderer streams
export interface EventApi {
  'job:progress': { jobId, scanned, matched, phase }
  'job:messages': { jobId, messages: DecodedMessage[] }         // batched, max 100/event
  'job:done':     { jobId, summary }
  'job:error':    { jobId, error }
  'lag:update':   { jobId, rows: LagRow[], totalLag, ts }
  'loadtest:metrics': { jobId, sent, errors, msgPerSec, p50, p99, partitionOffsets }
  'cluster:status': { clusterId, state: 'connected'|'degraded'|'disconnected' }
}
```

Key model:

```ts
interface DecodedMessage {
  topic: string; partition: number; offset: string; timestamp: number
  key: DecodedValue; value: DecodedValue
  headers: Record<string, string>
  sizeBytes: number
}
interface DecodedValue {
  format: 'json'|'protobuf'|'flatbuffers'|'avro'|'string'|'raw'
  text: string            // pretty JSON or utf8, truncated to 256KB
  truncated: boolean
  rawBase64?: string      // only when format==='raw' or user requests raw view
  decodeError?: string    // decoder tried and failed — show badge + raw fallback
}
```

---

## 6. Core engines (the hard parts — read carefully)

### 6.1 Scanner (search / peek / tail)

Port the Java app's proven strategy:

- **Peek**: fetch 1 message — latest of partition, or exact offset when specified.
  Implementation: assign partition, seek to `endOffset-1` (or given offset), poll once.
- **Search without "from beginning"**: *tail scan* — per partition seek to
  `max(earliest, end - window)` where `window = hasTextFilter ? 1000 : maxResults`,
  scan forward, newest results win. Cheap, covers the common "what just happened" case.
- **Search with time range**: `offsetsForTimes` to find start offset per partition, scan
  until `to` timestamp or maxResults.
- **Search from beginning**: full scan from earliest. UI must show a "slow" warning and
  live progress (scanned count per partition).
- **Text filter**: contains-match on decoded text. `&&`-separated terms = AND,
  `||`-separated = OR (mirror Java semantics: check its `matchesFilter` — AND has
  priority split). Case-insensitive. Applied AFTER decode so filters work on decoded
  protobuf/flatbuffers JSON — this is the killer feature combination.
- **Tail**: poll every 2s from current end offsets, stream new messages newest-first.
  Auto-stop guards: 10k messages or 30 min. Pause/resume without losing position.
- All scanner paths are jobs (§4): cancellable, progress-streaming, batched results.

### 6.2 Serde engine

Decode pipeline per topic (config stored per cluster+topic):

```
mode = topic serde config (default: 'auto')

auto:
  1. registry magic byte 0x00 + schema id?  → Schema Registry decode (avro/proto/jsonschema)
  2. valid UTF-8 that parses as JSON?       → json
  3. configured proto/fbs schema for topic? → try it
  4. valid UTF-8?                           → string
  5. else                                   → raw (hex+base64 preview)

explicit: 'json' | 'string' | 'protobuf:<type>' | 'flatbuffers:<schema>' | 'avro-sr' | 'raw'
Key and value configured independently. Decode failure never crashes the row:
emit format:'raw' + decodeError, UI shows badge.
```

- **Protobuf**: user registers a **schema source** = directory of `.proto` files (with
  import resolution) per cluster. `protobufjs` `load()` at registration, cache `Root`.
  Topic config picks fully-qualified message type from a searchable dropdown.
  Encode path (producer) reuses same type: JSON template → `Type.fromObject` → bytes.
- **FlatBuffers**: user registers `.fbs` schema file. Decode:
  `flatc --json --strict-json --raw-binary <schema.fbs> -- <bin>` via bundled binary.
  - Batch: write N payloads to temp dir, one flatc invocation per batch (flatc accepts
    multiple binaries), read back JSONs. Never spawn per message.
  - Verify bundled flatc works at startup; settings page shows its version and allows
    pointing at a user-supplied flatc path instead.
  - Encode (producer): `flatc --binary <schema.fbs> <template.json>` — same tool, reverse
    direction. This gives load-testing with FlatBuffers without any codegen.
  - Phase 6 (optional, only if flatc throughput hurts): in-process decode via `.bfbs`
    reflection. Do not build this speculatively.
- **Avro/SR**: registry URL + auth per cluster profile. `@kafkajs/confluent-schema-registry`
  `decode()` handles magic byte + schema fetch + cache. Encode via subject lookup.

### 6.3 Payload discipline (perf — the reason the Java app felt slow)

- Decode in main, send only decoded text over IPC, truncate values > 256KB
  (`truncated: true`, full raw available on demand via explicit `consume:peek` at that
  offset).
- Stream results in batches of ≤100 messages per event, UI appends into virtualized list.
- Cap in-memory result set at 50k rows in renderer store; oldest evicted, export
  before evict warns user.
- Search decode order: when a text filter is set and serde is expensive (flatbuffers),
  decode is still required to filter — batch through flatc. Progress events keep UI honest.

### 6.4 Load-test engine

Port Java feature set exactly:

- Config: topic, total messages, concurrency (worker count), batch size, serde for
  key/value.
- Template: JSON in Monaco. Mutators applied per generated message:
  - **auto-increment**: `field` + start + step (dot-path into JSON)
  - **rotation**: `field` + value list, round-robin
  - **uuid**: field list, fresh UUID v4 each message
  - **headers**: static key=value, or value resolved from message field by key name
- Partition/key strategy: auto (null key) | specific partition | field-from-template as
  key | constant key.
- Metrics streamed each second: sent, errors, msg/s, p50/p99 send latency, per-partition
  max offset (captured from send acks — feeds verification).
- **Verify consumption**: input = topic + group(s) + per-partition target offsets
  (auto-filled from last run's captured offsets) + timeout. Poll group committed offsets
  every 2s via admin API, show per-partition progress bars, succeed when all committed ≥
  target, fail on timeout. Cancellable.

---

## 7. UI & theming (distinct from Lodestone)

Lodestone = IBM Plex, dense ops-console, left sidebar + tab strip. Compass must read as a
sibling, not a clone. Direction:

- **Fonts**: Inter (UI) + IBM Plex Mono or Fira Code (data/mono). NOT IBM Plex Sans.
- **Layout**: top-level **command-bar layout**: slim icon rail (left) for sections
  [Clusters, Brokers, Browse, Produce, Groups, Load Test, Settings], persistent **cluster
  switcher + topic picker in a top bar**, content below. No nested tab strips.
- **Message browser** is the hero screen: three-pane — filters (collapsible left),
  virtualized message table (center), detail pane (right, Monaco read-only JSON with
  key/headers/metadata tabs). Table rows show partition/offset/timestamp/key/format
  badge/value preview.
- **Format badges**: colored chip per decode format (json/proto/fbs/avro/raw/error) —
  instant visual confirmation the serde config works.
- Density: comfortable default, compact toggle. Radius 6px, subtle borders, no heavy
  shadows.

### Theming (light + dark, required from Phase 1)

- All colors via CSS custom properties in `styles/tokens.css`. Components NEVER use raw
  hex — Tailwind config maps utilities to `var(--color-*)` tokens.
- Three-state setting: `system | light | dark` (zustand + persisted). `system` follows
  `prefers-color-scheme` via `matchMedia` listener. Explicit choice sets
  `data-theme="light|dark"` on `<html>`.
- Token set (define once, both palettes): `--bg-app, --bg-surface, --bg-raised,
  --border, --border-strong, --text-primary, --text-secondary, --text-muted, --accent,
  --accent-hover, --ok, --warn, --danger, --info` + format-badge colors + chart palette
  (charts must re-read tokens on theme switch).
- Monaco: switch `vs`/`vs-dark` theme in sync.
- Acceptance: every screen legible in both themes; automated Playwright screenshot pass
  in both themes per phase.

---

## 8. Phased roadmap (execute in order)

### Phase 0 — Scaffold (1 week)
1. `npm create @quick-start/electron` (electron-vite, react-ts template); wire Tailwind v4,
   Radix, zustand, strict TS, path aliases.
2. Copy/adapt from Lodestone: `electron-builder.yml`, tsconfig split, typecheck script,
   icon pipeline, `.github` CI (build + typecheck on PR; installers on tag).
3. Implement window shell: contextIsolation, single-instance lock, window-state persist.
4. Write `src/shared/ipc.ts` — the FULL contract from §5 (types compile; handlers stubbed
   with `NotImplemented`). Preload bridge auto-typed from it.
5. Theming foundation: tokens.css both palettes, theme store, toggle in shell, Monaco sync.
6. App shell UI: icon rail, top bar, empty states for all sections.

**Accept**: `npm run dev` shows themed shell; theme toggle + system-follow works; `npm run
dist:win` produces installer; CI green.

### Phase 1 — Clusters & topics (1–2 weeks)
1. Cluster profile CRUD: name, bootstrap servers, TLS (CA/cert/key or insecure), SASL
   (PLAIN/SCRAM-256/512), read-only flag, color label. Secrets via safeStorage; profiles
   JSON in userData.
2. connectionPool: lazy kafkajs instance per profile; connect = admin `describeCluster`;
   health polling → `cluster:status` events; disconnect cleans consumers/jobs.
3. Topic list: name, partitions, replication, size-ish (message count via
   earliest/latest deltas), internal-topic filter, search box.
4. Topic detail: per-partition earliest/latest/count table, configs table (only
   non-default highlighted), ISR/leader info.
5. Topic admin: create (name, partitions, RF, configs), edit configs (diff preview →
   apply), **add partitions** (new total, warning about key-ordering break,
   type-to-confirm), delete (type-to-confirm; blocked in read-only).
6. **Brokers view**: broker table (id, host:port, rack, controller badge), per-broker
   config browser with search + non-default highlight, export.
7. Export: topic detail → JSON/CSV.

**Accept**: connect to real cluster + a docker-compose local cluster; TLS+SASL verified;
read-only blocks create/delete at IPC layer (unit test); destructive confirm flow works.

### Phase 2 — Message browsing (2–3 weeks) ← core value
1. Scanner engine per §6.1: peek, tail-scan search, time-range search, from-beginning
   scan, live tail. Jobs with cancel + progress.
2. Serde: json/string/raw + auto-detect (no proto/fbs yet). DecodedMessage pipeline,
   truncation, batching per §6.3.
3. Message browser UI (hero screen per §7): filter pane (topic, text AND/OR, partition,
   offset, time range with date+time pickers, max results, from-beginning warning),
   virtualized table, detail pane, format badges, copy cell/row/all, export JSON/CSV.
   Detail pane includes a **hex viewer** tab (offset + hex + ASCII columns) for any
   payload, and **save key/value to file** (binary = raw bytes untouched, or text).
4. Live tail UI: streaming mode, pause/resume, newest-first, auto-stop guards visible.
5. Benchmark gate: scan 1M-message topic; UI stays at 60fps; decide kafkajs vs
   node-rdkafka for scan path before Phase 3.

**Accept**: find a message by text in 1M-msg topic without freezing; cancel mid-scan
works; tail runs 10 min stable; both themes clean.

### Phase 3 — Schema decode (2–3 weeks) ← differentiator
1. Bundle flatc per platform in `resources/flatc/`; startup self-test; settings override.
2. Protobuf: schema-source registration (proto dir), type dropdown, per-topic serde
   config, decode in scanner, `serde:testDecode` "try on latest message" button in a
   serde config dialog.
3. FlatBuffers: `.fbs` registration, batch flatc decode in scanner, same test-decode UX.
4. Avro/SR: registry URL+auth per cluster, magic-byte auto-detect, decode.
5. Filters run on decoded JSON text (verify explicitly with proto+fbs topics).
6. Serde config persisted per cluster+topic; format badge reflects reality; decode
   errors show raw fallback + error chip, never crash the scan.

**Accept**: given a `.proto` dir and an `.fbs` file, both topic types render readable
JSON in browser AND are text-searchable; sample fixtures + integration tests exist for
all three formats.

### Phase 4 — Groups, then producer (2 weeks)

Ordered groups-first on purpose (see §0): lag and offset reset are the daily-use, high-risk
operations, and produce is better done after them because it also validates the Phase 3
encode paths.

1. Groups list + describe: members, assignments, state; export; **delete group**
   (type-to-confirm, blocked when active members or read-only).
2. Live lag monitor: job polling committed vs end offsets every 2s; table
   (partition/committed/end/lag/lag-bar/member/client) + total lag stat + lag trend
   chart; export table/chart PNG+CSV.
3. Offset reset: earliest/latest/to-datetime (date+time picker)/shift-by(±N)/
   **explicit per-partition edit** — grid pre-filled with current committed offsets,
   user edits any cell, valid-range check against earliest/latest before commit
   (Offset Explorer parity). Requires group empty check; type-to-confirm; read-only
   blocked. `groups:resetPreview` renders the dry run before anything is applied.
4. Single produce: topic, JSON/text editor, key, headers, partition, serde encode
   (json/string/proto/fbs/avro-sr — reverse of §6.2), success shows partition+offset.
   Plus **produce from file**: pick file as key or value payload, binary (bytes as-is)
   or text mode.

**Accept**: produce a protobuf message that Phase 3 browser decodes back; binary file
round-trips (produce-from-file → save-to-file → byte-identical); lag monitor runs
against consuming app and chart updates live; reset (incl. explicit per-partition edit)
moves offsets verifiably; group delete works and is blocked while members active.

### Phase 5 — Load testing & verify (2 weeks)
1. Load-test engine per §6.4 (workers in main process; template + mutators; metrics
   stream; per-partition offset capture).
2. Load-test UI: config form, Monaco template, mutator editors (increment/rotation/uuid/
   headers), live metrics dashboard (msg/s, latency percentiles, error count, per-worker
   state), start/stop.
3. Verify-consumption UI: target offsets auto-filled from last run, group multi-select
   (from groups list), timeout, per-partition progress bars, pass/fail summary.
4. Save/load named load-test configs (JSON in userData).

**Accept**: push 100k JSON msgs ≥10k msg/s locally with mutators verified in consumed
data; verify passes when consumer catches up, fails on timeout; FlatBuffers load test
works via flatc encode.

### Phase 6 — Polish & release (1–2 weeks)
1. Auto-update wiring (electron-updater + GitHub releases), version/about screen.
2. Command palette (Ctrl+K): jump to topic/section/action.
3. Keyboard shortcuts on hero screens; empty/error/loading states audit.
4. Playwright smoke suite: connect → browse → decode → produce → lag, both themes.
5. README with screenshots (both themes), docs for schema setup (proto dir layout, fbs,
   SR), LICENSE (Apache-2.0), CONTRIBUTING.
6. Installers for win/mac signed if certs available; first tagged release v0.1.0.

---

## 9. Cross-cutting rules for the dev agent

1. **Typecheck must pass** (`npm run typecheck`) before every commit. No `any` in
   `src/shared`.
2. Every IPC handler: validate inputs, wrap errors into `{code, message, details}` —
   renderer never sees raw stack traces except in a debug console.
3. Every long operation is a cancellable job with progress events. No fire-and-forget.
4. Never render an unvirtualized list that can exceed 100 rows.
5. No raw hex colors in components — tokens only. Both themes checked per PR
   (Playwright screenshots).
6. Secrets: only through safeStorage; never logged; redact in exports.
7. Kafka integration tests use docker-compose (`tests/docker/`) with a seeded topic set:
   json topic, proto topic, fbs topic, avro+SR topic, high-volume topic (1M msgs).
   Provide `npm run test:integration` that spins it up.
8. Commits per task, conventional commits, PR per phase-section.
9. When a §6 engine decision is ambiguous, check the Java reference implementation
   (`KafkaSearchService.searchMessages` scan strategy, `matchesFilter`,
   `FlatBuffersMessageGenerator` mutator semantics) — port behavior, not code.



## 10a. Build log — what actually happened

Findings from Phases 0–2 that the plan did not anticipate. Keep these; they are the
expensive lessons.

- **kafkajs is CommonJS.** With `"type": "module"`, `import { Kafka } from 'kafkajs'`
  fails at runtime for any export Node's cjs-lexer misses (`ConfigResourceTypes`). Import
  the default and destructure. Same class of problem gave the preload an `.mjs` filename
  that `main/index.ts` was not loading.
- **Compression codecs are not optional.** kafkajs ships gzip only. The first real topic
  was Snappy and every fetch crashed the consumer with
  `KafkaJSNotImplemented: Snappy compression not implemented`. Registered snappy + lz4
  from pure-JS packages (no native builds, so packaging stays simple); zstd is still
  unhandled and will surface as a clear error. `CompressionCodecs[type]` takes a
  *factory*, and `kafkajs-snappy` already is one — wrapping it yields
  `codec.decompress is not a function` and a silent zero-result scan.
- **`consumer.seek()` needs an assignment.** Seeking straight after `run()` is dropped;
  a scan reads nothing. Seek inside the `GROUP_JOIN` event.
- **There is no "end of assignment" callback.** Once a partition drains, kafkajs simply
  stops calling `eachBatch`, so a bounded scan never resolves. It needs an idle deadline —
  with a longer grace before the first batch, since joining a 50-partition group across
  six brokers takes ~5s and the first fetch lands seconds later.
- **Never fetch per-topic offsets in the topic list.** A real cluster had 1,865 topics;
  one `fetchTopicOffsets` per topic made the list unusable. Metadata only in the list;
  counts in the detail pane.
- **Zustand selectors that build arrays need `useShallow`**, or the store hands React a
  new snapshot every render and the view loops until it crashes.
- **Installers cannot be built on this network.** electron-builder fetches NSIS and
  winCodeSign from GitHub, and TLS interception breaks it (`unable to get local issuer
  certificate`) — including for `--dir`, and with `win.signAndEditExecutable=false`, so
  there is no flag that avoids it. The Electron binary itself came from the local cache,
  which is why the version is pinned to 43.1.0. CI builds installers on tags instead.
- **`npm run pack:local` is the local escape hatch.** `scripts/pack-local.mjs` unzips the
  cached Electron runtime, copies `out/`, `resources/` and the production dependency tree
  (resolved with `npm ls --omit=dev --all --parseable`) into `resources/app`, and renames
  `electron.exe`. No network, no signing, no asar — a 522MB runnable folder in
  `dist/Klarity-win32-x64`. The `.exe` keeps the stock Electron icon because setting it
  needs rcedit, which is part of the vendor download being avoided.
- **electron-updater throws on any build electron-builder did not produce.** Without
  `app-update.yml` in resources, `checkForUpdates()` rejects with ENOENT *and* emits
  `error`, so an unawaited call left an unhandled rejection on every launch. The updater
  now checks for that file first and reports "updates are disabled in this build".

- **Describing every consumer group does not scale.** `p19-dev` has ~929 groups: `listGroups`
  alone is 7.6s, `describeGroups` for all of them another 22s, plus 7s of `fetchOffsets` to
  find the topics of the 63 idle groups — 36s for a list. `listGroups` now returns names only
  past `ENRICH_LIMIT` (200 groups), with `Unknown` state; the detail pane describes the one
  group that was opened. Same shape as the topic-list lesson above. A topic filter still pays
  the full cost, because nothing cheaper can answer it.
- **`admin.setOffsets` costs ~11s on a big cluster**, every call, because kafkajs refreshes
  cluster metadata first (1865 topics). Not a bug — but every reset path must show a busy
  state for that long.
- **The broker enforces the empty-group rule itself**: `setOffsets` on a Stable group fails
  with "The consumer group must have no running instances", and `deleteGroups` throws
  `KafkaJSDeleteGroupsError: Error in DeleteGroups` with nothing else in it. Klarity's
  pre-checks exist for the message, not the safety.
- **`p19-dev` topics cannot carry record headers.** Their `message.format.version` is
  `0.10.1-IV2`, which predates message format v2, and the broker answers any record with
  headers with `UNKNOWN_SERVER_ERROR` — no hint of the cause. `producer.ts` reads the topic's
  message format on the failure path and says so. Producing without headers is unaffected.
- **Cluster metadata is the whole cost of feeling slow, and kafkajs never caches it.**
  Measured on `p19-dev` (1865 topics): `describeCluster` 4–8s, `listTopics` 3.3s,
  `fetchTopicMetadata()` 5.5s *per call* — a second call costs the same as the first. Connect
  ran describeCluster then listTopics sequentially (22s), the topic list then refetched all
  metadata (5.9s), and the brokers view refetched it again (10s). Now: connect waits only on
  `describeCluster` (6.5s) and kicks off the metadata fetch in the background; the topic list
  and brokers view share that one cached snapshot (5-minute TTL, dropped on topic
  create/delete/add-partitions, bypassed by the toolbar's Refresh). Same clicks: 38s -> 13s,
  and a revisit is instant.
- **One leaderless partition anywhere fails a whole-cluster metadata call — retrying alone does
  not fix it on a large enough cluster.** `describeCluster`, `listTopics` and
  `fetchTopicMetadata` all request metadata for *every* topic (kafkajs's `writeNullableArray`
  treats an empty topics array the same as null — "all topics" — with no public way to ask for
  fewer), and its response parser (`metadata/v0/response.js`) throws on the *first* partition
  anywhere in the response with a non-zero error code. On `p04` this was not a rare blip: 60s of
  continuous retrying never once found a clean moment across ~900+ topics, meaning something is
  always mid-election somewhere. Offset Explorer connects because its admin client does not
  request all-topics metadata just to report broker/connectivity info the way kafkajs's
  `describeCluster()` does — see the "Offset Explorer connects, why doesn't Klarity" note below.
  `retryThroughElection` (bounded retry past kafkajs's own few-second budget, parameterized
  deadline) still exists and is used for calls that must eventually succeed
  (`topicMetadata()`, `listBrokers`). For connect/test, `probe()` now treats
  `describeCluster`/`listTopics` as best-effort (`bestEffort()`, 10s budget): only
  `admin.connect()` — a real handshake — is required. A cluster that never presents a clean
  metadata snapshot still connects, with broker/topic counts filled in later by
  `warmClusterInfo()` (full 60s budget) once/if the cluster settles, mirroring the existing
  `warmTopicMetadata()` background-fill pattern. `bestEffort()` distinguishes "gave up waiting
  out an election" (`LeaderElectionTimeoutError`, degrades gracefully) from any other failure
  (auth denied, connection dropped — rethrown, never hidden behind "broker details are
  loading").
- **A test importing renderer code needs DOM lib, and `tsconfig.node.json` doesn't have it.**
  `tests/browseSort.test.ts` imports `messageStore.ts`, which pulls in `window.klarity` — but
  `tests/**/*.ts` was included in the Node-only tsconfig (no DOM lib). Composite/incremental
  caching masked the resulting error for a while (a stale `.tsbuildinfo` skipped re-checking
  unchanged files); deleting `out/types-*` surfaced it. Fixed with `tsconfig.tests.json` — its
  own project covering both `src/main` and `src/renderer` with DOM lib, so a test may cross
  either boundary. `tests/**/*.ts` was removed from `tsconfig.node.json`'s include; `typecheck`
  now runs three `tsc` invocations.
- **Valid UTF-8 is not readable text.** Java's `LongSerializer` writes 8 big-endian bytes, and
  a small id makes most of them NUL — every byte legal UTF-8, so the old `isUtf8` check called
  it text and the UI showed invisible control characters (real case: `asset-feed` keys and a
  `CUSTOMER_ID` header on `p19-dev`). Decoding now tests *printability*, and the serde list
  carries Kafka's fixed-width serializers: Long, Integer, Short, Double, Float. `auto` guesses
  only 8- and 4-byte payloads whose high byte is zero — width alone produced false positives on
  ordinary binary.
- **A Long key collides with Schema Registry framing.** Both start with `0x00`, so
  `readSchemaId` claimed every 8-byte key. `auto` checks the protobuf-string wrapper first (an
  exact structural match), then fixed-width numbers, then registry framing — that branch only
  runs when no registry is configured, where a Long key is much the likelier reading.
- **protobufjs accepts bad produce input silently**: `fromObject` drops fields whose names it
  does not know (a camelCase typo against a snake_case schema loses data), and coerces an
  object handed to a scalar field into the string `[object Object]`. `encodeProtobuf` now
  rejects both before anything reaches a topic.
- **Test topics need `replicationFactor: 3` on `p19-dev`** — the cluster's `min.insync.replicas`
  rejects produce to an RF=1 topic with `NOT_ENOUGH_REPLICAS`.

## 10b. Risks & fallbacks

| Risk | Detection | Fallback |
|---|---|---|
| kafkajs scan too slow | Phase 2 benchmark gate | node-rdkafka behind `scanner.ts` interface |
| flatc batch decode too slow for filtered full scans | Phase 3 fixture with 100k fbs msgs | `.bfbs` reflection decoder in-process |
| SR protobuf wire format quirks | Phase 3 integration test | fall back to raw + manual proto config |
| Electron + kafkajs SSL edge cases (self-signed) | Phase 1 TLS test matrix | expose `rejectUnauthorized` toggle like Lodestone |
| 50k-row renderer store memory | Phase 2 profiling | lower cap + disk-backed export prompt |
