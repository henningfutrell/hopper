# job-hopper — design

The contract every module is built against. Types: `src/domain/types.ts`; seams:
`src/domain/ports.ts`; words: `docs/glossary.md`.

## Shape

```
          push (HTTP)                       SSE /api/events/stream ──► UI
 agent ─────────────► http ──► store ◄──┐            ▲
                                │       │            │
                    events ◄────┘       │       event log ──► webhook dispatcher ──► subscribers
                      │                 │
                      ▼                 │
   tick / trigger ─► engine ── gather inputs ──► decide() (pure) ──► Decision
                      │   machines · lanes · usage · waiting · running · jev mode
                      └── apply: lanes open/close/drain, claim+start jobs, holds
                                 │
                              executors (test; herdr-claude later)
```

One process. Node ≥ 24 runs the TypeScript directly (type stripping) — no build step.
Fastify for HTTP, `node:sqlite` for storage, zod for request validation.

## Directories and what each must not know

| dir | owns | must not import |
|-----|------|-----------------|
| `src/domain/` | types, ports | anything else in `src/` |
| `src/decider/` | `decide(inputs, decisionId): Decision` — pure, no I/O, no clock | everything but `domain/` |
| `src/store/` | SQLite schema, migrations, repositories, event log | engine, http, decider |
| `src/webhooks/` | signing, dispatcher, retry/backoff | engine, http, decider |
| `src/jev/` | `JevAdvisor` adapters: `router` (shim over grok-bot-jev), `fake` | engine, http, store |
| `src/executors/` | `Executor` adapters: `test` | engine, http, store |
| `src/machines/` | `MachineSource` adapters: `local` | engine, http, store |
| `src/usage/` | `UsageSource` adapters: `fake` | engine, http, store |
| `src/engine/` | the loop: gather → decide → apply; job lifecycle; restart recovery | http |
| `src/http/` | Fastify routes, SSE, static UI | executors, jev internals |
| `src/ui/` | static `index.html`, `app.js`, `style.css` — browser only | all of `src/` (talks HTTP/SSE only) |
| `src/main.ts` | composition root: config → adapters → store → engine → server | — |

## The decider

`decide(inputs: DecisionInputs, decisionId: string): Decision`. Deterministic: same inputs,
same Decision. Algorithm, in order:

1. **Usage fraction per machine.** `usedFrac(m)` = max of `used/limit` over readings whose
   `machineId` is `m` or absent. Readings with `limit <= 0` are ignored and noted in
   `reasons`. No readings → `0`.
2. **Lane cap per machine** (`policy.softLimit`, `policy.hardLimit`):
   - offline → `0`
   - `usedFrac < soft` → `maxLanes`
   - `usedFrac >= hard` → `0` (stop: close idle lanes, drain busy ones, start nothing)
   - between → `floor(maxLanes * (hard - usedFrac) / (hard - soft))` (linear scale-down)
3. **Jev verdict per waiting job** — always computed, in both modes:
   - no advice yet → hold `awaiting Jev classification` (so in active mode nothing starts
     before Jev has spoken; in shadow mode the native verdict ignores it)
   - `approved` → proceed, whatever the advice (a human override ends every Jev hold)
   - `ask_human` → hold `jev ask_human: awaiting approval`
   - `stop_retry` → hold `jev stop_retry: …`
   - `reuse_cache` → hold `jev reuse_cache: …`
   - `chat_only`, `run_deterministic` → proceed, priority `+ policy.jevCheapBoost`
   - anything else → proceed
   A `JevDivergence` is recorded for every job where the Jev verdict (start/hold or order)
   differs from the native one.
4. **Mode.** `active`: admission and effective priority use the Jev verdict. `shadow`:
   native verdict (everything admissible, priority = `job.priority`); Jev's verdict appears
   only in `decision.jev`.
5. **Native holds.** No online machine runs the job's executor → hold. Pinned machine
   unknown or offline → hold.
6. **Order.** Admissible jobs by effective priority desc, then `createdAt` asc, then `id`.
7. **Assign.** For each job in order: candidate machines = online, run its executor, match
   its pin, `busy(m) + assigned(m) < cap(m)`. Pick the one with the most remaining room
   (tie: machine id). Use an existing idle, non-draining lane if one is unassigned, else
   `laneId: null` (a lane this Decision opens). No candidate → hold with the reason
   (`all lanes busy (cap N)` / `usage hard limit` / `usage soft limit caps lanes at N`).
8. **Lane plan per machine.** `occupied` = lanes `busy` or `draining`. `target =
   min(cap, occupied + assigned)`. `open` = number of this machine's starts with
   `laneId: null` — **invariant**, the engine opens lanes only for those starts.
   Idle lanes not assigned: kept while `occupied + assigned + kept < cap` and the lane has
   been idle less than `policy.laneIdleGraceMs` (from `idleSince` and `inputs.at`);
   otherwise closed. Always closed at cap 0. Drains `max(0, occupied - target -
   alreadyDraining)` **busy** lanes, newest first. `current` counts idle + busy + draining.
   Every plan carries a one-line `reason`.
9. **Reasons.** Plain sentences in the order reached. The Decision carries `inputs`
   verbatim.

**A no-op decision is not recorded.** The engine discards a Decision with no lane change,
no start, and no hold whose reason differs from the job's current `holdReason`. Otherwise
an idle tick every 2 s would bury the decision log. Every recorded Decision emits
`decision.made` with `{ decisionId, starts, holds, lanes, jevMode, divergences }`.

## The engine

- **Triggers:** interval tick (`JOB_HOPPER_TICK_MS`, default 2000) plus the events
  `job.queued`, `job.prioritized`, `job.approved`, `job.finished`, `job.failed`,
  `job.cancelled`, `jev.mode_changed`, and a usage change. Decisions are serialized; triggers
  arriving mid-decision coalesce into one follow-up. Event listeners schedule triggers with
  `setImmediate`; they never run a decision synchronously inside `append`.
- **Jev classification:** on `job.queued`, on every tick, and at startup, the engine calls
  `advisor.advise(job)` for each waiting job with no `jevAdvice` that is not already in its
  in-memory in-flight set — off the decision path. It stores `jevAdvice` and emits
  `job.prioritized` with `{ advice, mode }`. A crash or requeue mid-classification is
  therefore retried, never lost.
- **Claim** increments `attempts`. `job.progressed` is throttled to one event per job per
  500 ms (the last one before finish is always emitted).
- **Apply:** close idle lanes (`lane.closed`), mark drains, open lanes (`lane.opened`),
  then for each start: claim (`job.claimed`, lane busy), run executor (`job.started`),
  progress (`job.progressed`), outcome (`job.finished` / `job.failed`). Lane returns idle, or
  closes if draining. Holds: set `status: held`, `holdReason`, emit `job.held` only when the
  reason changed.
- **Approve:** `POST /api/jobs/:id/approve` sets `approved: true` on a waiting job; it overrides
  every Jev hold (not only `ask_human`).
- **Cancel:** waiting → `cancelled` at once. Claimed/running → abort the executor's signal;
  the job ends `cancelled`. Terminal → HTTP 409.
- **Restart recovery:** at startup, every `claimed`/`running` job returns to `queued`
  (`job.requeued`, `attempts` kept) and every stored lane is closed (`lane.closed`,
  `reason: daemon restart`). Test jobs are idempotent; a future executor that is not must
  declare it, and this rule is revisited then.
- **Shutdown:** SIGTERM aborts running executors, waits up to 5 s, closes the store.
  Interrupted jobs are requeued on the next start, by the rule above.

## Jev

Jev (`~/workbench/jev-src/grok-bot-jev`, Python) is a per-request classifier: TypeSafe's
`system_one` answers intent / reuse_cache / needs_subagent / stop_retry / complexity, and
`route_task` maps that to one action. It has **no notion of machines, lanes, or usage
budgets**, so it cannot be the usage source. job-hopper uses it for what it is: the
**admission and prioritization layer** per job. Usage budgets come from `UsageSource`.

- `router` advisor: spawns `python3 src/jev/jev_shim.py` with JSON on stdin. The shim puts
  the Jev repo on `sys.path`, loads Jev's **own** `config.yaml` (its kill switch is
  honoured), overrides only `mode` (job-hopper's) and `logging.path` (job-hopper's data
  dir), sets `PYTHONDONTWRITEBYTECODE=1`, calls `route_task(state)`, prints the result.
  Nothing is written under the Jev repo. `router.py` imports `typesafe_sdk` at module
  load (via `src.jev_client`); when that package is absent the shim installs a stub module
  in `sys.modules` so the kill-switch path still runs — with Jev enabled the stub raises
  and the call falls back. The shim patches `src.router.load_config` and
  `src.router.resolve_log_path` (the names the router imported) and catches
  `BaseException` (`secrets.py` raises `SystemExit`). Advice from a real router run has
  `source: "jev-router"`; `jevUsed` mirrors the router's own `jev_used`. Any failure (missing `typesafe_sdk`, missing
  `TYPESAFE_API_KEY`, timeout 10 s, bad JSON) → advice `{ action: proceed_full, source:
  fallback, jevUsed: false, reason: "jev unavailable: …" }` — the router's own documented
  safe fallback.
- Job → Jev state: `goal` ← `spec.goal`, `kind` ← `spec.kind`, plus `spec.meta` keys
  `cached_artifact`, `cached_note`, `prior_error`, `same_error_count`, `sources_found`,
  `constraints`.
- `fake` advisor: deterministic, no network, mirrors the router's precedence from job
  metadata: bypass marker → `proceed_full` (jevUsed false); `meta.cached_artifact` →
  `reuse_cache`; `meta.prior_error` and `same_error_count >= 1` → `stop_retry`; kind
  `lookup` → `run_deterministic`; `chat` → `chat_only`; `account` → `ask_human`;
  `meta.needs_subagent` → `allow_subagent`; `research`/`browser` → `research_capped`; else
  `proceed_full`.
- **Mode** is job-hopper's, persisted in the store (`settings`), initialised from
  `JOB_HOPPER_JEV_MODE` (default `shadow`), switched at runtime by `PUT /api/jev`.

## HTTP API

Loopback only (`127.0.0.1`), no auth — see profile. JSON everywhere; errors are
`{ error: string }` with 400/404/409.

| method | path | body / query | returns |
|--------|------|--------------|---------|
| GET | `/api/health` | | `{ ok, version, jevMode, advisor, uptimeS }` |
| POST | `/api/jobs` | `JobSpec` | 201 `Job` · 400 unknown executor / invalid payload |
| GET | `/api/jobs` | `?status=queued,held&limit=100` | `{ jobs: Job[] }` newest first |
| GET | `/api/jobs/:id` | | `Job` · 404 |
| POST | `/api/jobs/:id/cancel` | | `Job` · 404 · 409 terminal |
| POST | `/api/jobs/:id/approve` | | `Job` (emits `job.approved`) · 404 · 409 terminal |
| GET | `/api/queue` | | `{ waiting: Job[], running: Job[], counts: Record<JobStatus, number> }` |
| GET | `/api/machines` | | `{ machines: (MachineSnapshot & { lanes: Lane[], usage: UsageReading[] })[] }` |
| GET | `/api/decisions` | `?limit=50` | `{ decisions: Decision[] }` newest first |
| GET | `/api/decisions/:id` | | `Decision` · 404 |
| GET | `/api/events` | `?after=0&limit=200&types=job.queued,…` | `{ events: DomainEvent[] }` |
| GET | `/api/events/stream` | `?after=<seq>` or `Last-Event-ID` | SSE (below) |
| GET | `/api/jev` | | `{ mode, advisor }` |
| PUT | `/api/jev` | `{ mode: "shadow" \| "active" }` | `{ mode, advisor }` (emits `jev.mode_changed`) |
| GET | `/api/usage` | | `{ readings: UsageReading[] }` |
| PUT | `/api/usage/fake` | `{ used, limit, unit?, machineId? }` | `{ readings }` · 404 if no fake source |
| POST | `/api/webhooks` | `{ url, events?: string[], secret?: string }` | 201 `WebhookSubscription` (secret shown once) |
| GET | `/api/webhooks` | | `{ subscriptions }` (secret omitted) |
| DELETE | `/api/webhooks/:id` | | 204 · 404 |
| GET | `/api/webhooks/deliveries` | `?subscriptionId=&limit=100` | `{ deliveries }` newest first |
| GET | `/` | | the UI |

## SSE

`GET /api/events/stream`. Replays events after `?after=` / `Last-Event-ID`, then live.
Domain events: `id: <seq>`, `event: <type>`, `data: <DomainEvent JSON>`. Delivery updates
(not domain events, never persisted or webhooked, so a delivery cannot trigger a delivery):
`event: delivery.updated`, `data: <WebhookDelivery JSON>`, no `id`. Comment heartbeat
`: ping` every 15 s.

## Webhooks

Each appended event creates a delivery for every active subscription whose `events`
contains its type or `*`. Request:

```
POST <url>
content-type: application/json
x-jobhopper-event: job.finished
x-jobhopper-delivery: <delivery id>
x-jobhopper-timestamp: <unix seconds>
x-jobhopper-signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>

<DomainEvent JSON>
```

Delivery is **at-least-once**; receivers dedupe on `x-jobhopper-delivery`. Before each POST
the dispatcher moves `nextAttemptAt` past the timeout and keeps the id in an in-memory
in-flight set, so the sweep never sends one delivery twice concurrently. Deleting a
subscription marks its pending/retrying deliveries `failed`.

2xx within 5 s = delivered. Otherwise attempt `n` schedules the next at
`now + min(base * 2^(n-1), 300 s)`, `base` = 1 s (configurable for tests); after 6 attempts
the delivery is `failed`. Due deliveries are swept every 500 ms and on enqueue; pending
deliveries survive a restart. Secrets: generated (32 random bytes hex) if not supplied.

## Construction contract

One factory per module. `src/main.ts` and the integration tests wire these; nothing else
constructs adapters.

```text
src/store/index.ts      openStore(o: { path: string; clock: Clock; idGen?: IdGen }): Store
src/webhooks/index.ts   createWebhookDispatcher(o: { store: Store; clock: Clock; baseMs: number;
                          timeoutMs?: number; maxAttempts?: number; sweepMs?: number }): WebhookDispatcher
src/jev/index.ts        createRouterAdvisor(o: { jevSrc: string; python: string; dataDir: string;
                          mode: () => JevMode; clock: Clock; timeoutMs?: number }): JevAdvisor
                        createFakeAdvisor(o: { clock: Clock }): JevAdvisor
src/executors/index.ts  createTestExecutor(): Executor
                        createExecutorRegistry(executors: Executor[]): ExecutorRegistry
src/machines/index.ts   createLocalMachineSource(o: { maxLanes: number; executors: string[];
                          id?: string; label?: string }): MachineSource
src/usage/index.ts      createFakeUsageSource(clock: Clock): SettableUsageSource
src/decider/index.ts    decide(inputs: DecisionInputs, decisionId: string): Decision
src/engine/index.ts     createEngine(...)  — T009 defines
src/http/index.ts       createServer(...)  — T009 defines
```

`test/support/` belongs to the engine/HTTP task only; every other task keeps helpers in its
own test directory.

## Test executor

`executor: "test"`, payload `{ op: "sleep" | "echo" | "fail", ms?: number, message?: string }`.

- `sleep` — waits `ms` (default 1000, max 600000), progress every ~10%, result `{ slept: ms }`.
- `echo` — waits `ms` (default 0), result `{ echo: message }`.
- `fail` — waits `ms` (default 0), outcome `{ ok: false, error: message ?? "failed on purpose" }`.
- Abort at any point → `{ ok: false, error: "aborted" }` promptly (within 50 ms).
- `validate` rejects an unknown `op`, a non-number or negative `ms`, `ms` above the max.

## Event payloads

Every event: `{ seq, id, type, at, jobId?, laneId?, machineId?, decisionId?, data }`.

| type | `data` |
|------|--------|
| `job.queued` | `{ spec, priority }` |
| `job.prioritized` | `{ advice: JevAdvice, mode, statusAtAdvice }` — emitted once per job, whatever its status when Jev answered |
| `job.held` | `{ reason }` — only when the reason changes |
| `job.approved` | `{}` |
| `job.claimed` | `{ attempts, effectivePriority, reason }` |
| `job.started` | `{ attempts }` |
| `job.progressed` | `{ progress, message? }` — at most one per job per 500 ms |
| `job.finished` | `{ result }` |
| `job.failed` | `{ error }` |
| `job.cancelled` | `{ reason }` |
| `job.requeued` | `{ from, reason: "daemon restart" }` |
| `lane.opened` | `{}` |
| `lane.closed` | `{ reason }` — the lane plan's reason, `drained`, or `daemon restart` |
| `decision.made` | `{ decisionId, trigger, jevMode, starts, holds, lanes, divergences }` |
| `jev.mode_changed` | `{ from, to }` |

The usage-change trigger is named `usage.changed`; it is a trigger, not an event.

## Settled in the founding session (2026-10-02)

- **Jev is not a usage source.** It classifies one request; it knows no machines, lanes or
  budgets. It is the per-job admission and prioritization layer; budgets come from a
  `UsageSource`.
- **Jev advice is recorded for every job.** In shadow mode a job may start, or finish,
  before Jev answers; the advice still lands on the job and in `job.prioritized`
  (`statusAtAdvice` says when). Classification starts when a job is queued; a sweep of
  waiting jobs without advice is the retry path.
- **Divergence is recorded only for jobs Jev had classified at decision time.** A shadow
  job that started before its advice arrived has advice but no divergence record.
- **Soft-limit scaling floors.** `floor(maxLanes × (hard − used)/(hard − soft))`: with 2
  lanes, 85 % usage gives 0 lanes, not 1. Conservative by choice.
- **Only `127.0.0.1` is accepted** for `JOB_HOPPER_HOST`; config refuses anything else.
- **Static UI files are read once at startup**; a UI change needs a daemon restart.
- **The installed daemon runs from a copy** (`~/.local/lib/job-hopper`, made by
  `scripts/install.sh`), so switching branches in the source checkout never breaks it.

## Configuration (env)

| var | default |
|-----|---------|
| `JOB_HOPPER_HOST` | `127.0.0.1` |
| `JOB_HOPPER_PORT` | `4790` |
| `JOB_HOPPER_DB` | `~/.local/share/job-hopper/job-hopper.db` |
| `JOB_HOPPER_TICK_MS` | `2000` |
| `JOB_HOPPER_JEV_MODE` | `shadow` (initial only; the stored setting wins once set) |
| `JOB_HOPPER_JEV_ADVISOR` | `router` (`fake` for tests and demos) |
| `JOB_HOPPER_JEV_SRC` | `~/workbench/jev-src/grok-bot-jev` |
| `JOB_HOPPER_PYTHON` | `python3` |
| `JOB_HOPPER_LOCAL_LANES` | `4` |
| `JOB_HOPPER_SOFT_LIMIT` / `HARD_LIMIT` | `0.7` / `0.95` |
| `JOB_HOPPER_JEV_CHEAP_BOOST` | `10` |
| `JOB_HOPPER_WEBHOOK_BASE_MS` | `1000` |
| `JOB_HOPPER_LANE_IDLE_GRACE_MS` | `5000` |
