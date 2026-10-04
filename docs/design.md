# job-hopper — design

The contract every module is built against. Types: `src/domain/types.ts`; seams:
`src/domain/ports.ts`; words: `docs/glossary.md`.

## North star

Owner direction (2026-10-03): an extendable plugin architecture.

This is the top-level principle. Every part must serve it: a new capability arrives as a
plugin or as configuration of one, not as a hardcoded branch. "Phase 5 — every part is a
plugin" is its current enactment; Phase 6 items are judged against it.

## Shape

```
          push (HTTP)                       SSE /api/events/stream ──► UI
 agent ─────────────► http ──► store ◄──┐            ▲
                                │       │            │
                    events ◄────┘       │       event log ──► webhook dispatcher ──► subscribers
                      │                 │
                      ▼                 │
   tick / trigger ─► engine ── gather inputs ──► decide() (pure) ──► Decision
                      │   machines · lanes · usage · waiting · running · router mode
                      └── apply: lanes open/close/drain, claim+start jobs, holds
                                 │
                              executors (plugin instances: herdr-claude, test)
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
| `src/plugins/` | the plugin SDK (`sdk.ts`, imported by authors as `job-hopper/plugin`), built-in list (`builtin.ts`), custom loader, detection kit, `plugins.yaml` + watch, the role slots (`router-slot.ts` with the shared `instantiate`, `question-slots.ts`, `executor-slot.ts`, `source-slots.ts` for job, machine and usage sources, `notifier-slot.ts`), the plugins-file migration and the built-in instances (`migrate.ts`), the locked-down `claude -p` runner the claude plugins share (`claude-print.ts`), `expand-home.ts`; built-in plugins under `<role>/<id>/` (`router/jev-router/` holds the Jev shim; `answerer/claude-cli/`, `assessor/claude-cli-assessor/`, `assessor/always-escalate/` hold their prompts; `executor/herdr-claude/` and `executor/test/` wrap the adapters in `src/executors/`; `job-source/github-gh/` and `job-source/github-app/` build the GitHub sources of `src/sources/`; `machine-source/local/` wraps `src/machines/`; `notifier/grokbot-routine/` is the Grok Bot routine webhook — env-file reader and notifier) | engine, http, store, decider, questions |
| `src/executors/` | `Executor` adapters (`test`, `herdr/`) and the registry; reached through the executor plugins | engine, http, store, plugins |
| `src/machines/` | `MachineSource` adapters: `local`; reached through the `local` machine-source plugin | engine, http, store, plugins |
| `src/usage/` | `UsageSource` adapters: `fake` — a test double at the seam (`AppSeams.fakeUsage`), never composed in production | engine, http, store, plugins |
| `src/engine/` | the loop: gather → decide → apply; job lifecycle; restart recovery | http |
| `src/http/` | Fastify routes, SSE, static UI | executors, plugins (reads them through the `PluginsView` port) |
| `src/ui/` | static `index.html`, `app.js`, `style.css` — browser only | all of `src/` (talks HTTP/SSE only) |
| `src/main.ts` | composition root: config → plugins.yaml (migrated or written when absent) → plugin host (every part) → store → engine → server | — |

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
3. **Router verdict per waiting job** (from `job.advice`) — always computed, in both modes:
   - no advice yet → hold `awaiting router advice` (so in active mode nothing starts
     before the router has spoken; in shadow mode the native verdict ignores it)
   - `approved` → proceed, whatever the advice (a human override ends every router hold)
   - `ask_human` → hold `router ask_human: awaiting approval`
   - `stop_retry` → hold `router stop_retry: …`
   - `reuse_cache` → hold `router reuse_cache: …`
   - `chat_only`, `run_deterministic` → proceed, priority `+ policy.routerCheapBoost`
   - anything else → proceed
   A `Divergence` is recorded for every job where the router verdict (start/hold or order)
   differs from the native one.
4. **Mode** (router mode). `active`: admission and effective priority use the router
   verdict. `shadow`: native verdict (everything admissible, priority = `job.priority`); the
   router's verdict appears only in `decision.advice`.
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
`decision.made` with `{ decisionId, starts, holds, lanes, routerMode, divergences }` (v2).

## The engine

- **Triggers:** interval tick (`JOB_HOPPER_TICK_MS`, default 2000) plus the events
  `job.queued`, `job.prioritized`, `job.reprioritized`, `job.approved`, `job.finished`,
  `job.failed`, `job.cancelled`, `router.mode_changed`, `question.asked`, `question.answered`,
  `question.expired` (`TRIGGERS`, `src/engine/index.ts`). Decisions are serialized; triggers
  arriving mid-decision coalesce into one follow-up, which keeps the first waiting trigger's name
  (so `decision.trigger` names *a* cause, not necessarily the last). Event listeners schedule
  triggers with `setImmediate`; they never run a decision synchronously inside `append`. The tick
  is a safety net: every state change that frees a lane or adds work wakes a Decision itself.
- **Parallel by default.** One Decision claims every admissible waiting job that has room: N free
  lanes and N admissible jobs → N claims in that Decision, N executors started at once (the
  runner never awaits one job before starting the next). A source sync ingests every new item in
  one pass, so they reach the same Decision; the source's claim report (label, comment) runs off
  the decision path and never gates a start. A question frees its lane in the transaction that
  parks the job; `question.asked` wakes the Decision that hands the lane to the next waiting job,
  while the answer pipeline runs. The only things that keep an admissible job waiting:
  - the **lane cap** — `maxLanes` per machine (the machine instance's `lanes` option, default 4), scaled down
    past the usage soft limit, 0 at the hard limit (hold `all lanes busy (cap N)` / `usage …`);
  - **router mode `active`**: no advice yet, or advice that holds (`ask_human`, `stop_retry`,
    `reuse_cache`) — the router speaking first is the point of active mode; shadow (the
    default) never holds;
  - a **native hold** (no online machine runs the executor; pinned machine unknown/offline);
  - a resumed job **pinned** to the machine holding its pane (`resumeOn`).
  Nothing else orders jobs against each other: no per-source, per-repo or per-author cap, no
  one-claim-per-tick. GitHub calls inside one source sync stay serial (GitHub's REST guidance:
  serial requests per client, to stay under secondary rate limits); that delays discovery, never
  a start.
- **Router advice:** on `job.queued`, on every tick, and at startup, the engine calls
  `router.advise(job)` for each waiting job with no `advice` that is not already in its
  in-memory in-flight set — off the decision path. It stores `advice` and emits
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
  every router hold (not only `ask_human`).
- **Cancel:** waiting → `cancelled` at once. Claimed/running → abort the executor's signal;
  the job ends `cancelled`. Terminal → HTTP 409.
- **Restart recovery:** at startup, `claimed` jobs and `running` jobs of idempotent executors
  return to `queued` (`job.requeued`, `attempts` kept); every stored lane not held by a
  reattached job is closed (`lane.closed`, `reason: daemon restart`). Non-idempotent
  executors (herdr-claude): Phase 2 "Recovery at startup".
- **Shutdown:** SIGTERM aborts running executors (reason `shutdown`: external work such as a
  herdr pane is left as it is), waits up to 5 s, closes the store. Nothing is written or
  cleaned up after that; the next start recovers by the rule above.

## Jev

Jev (`~/workbench/jev-src/grok-bot-jev`, Python) is a per-request classifier: TypeSafe's
`system_one` answers intent / reuse_cache / needs_subagent / stop_retry / complexity, and
`route_task` maps that to one action. It has **no notion of machines, lanes, or usage
budgets**, so it cannot be the usage source. job-hopper uses it for what it is: the
**admission and prioritization layer** per job. Usage budgets come from `UsageSource`.

> **Phase 5:** Jev is one **router plugin**, `jev-router` (`src/plugins/router/jev-router/`);
> the `JevAdvisor` port is the `Router` port; `fake` is a test double at that seam
> (`test/support/fake-router.ts`), never configured. Advice no longer has `jevUsed` at top
> level: jev-router puts it in `details.jevUsed`. Mode is the **router mode**
> (`settings.routerMode`, `POST /ui/api/router-mode`). The text below describes the shim.

- `jev-router`: spawns `<python> src/plugins/router/jev-router/jev_shim.py` with JSON on stdin. The shim puts
  the Jev repo on `sys.path`, loads Jev's **own** `config.yaml` (its kill switch is
  honoured), overrides only `mode` (job-hopper's) and `logging.path` (job-hopper's data
  dir), sets `PYTHONDONTWRITEBYTECODE=1`, calls `route_task(state)`, prints the result.
  Nothing is written under the Jev repo. `router.py` imports `typesafe_sdk` at module
  load (via `src.jev_client`); when that package is absent the shim installs a stub module
  in `sys.modules` so the kill-switch path still runs — with Jev enabled the stub raises
  and the call falls back. The shim patches `src.router.load_config` and
  `src.router.resolve_log_path` (the names the router imported) and catches
  `BaseException` (`secrets.py` raises `SystemExit`). Advice from a real router run has
  `source: "jev-router"`; `details.jevUsed` mirrors the router's own `jev_used`. Any failure (missing `typesafe_sdk`, missing
  `TYPESAFE_API_KEY`, timeout 10 s, bad JSON) → advice `{ action: proceed_full, source:
  fallback, details: { jevUsed: false }, reason: "jev unavailable: …" }` — the router's own documented
  safe fallback.
- Job → Jev state: `goal` ← `spec.goal`, `kind` ← `spec.kind`, plus `spec.meta` keys
  `cached_artifact`, `cached_note`, `prior_error`, `same_error_count`, `sources_found`,
  `constraints`.
- `fake` router (test double): deterministic, no network, mirrors the router's precedence from job
  metadata: bypass marker → `proceed_full` (jevUsed false); `meta.cached_artifact` →
  `reuse_cache`; `meta.prior_error` and `same_error_count >= 1` → `stop_retry`; kind
  `lookup` → `run_deterministic`; `chat` → `chat_only`; `account` → `ask_human`;
  `meta.needs_subagent` → `allow_subagent`; `research`/`browser` → `research_capped`; else
  `proceed_full`.
- **Mode** (router mode) is job-hopper's, persisted in the store (`settings.routerMode`),
  initialised from `JOB_HOPPER_ROUTER_MODE` (default `shadow`), switched at runtime in the UI
  (`POST /ui/api/router-mode`).

## HTTP API

> **Superseded in part by Phase 3:** every `POST`/`PUT`/`DELETE` route in this table is
> removed (404); jobs come from job sources, mutations go through `/ui/api/*` behind a UI
> session. The `GET` routes stand. See "Phase 3 — the hopper pulls".

Loopback only (`127.0.0.1`), no auth — see profile. JSON everywhere; errors are
`{ error: string }` with 400/404/409.

| method | path | body / query | returns |
|--------|------|--------------|---------|
| GET | `/api/health` | | `{ ok, version, routerMode, router, fallback, executors, uptimeS }` (phase 5) |
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
| GET | `/api/router` | | `{ mode, router, plugin, fallback, reason? }` (phase 5; was `GET /api/jev`) |
| GET | `/api/plugins` | | `PluginsReport` (phase 5): roles, config, router instance + selection + detection + fallback, every plugin |
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
src/plugins/index.ts    createPluginHost(o: { pluginDir; pluginsFile; dataDir; clock; logger; routerMode();
                          jobSourceContext?; machineContext?; defaultAnswerer?; defaultAssessor?; defaultExecutors?;
                          kit?; builtins?; intervalMs? }): PluginHost
                          — start(), stop(), router (live), routerStatus(), answerer(), assessor(), executors(),
                            jobSources(), machines(), usageSources(), report(), reload()
src/plugins/migrate.ts  ensurePluginsFile(o: { pluginsFile; env; answerTimeoutMs; logger }) → kept | migrated | default
                        builtinInstances(configDir) — the sections an absent section means
src/executors/index.ts  createTestExecutor(): Executor
                        createExecutorRegistry(executors: Executor[]): ExecutorRegistry
src/machines/index.ts   createLocalMachineSource(o: { maxLanes: number; executors: () => string[];
                          id?: string; label?: string }): MachineSource
src/usage/index.ts      createFakeUsageSource(clock: Clock): SettableUsageSource  (test double)
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
| `job.prioritized` | v2 `{ advice: Advice, mode, statusAtAdvice }` — emitted once per job, whatever its status when the router answered |
| `job.held` | `{ reason }` — only when the reason changes |
| `job.approved` | `{}` |
| `job.claimed` | `{ attempts, effectivePriority, reason }` |
| `job.started` | `{ attempts }` |
| `job.progressed` | `{ progress, message? }` — at most one per job per 500 ms |
| `job.finished` | `{ result }` |
| `job.failed` | `{ error }` |
| `job.cancelled` | `{ reason }` |
| `job.requeued` | `{ from, reason: "daemon restart" }` |
| `job.reattached` | `{ reason: "daemon restart" }` — restart recovery kept a running job running on its lane (Phase 2 "Recovery at startup") |
| `job.reprioritized` | `{ from, to, reason }` — phase 3, source re-sort |
| `lane.opened` | `{}` |
| `lane.closed` | `{ reason }` — the lane plan's reason, `drained`, or `daemon restart` |
| `decision.made` | v2 `{ decisionId, trigger, routerMode, starts, holds, lanes, divergences }` |
| `router.mode_changed` | `{ from, to }` (was `jev.mode_changed`) |

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

Slice 4 of phase 5 removed every part-choosing variable and renamed `JEV_MODE` / `JEV_CHEAP_BOOST`;
the current list is "Settled in slice 4" → "Configuration (env), as of slice 5".

| var | default |
|-----|---------|
| `JOB_HOPPER_HOST` | `127.0.0.1` |
| `JOB_HOPPER_PORT` | `4790` |
| `JOB_HOPPER_DB` | `~/.local/share/job-hopper/job-hopper.db` |
| `JOB_HOPPER_TICK_MS` | `2000` |
| `JOB_HOPPER_JEV_MODE` | `shadow` (initial router mode only; the stored setting wins once set) |
| `JOB_HOPPER_LOCAL_LANES` | `4` |
| `JOB_HOPPER_SOFT_LIMIT` / `HARD_LIMIT` | `0.7` / `0.95` |
| `JOB_HOPPER_JEV_CHEAP_BOOST` | `10` |
| `JOB_HOPPER_WEBHOOK_BASE_MS` | `1000` |
| `JOB_HOPPER_LANE_IDLE_GRACE_MS` | `5000` |

---

# Phase 2 — Claude in herdr, and questions (2026-10-02)

## Directories added

| dir | owns | must not import |
|-----|------|-----------------|
| `src/executors/herdr/` | `herdr-claude` executor: herdr CLI client (port + real adapter), screen protocol parser, pane lifecycle | engine, http, store, questions |
| `src/questions/` | the question pipeline: `QuestionService` (answer → assess → risk rules → accepted or human; timers, recovery), risk rules, rules-file loader, the fake doubles at the `Answerer`/`Assessor` seams. The answerer and assessor themselves are plugins (`src/plugins/`, phase 5 slice 2) | engine internals, http, executors, plugins |

## herdr-claude executor

Job: `executor: "herdr-claude"`, payload
`{ prompt: string (required, non-empty), cwd?: string (absolute or ~; default config
JOB_HOPPER_CLAUDE_CWD), model?: string, expectedMs?: number, timeoutMs?: number }`.

**herdr session.** job-hopper owns the named session of the herdr-claude instance's `session` option
(default `job-hopper`), run headless by its own unit `job-hopper-herdr.service`
(`herdr --session job-hopper server`). Every herdr call is `herdr --session <s> …`, JSON on
stdout, errors JSON on stderr with exit 1. Never the default session — herdr's own doctrine
forbids driving a user's session from outside it. Spawned processes get an environment with
`CLAUDECODE` and every `CLAUDE_CODE_*` variable removed.

**Lanes → panes.** One herdr workspace labelled `job-hopper` (found by label, else created
`--no-focus`). One **tab per job run**, created with `--cwd <job cwd>` and labelled
`<laneId> · <jobId first 8>`; its root pane hosts Claude. The executor keeps `laneId →
paneId` for the job now on that lane and saves `{ session, workspaceId, tabId, paneId,
agentName, cwd }` with `ctx.saveState` the moment the pane exists. A job in
`waiting_answer` keeps its pane ("parked") while its lane is freed; on resume the lane it
is claimed onto maps to the parked pane.

**Start.** `agent start jh-<jobId first 8> --kind claude --pane <pane> --timeout 60000 --
<JOB_HOPPER_CLAUDE_ARGS> [--model <payload.model>]`, default args
`--dangerously-skip-permissions`. **Readiness wait:** herdr refuses `agent start` until the new pane is at its shell
prompt, answering `agent_pane_busy` ("agent target pane … is not an available shell") when
it is sent a few ms after `tab create` — seen live with 4 jobs claimed at once. The CLI
client maps that code to `paneBusy`; the executor retries `agent start` every 100 ms on
exactly that code until the 60000 ms start deadline, then fails the job
(`pane … never reached its shell prompt`). Any other error fails at once. **One pane per
lane:** the executor refuses to map a pane already held by another lane (job `failed`,
pane left untouched). `agent_not_ready` (blocked at startup): read the visible
screen; if it is Claude's folder-trust dialog (contains `trust this folder`) **and the
dialog names the job's cwd** and `JOB_HOPPER_TRUST_WORKDIR` is true → send `down enter`,
log it via progress message `trusted workdir <cwd>`, wait for `idle`. Anything else blocking
startup → `failed` with the screen text.

**Prompt, once.** `agent prompt <agent> <prompt + protocol footer>` (no `--wait`). Footer:

```
[job-hopper protocol] When you need an answer from the user, ask exactly one question and end your message with a line containing only: JOB_HOPPER_QUESTION
When the job is completely finished, end your final message with a line containing only: JOB_HOPPER_DONE
If the job cannot be done, end with a line containing only: JOB_HOPPER_FAILED followed by the reason.
```

**Monitor** every `JOB_HOPPER_HERDR_POLL_MS` (1000): `agent get` (status, `state_change_seq`)
and `agent read --source recent-unwrapped --lines 200`.

**Turn anchor (B1).** At every send record `{ seq: state_change_seq, anchor }` (saved in
`job.executorState.turn` with `blockedAtSend`, before the prompt, so a restarted daemon can
watch the same turn) where
`anchor` is the last line of what was sent as Claude echoes it — the footer's last line
(`If the job cannot be done, …`) on the first turn, the answer's last line on a resume.
Only output lines **after the last occurrence of the anchor** count. **Every** outcome
below except `blocked`, agent gone and timeout requires status `idle`/`done` **and**
`state_change_seq` greater than at send. Marker normalisation: strip the Claude Code gutter
(`●`, `⎿`), whitespace, and surrounding `` ` `` / `*`; `JOB_HOPPER_DONE` and
`JOB_HOPPER_QUESTION` must then equal the whole line; `JOB_HOPPER_FAILED` is a prefix match
(after the anchor only). Parser tests cover: a wrapped echoed footer, the previous turn's
marker still on screen, a marker in backticks or bold. Then:

| observed | outcome |
|----------|---------|
| marker line `JOB_HOPPER_DONE` is the last marker (whole line, trimmed) and status idle/done | `finished`, result `{ summary: <assistant text of the final turn, ≤ 4000 chars>, paneId }` |
| last marker `JOB_HOPPER_FAILED` | `failed`, error = text after the marker on that line or the next line |
| last marker `JOB_HOPPER_QUESTION` | `question`, `detectedBy: marker`, text = the assistant message before the marker |
| status `blocked` (question/approval UI) | `question`, `detectedBy: blocked`, text = the visible dialog |
| idle/done with no marker after the anchor for `JOB_HOPPER_IDLE_QUESTION_MS` (20000) | `question`, `detectedBy: idle`, text = last assistant message ("stopped waiting for input") |
| agent gone (`agent get` error / pane closed) | `failed`, `claude exited` + last output |
| `timeoutMs` (default 3600000) exceeded | interrupt, `failed` `timed out` |

Marker matching: a line equal to the marker after trimming whitespace and the `●`/`⎿`
gutter. The prompt echo contains the markers mid-line only, never as a whole line.
Progress: on change of the last non-empty assistant line, `ctx.progress(min(0.9,
elapsed / expectedMs), line)` (`expectedMs` default 600000).

**Resume** (`resume(ctx, answer)`): `agent get` the saved agent; gone → `failed` `pane lost`.
If `blocked` → `send-keys esc` first. `agent prompt <agent> <answer>`; then the same monitor.

**Cancel** (`ctx.signal`, reason `'cancel'`): `send-keys esc`, then `ctrl+c` twice, then
`pane close`; outcome `failed` `aborted`. **Shutdown** (reason `'shutdown'`): return
`failed` `shutdown` at once, pane untouched (the engine discards outcomes during shutdown).
**cleanup(job)**: same exit-and-close from `job.executorState`; swallow errors; idempotent.
The executor is `idempotent: false`. `timeoutMs` and the `expectedMs` progress clock apply
per `run`/`resume` call; time spent waiting for an answer does not count.

## Questions

Lifecycle: executor returns `question` → engine, in one tx: question created (`open`, `tier` =
`QuestionService.firstStage()`: the configured answerer's instance name, or `human` with none),
job `waiting_answer` + `questionId`, `resumeOn` = its machine, lane idle (or closed if
draining), events `question.asked`.

**Visible and answerable at once.** From that commit on, the question is in `GET /api/questions`
(every open question, whatever its stage) and the job in `/api/queue` `waitingAnswer`; the UI
refreshes both on `question.asked` and shows the answer box at every stage, not only `human`.
The owner may answer while the answerer drafts or the assessor assesses: his answer wins, the
in-flight stage call is aborted (`superseded`), the assessor is never called, and nothing is
pushed. **Push is gated:** the source's question report (issue comment) and the Grok Bot routine
webhook fire only on `question.escalated {target: "human"}` — after the assessor escalates, a
stage fails, or a risk rule hits. Worst case between ask and push: the answerer's and the
assessor's stage timeouts back to back (`2 × JOB_HOPPER_ANSWER_TIMEOUT_MS`, 6 min by default). Then `QuestionService.handle(questionId)` runs the
pipeline off the decision path (phase 5 slice 2 replaced the opus → fable → human chain; full
contract in "Question pipeline" under Phase 5):

1. **answer** — `question.escalated {target: <answerer>}`; the answerer drafts
   `{ answer, confident, reason }`. No answerer, an error, a timeout, a malformed draft or
   `confident` not `true` → human; the assessor is not called.
2. **assess** — `question.escalated {target: <assessor>, reason: "drafted by <answerer>"}`; the
   assessor returns `{ escalate, reason }`. Fails closed: anything but a schema-valid
   `escalate: false` → human.
3. **risk rules** over question + draft; a hit → human, whatever the assessor said.
4. **accepted** → the draft is the answer. **human**: question `tier: human`,
   `escalatedToHumanAt`, `expiresAt = now + JOB_HOPPER_HUMAN_TIMEOUT_MS`,
   `question.escalated {target: "human", reason, text, jobId, goal, answerUrl, notifyCount: 1}`.
   Every `JOB_HOPPER_HUMAN_RENOTIFY_MS` while open: same event, `renotify: true`,
   `notifyCount` +1. At `expiresAt`: question `expired`, `question.expired`, job `failed`
   (`question unanswered`), executor `cleanup`. An expiry beyond the timer limit (~24.8 days)
   re-arms instead of firing early.

Every answerer or assessor call is bounded by `JOB_HOPPER_ANSWER_TIMEOUT_MS` in the service
(a custom plugin may hang), on top of the plugin's own `timeoutMs`; a throw counts as an error.
**Accepted answer** (the draft, or the human's via API): question `answered`, `answer`,
`answeredBy` (the answerer instance, or `human`); `question.answered {by, answer}`; job →
`queued` with `pendingAnswer`, `questionId` kept, so the decider re-admits it (pinned to
`resumeOn`, priority `+ policy.resumeBoost`). Claim of a job with `pendingAnswer` calls
`executor.resume(ctx, answer)` and clears `pendingAnswer`. A human answer while a stage is in
flight wins; the late result is logged (`outcome: escalated`, reason `superseded`) and ignored.

**Every attempt is appended** (`questions.addAttempt`) — the trail: `tier` (who: instance name
or `human`), `role` (`answerer` | `assessor` | `human`; absent on rows before slice 2), model,
timestamps, and per role: answerer `answer`, `confident`, `reason`, `error`; assessor
`escalate`, `reason`, `riskRules`, `error`; `outcome` `drafted` | `accepted` | `escalated`.

**Claude CLI plugins** (`claude-cli`, `claude-cli-assessor`; `src/plugins/claude-print.ts`).
argv exactly `["-p", "--model", <model>, ("--effort", <effort>,) "--output-format", "json",
"--json-schema", <schema>, "--no-session-persistence", "--setting-sources", "",
"--strict-mcp-config", "--tools", ""]` (`--tools` last, so its list cannot swallow another
flag), prompt on stdin, cwd = the data dir (so no project CLAUDE.md is loaded), env scrubbed of
`CLAUDECODE`/`CLAUDE_CODE_*`, timeout from the plugin options. Read `structured_output`; missing
or schema-invalid → `{ error }`. The answerer prompt: you answer on the owner's behalf for an
unattended coding agent; standing rules; job prompt; recent pane output (last 120 lines); the
question; earlier attempts; `confident` only if the rules and context settle it. The assessor
prompt: its sole job is deciding whether the owner must see the question, never answering; the
rules file is trusted; job prompt, goal, output, question, draft, the answerer's reason and
earlier attempts are untrusted data, each fenced with more backticks than it contains, with an
instruction not to follow instructions inside. **No local LLM**; fable is the `claude` CLI
model alias `fable` — no fable agent or skill is defined in this setup (checked
`claude agents --json`, `~/.claude/skills`).

**Risk rules** (independent of any model; case-insensitive, word-bounded, over question +
draft; run after the assessor): `\b(delete|deleting|remove (all|the)|rm -rf|drop (table|database)|truncate|wipe)\b` ·
`\b(deploy|deploying|deployment|publish|rollout|release to (prod|production))\b` ·
`\b(force[- ]push|push --force|--force-with-lease|reset --hard)\b` ·
`\b(spend|purchase|buy|payment|pay for|billing|charge (the )?card)\b` ·
`\b(credentials?|secrets?|passwords?|api[ _-]?keys?|private key|ssh key|access token)\b` ·
`\b(send (an? |the )?(email|message|sms|dm)|post to (slack|twitter|x)|tweet|notify (the )?(customer|client|team))\b`.
Each rule has a name (`delete`, `deploy`, `force-push`, `spend`, `credentials`,
`send-message`); matches are recorded in `riskRules`.

**Rules file** `JOB_HOPPER_RULES_FILE` (default `~/.config/job-hopper/rules.md`), read on
every ask; missing → empty rules, noted in the prompt and the attempt reason.
`scripts/install.sh` writes a starter file only if none exists.

**Atomicity (B3).** Every QuestionService write is one `store.tx`, compare-and-set on
`status === 'open'` and (stage results) `tier` = the producing stage; `onAnswered` /
`onExpired` run synchronously inside it. The engine's side is compare-and-set too: it acts
only if the job is `waiting_answer` with that `questionId`.

**Question budget (B6).** At most `JOB_HOPPER_MAX_QUESTIONS` (5) questions per job; the
next question fails the job `too many questions` (and cleans up). When `detectedBy` is
`idle`, the answerer prompt says the agent may simply have finished and that a valid answer
is "If the job is complete, end your message with JOB_HOPPER_DONE".

**Recovery at startup (B2, B3).** `install.sh` restarts the daemon, not `job-hopper-herdr`,
so a running job's pane and Claude outlive a restart.
- `running` job of a non-idempotent executor (herdr-claude) **reattached** when its lane row
  still holds it and `executor.canReattach(job)` says its work is alive — for herdr-claude:
  `executorState` has a `turn` and `agent get <agentName>` answers for the saved `paneId`.
  Probed before the recovery tx (herdr calls). In the tx: the job stays `running` with its
  `laneId`, its lane is kept (not closed), `job.reattached { reason: "daemon restart" }`.
  After it: `executor.reattach(ctx)` runs the monitor from the saved turn anchor (`seq`,
  `anchor`, `blockedAtSend`) — a turn that ended while the daemon was down is detected on the
  first poll (status idle/done, seq past the send), one in progress is watched; `timeoutMs` and
  the progress clock restart at reattach. No `job.started`; the outcome is recorded as any
  other run's. The decider is unchanged: the kept lane is an ordinary busy lane.
- Same job, work gone (no `turn`, agent gone, pane differs, or the lane row lost) →
  `executor.cleanup(job)`, job `failed` `interrupted by daemon restart`, `job.failed`. Not
  re-run: a second run repeats real side effects. A non-idempotent executor without
  `reattach` always takes this path.
- `claimed` jobs, any executor → requeued (`job.requeued { from: claimed }`), `executorState`
  and `pendingAnswer` kept, nothing closed. The claim → `running` write happens before the
  executor is called, so a claimed job never ran: a fresh claim has no pane; a resume claim's
  pane is its parked pane, which the next resume uses.
- `running` job of an idempotent executor → requeued as before.
- `waiting_answer` jobs, by their question: `open` → leave it (QuestionService.recover
  restarts every open non-human question at the answer stage, whatever its `tier`, and re-arms
  human timers; a human question past `expiresAt` expires now; one created at `human` but never
  announced goes to the human now); `answered` → requeue with that answer; `expired`/`cancelled`/missing → job `failed`,
  `cleanup`.
- `pendingAnswer` is cleared in the same tx that records the resume's outcome (not at claim),
  so a restart mid-resume does not lose the answer; a herdr-claude job mid-resume is
  `running` and follows the first two rules (its resume turn is the saved `turn`).

**Cancel** of a `waiting_answer` job: question `cancelled`, `executor.cleanup`, job
`cancelled`.

## Decider changes

`waiting_answer` jobs are in neither `waiting` nor `running`, hold no lane, and are not
inputs. A waiting job with `pendingAnswer`: effective priority `+ policy.resumeBoost` in
both modes; pinned to `job.resumeOn ?? spec.machineId`; router holds do not apply to it (the
job was already admitted once) — it is never re-held for the router.

## API additions

| method | path | returns |
|--------|------|---------|
| GET | `/api/questions?status=open\|answered\|expired\|cancelled\|all&limit=100` | `{ questions: Question[] }` newest first, default `open` |
| GET | `/api/questions/:id` | `Question` (with attempts) · 404 |
| POST | `/api/questions/:id/answer` | body `{ answer: string (non-empty) }` → `Question` · 404 · 409 not open |

`POST /api/jobs` with `executor: "herdr-claude"` validates the payload above.

**Events and triggers (B5).** Going to `waiting_answer` is announced by `question.asked`
(subject `jobId`; no separate job event); resuming appends `job.requeued { from: "waiting_answer", reason: "answered" }`; expiry
appends `question.expired` **and** `job.failed`. `question.asked`, `question.answered`,
`question.expired` are engine triggers (a lane freed or a job requeued is decided at once).
The events table gains a `question_id` column (migration 2).
`GET /api/queue` `counts` gains `waiting_answer`; `/api/queue` gains `waitingAnswer: Job[]`.

## Events added

| type | `data` |
|------|--------|
| `question.asked` | `{ questionId, text, detectedBy }` (event `jobId`, `questionId` set) |
| `question.escalated` | `{ questionId, target: <stage>, reason, text, jobId, goal?, answerUrl?, notifyCount?, renotify? }` — v2: `target` is the answerer's or assessor's instance name, or `human` (v1: `"opus"\|"fable"\|"human"`) |
| `question.answered` | `{ questionId, by: <answerer instance>\|"human", answer }` — v2 (v1: `by` from `opus\|fable\|human`) |
| `question.expired` | `{ questionId, after_ms }` |

## Configuration added (env)

Removed in phase 5 slice 4 except the answer timeout, rules file, human timers, resume boost and max
questions; each part's setting is now a plugin option ("Settled in slice 4").

| var | default |
|-----|---------|
| `JOB_HOPPER_EXECUTORS` | `test,herdr-claude` |
| `JOB_HOPPER_HERDR_BIN` | `herdr` |
| `JOB_HOPPER_HERDR_SESSION` | `job-hopper` |
| `JOB_HOPPER_HERDR_POLL_MS` | `1000` |
| `JOB_HOPPER_CLAUDE_BIN` | `claude` |
| `JOB_HOPPER_CLAUDE_ARGS` | `--dangerously-skip-permissions` |
| `JOB_HOPPER_CLAUDE_CWD` | `~/workbench/app-workflows` |
| `JOB_HOPPER_TRUST_WORKDIR` | `true` |
| `JOB_HOPPER_IDLE_QUESTION_MS` | `20000` |
| `JOB_HOPPER_ANSWERER` | `claude` (`fake` for tests: the fake doubles at the seams) |
| `JOB_HOPPER_ANSWER_MODEL_A` / `_B` | `opus` / `fable` — the answerer's / assessor's model when plugins.yaml has no section |
| `JOB_HOPPER_ANSWER_TIMEOUT_MS` | `180000` — plugin `timeoutMs` default from the env, and the service's per-stage ceiling |
| `JOB_HOPPER_RULES_FILE` | `~/.config/job-hopper/rules.md` |
| `JOB_HOPPER_HUMAN_RENOTIFY_MS` | `900000` (15 min) |
| `JOB_HOPPER_HUMAN_TIMEOUT_MS` | `86400000` (24 h) |
| `JOB_HOPPER_RESUME_BOOST` | `20` |
| `JOB_HOPPER_MAX_QUESTIONS` | `5` |

## Construction contract added

```text
src/executors/herdr/index.ts  createHerdrClaudeExecutor(o: { herdr: HerdrClient; clock: Clock;
                                defaultCwd: string; claudeArgs: string[]; trustWorkdir: boolean;
                                pollMs: number; idleQuestionMs: number }): Executor
                              createHerdrCliClient(o: { bin: string; session: string }): HerdrClient
src/questions/index.ts        createFakeAnswerer(o: { name; model?; script: (req, signal) => AnswerDraft | { error } }): Answerer
                              createFakeAssessor(o: { name; model?; script: (req, draft, signal) => Assessment | { error } }): Assessor
                              createQuestionService(o: { store: Store; clock: Clock;
                                answerer: () => Answerer | undefined; assessor: () => Assessor;
                                stageTimeoutMs: number;
                                rulesFile: string; renotifyMs: number; humanTimeoutMs: number;
                                answerUrl: (id: string) => string;
                                onAnswered: (q: Question) => void;   // engine: requeue with pendingAnswer
                                onExpired: (q: Question) => void }): QuestionService
                              riskRules(text: string): string[]
```

`HerdrClient` is defined in `src/executors/herdr/client.ts` (the executor's own port; the
real adapter shells out, the fake simulates a Claude screen). `QuestionService` is the interface in `src/domain/ports.ts`. `main` passes
`onAnswered`/`onExpired` as closures filled in after `createEngine` (breaks the
engine ↔ service cycle).

**Settled reading of "map lanes to panes":** one tab per job run, labelled with its lane;
the lane→pane map is in the executor's memory and in `job.executorState`. After a resume on
another lane the tab label is stale; the job's `laneId` is authoritative.

## Test executor additions

Op `ask`: `{ op: "ask", message?: string }` → outcome `question` (text = `message` ??
"Which option?", `detectedBy: "test"`), saveState `{ asked: true }`. `resume(ctx, answer)` →
`finished` `{ answer }`; resume on a job whose payload op is `fail-after-answer` → `failed`.

## Settled in phase 2 (2026-10-02)

- **Construction, as built:** `createEngine` also takes `questions`, `maxQuestions`,
  `keepPanes`; `createServer` takes `questions`; `startApp(config, seams?)` accepts
  `{ herdr?, executors? }` for tests (production passes nothing). The engine starts after
  `server.listen` so `answerUrl` carries the real port. `/api/health` lists `executors`.
- **`job.requeued`** `data.from`/`reason` also take `waiting_answer` / `answered`.
- **Panes close on every terminal outcome** (finished, failed, cancelled, restart failure)
  via `executor.cleanup`, unless `JOB_HOPPER_KEEP_PANES=true`. Timeouts and failed startups
  close their pane too.
- **herdr unit:** a second `herdr --session X server` exits 1, so
  `job-hopper-herdr.service` has an `ExecCondition` that skips the start when that
  session's server already runs; it unsets `CLAUDECODE` and the `CLAUDE_CODE_*` markers
  because panes inherit the server's environment. `install.sh` never restarts an active
  herdr unit — that would kill every parked pane.
- **Answerer schema is a literal draft-07 object.** zod's `toJSONSchema` stamps `$schema`
  draft 2020-12, which the claude CLI rejects ("no schema with key or ref"); every tier then
  exits 1 and every question reaches the human. Found live; the unit tests' fake `claude`
  could not see it.
- **Screen chrome** that is never progress: the status/spinner line, user echo, `⏵` mode
  line, the effort indicator (`… · /effort`), and spinner tips (`⎿  Tip: …`).
- **The fake doubles** (`JOB_HOPPER_ANSWERER=fake`, tests only; slice 2 policy): answerer
  `opus` drafts `fake opus answer`, confident unless the question says "unsure"; assessor
  `fable` escalates when it says "risky" or "hard"; real risk rules still apply.
- **Models read the job's goal label.** In the demo both tiers cited a goal reading "chain
  to human". Goals are context the models weigh; write them as plain descriptions.
- **Fable is the `claude` model alias `fable`** — no fable agent or skill exists in this
  setup.

---

# Phase 3 — the hopper pulls (2026-10-02)

Direction: **nothing posts jobs to the hopper; it pulls them.** No inbound mutation API
remains. The only mutations are the owner's actions in the local UI, behind a UI session.

## Directories added

| dir | owns | must not import |
|-----|------|-----------------|
| `src/sources/` | `JobSource` adapters (`github`), the GitHub API port + `gh` CLI adapter + in-memory fake, the sync loop; since slice 4 the GitHub sources' option schemas (`config.ts`, was the `sources.yaml` loader) and their factories (`compose.ts`), reached through the job-source plugins | engine internals (uses the narrow `SourceHost` it is given), http, plugins |
| `src/events/` | versioned payload schemas (zod) per event type, the envelope, JSON Schema export | everything but `domain/` and `zod` |
| `src/http/ui/` | UI session: login codes, session cookie, CSRF, origin/host guard, the UI-only mutation routes | engine internals beyond the engine's public commands |

`src/webhooks/` gains the `webhooks.yaml` loader + reconciler.

## Removed (no compatibility shims)

`POST /api/jobs`, `POST /api/jobs/:id/cancel`, `POST /api/jobs/:id/approve`,
`POST /api/questions/:id/answer`, `POST /api/webhooks`, `DELETE /api/webhooks/:id`,
`PUT /api/jev`, `PUT /api/usage/fake`, and `scripts/demo.ts` (it pushed jobs). Any request
to a removed route is 404. The fake usage source stays (static 0 %); tests set it through
the engine.

## Read-only API (unchanged unless noted)

`GET /api/health` · `/api/jobs` · `/api/jobs/:id` · `/api/queue` · `/api/machines` ·
`/api/decisions[/:id]` · `/api/events` · `/api/events/stream` (SSE) · `/api/router` (was `/api/jev`) ·
`/api/usage` · `/api/questions[/:id]` · `/api/webhooks` (from `webhooks.yaml`, secrets
omitted, plus `config: { path, loadedAt, error? }`) · `/api/webhooks/deliveries` ·
**new** `GET /api/sources` → `{ sources: SourceStatus[] }`.

Every request (GET included) must carry `Host: 127.0.0.1:<port>` or `localhost:<port>`;
anything else is 421 — DNS-rebinding guard.

SSE adds non-domain `event: source.updated` (`data: SourceStatus`), like `delivery.updated`.

## UI session and mutations

Same-origin plus a CSRF token alone does not stop another local process: it can fetch the
token and send any `Origin`. Cookies are no better here: they ignore ports, so a cookie for
`127.0.0.1` is sent to every server on `127.0.0.1`, any user's. So (consultant B8):

1. **Login code.** At startup and after every use the daemon writes a fresh random code
   (32 bytes, hex) to `<dataDir>/ui-login-code`, mode `0600`.
2. **`scripts/open-ui.sh`** reads the code and writes `<dataDir>/ui-login.html` (mode
   `0600`): a page that auto-submits a form `POST http://127.0.0.1:<port>/ui/login` with the
   code in the body. It opens that **file** with `xdg-open`, so only a file path, never the
   code, appears on any command line (`/proc` is readable by every user).
3. **`POST /ui/login`** (form body `code`; Origin may be `null` — the code is the
   credential) — constant-time compare; on match: create a session (random 32-byte token,
   expiry `JOB_HOPPER_UI_SESSION_HOURS`, default 12), rotate the code, and answer with a
   same-origin HTML page whose inline script stores the token in `localStorage`
   (`jh_session`) and goes to `/`. Mismatch → 403. `localStorage` is scoped to the exact
   origin incl. port, so no other server on `127.0.0.1` can read it. Sessions live in memory
   (a restart logs the UI out).
4. **`GET /ui/api/session`** with header `x-jobhopper-session` → `{ authenticated,
   expiresAt? }`. Without a valid session the page is read-only and says how to log in:
   `bash ~/.local/lib/job-hopper/scripts/open-ui.sh`.
5. **Mutations** — `POST` only, JSON body, all of: header `x-jobhopper-session` = a live
   session token (constant-time); `Origin` exactly `http://127.0.0.1:<port>` or
   `http://localhost:<port>`; `Sec-Fetch-Site`, when present, `same-origin`;
   `content-type: application/json`. The custom header is the CSRF defence (a cross-site
   page cannot set it or read the token). Any failure → 403 `{ error }`, logged.

| method | path | body | effect |
|--------|------|------|--------|
| POST | `/ui/api/jobs/:id/cancel` | `{}` | engine `cancel(id, "cancelled in UI")` (the source is told) |
| POST | `/ui/api/jobs/:id/approve` | `{}` | engine approve |
| POST | `/ui/api/questions/:id/answer` | `{ answer }` | `QuestionService.answerByHuman` (404/409) |
| POST | `/ui/api/router-mode` | `{ mode }` | set router mode (phase 5; was `/ui/api/jev`) |
| POST | `/ui/api/logout` | `{}` | drop the session |

**Residual risk, stated.** Still able to act or read:
- A process running **as the owner** that reads `ui-login-code`/`ui-login.html` or the
  browser profile's `localStorage`. That includes Claude jobs running with
  `--dangerously-skip-permissions`.
- Every local user can **read** the GET API, which exposes prompts, issue context and job
  environment.

Blocked: other OS users acting, any web page (cross-site, DNS rebinding via the Host
guard), and local processes that do not deliberately read job-hopper's or the browser's
files.

## Job sources

`JobSource` port (`src/domain/ports.ts`). The **sync loop** (`createSourceSync`) runs per
source every `pollSeconds`:

1. `discover()` → for each item whose `key` has no job, or whose newest job is re-runnable
   (see **Re-run** below): create one via the host's
   `ingest(item)` — spec `{ executor: item.executor, payload: { prompt, cwd, model?, env },
   priority, goal: title, submittedBy: "<source>:<author>", kind: "coding" }`; `item.invalid`
   or a payload the executor rejects → job created and failed in one tx (`job.queued` +
   `job.failed`); for items that already have a job: `host.reprioritize(jobId,
   item.priority, item.priorityReason)` (re-sort; applies only to queued/held),
   `source: JobSourceRef`, with `payload.prompt = item.prompt`, `payload.env = item.env` —
   then `report({kind:'claimed'})`, merge the returned patch into
   `sourceState`. A key whose newest job is not re-runnable → skip (the host's `ingest` guard).
2. `check(active)` for this source's non-terminal jobs → `cancel` signal → engine cancel
   (reason recorded); `answer` signal → `QuestionService.answerByHuman(questionId, answer)`
   (ignored if not open).
3. **Outbound reports** are event-driven and retried: on `job.progressed` (throttled to one
   per `progressCommentSeconds` per job), the **first** `question.escalated {target: human}`
   of a question (re-notifies are ignored — one question comment per question),
   `question.answered`, `job.finished`, `job.failed`, `job.cancelled` for a job with a
   `source`, call `report(...)`. Reports for one job are serialized (a per-job promise
   chain). The returned `source` state replaces `sourceState.source` via
   `host.setSourceState` in a tx that re-reads the job. `sourceState.sync` (owned here)
   records `claimReported`, `reportedQuestions: string[]`, `finalReported`, `cancelReason`.
   **Retry scan** each sync: claim not reported; open human-tier questions not reported;
   terminal jobs (finished/failed/cancelled) whose final report did not go out — so a crash
   right after a job ends still reports. A `SourceError` with `permanent: true` marks the
   report done-with-error (status `detail.permanentErrors`) and is never retried.
4. Status → `SourceStatus` (state, last sync, last error, counts, detail) → `/api/sources`,
   SSE `source.updated`.

**Re-run.** A source key may have many jobs; `jobs.source_key` is an index, not unique, and
`getBySourceKey` returns the **newest** (`created_at`, then `seq`, descending). An item whose
newest job is `failed` or `cancelled` **and** whose end was reported (`sourceState.sync.finalReported`,
so the source's marker — `hopper:failed` on GitHub — was written at least once) gets a new job
when the source offers it again. The GitHub source stops offering an issue while `hopper:failed`
is present, so removing that label is the re-run gesture, and a leftover `hopper:claimed` does not
block it (the old job makes the key known). Unreported, the item stays one attempt, so a failing
label write cannot loop. `finished` is never re-run. Predicate: `isRerunnable` in
`src/domain/types.ts`. The key spans sources: an old `github` job and a `github-app` re-run share it.

A source error never stops the daemon or other sources; it is shown in status and retried.

## GitHub source

Config `~/.config/job-hopper/sources.yaml` (`JOB_HOPPER_SOURCES_FILE`), validated with zod;
invalid → the source is `error` with the message, nothing is pulled.

```yaml
version: 1
github:
  enabled: true
  pollSeconds: 60
  owners: []            # discover across repos owned by these; empty → the `gh` user
  repos: []             # allowlist: when non-empty, ONLY these owner/repo are acted on
  authors: [owner]
  label: hopper
  priorityLabels: { "hopper:p0": 100, "hopper:p1": 75, "hopper:p2": 50, "hopper:p3": 25 }
  defaultPriority: 50
  repoPaths: {}         # owner/repo → local path (cwd); default defaultCwd
  defaultCwd: ~/workbench/app-workflows
  executor: herdr-claude
  model: null           # optional claude model for jobs
  progressCommentSeconds: 300
  recentComments: 10    # comments passed into the job's context
  projects: {}          # per repo, optional — see "Priority"
  # projects:
  #   owner/job-hopper-sandbox:
  #     owner: owner
  #     number: 3
  #     mode: field         # field | rank
  #     field: Priority     # field mode: single-select or number field name
  #     map: { P0: 100, P1: 75, P2: 50, P3: 25 }   # single-select option → priority
```

**Priority** (the owner, phase 3 addition). Both sources are supported, configurable per repo;
**when both are present, the project wins**:

1. Project (repos listed under `projects`): the issue's item in that Projects (v2) board.
   - `mode: field` — a single-select value mapped through `map`, or a number field used
     directly (clamped 0..100).
   - `mode: rank` — the item's position in the project's item order:
     `priority = max(0, 100 − index)`, so the top item is 100.
   - Read with `gh project item-list <number> --owner <owner> --format json --limit 1000
     --query "is:issue is:open"`; field keys come back lowercased, so the configured field
     name matches case-insensitively; rank counts only eligible items. That needs
     the `read:project` token scope. Without it, or on any project error, the source falls
     back to labels and shows the error in status `detail.projectErrors`. It never blocks.
2. Labels: the highest matching `priorityLabels` value.
3. `defaultPriority`.

`priorityReason` records which one applied, e.g. `project:Priority=P1`, `project:rank=2`,
`label:hopper:p0` or `default`. **Re-sorted on every poll:** discovery recomputes the
priority of every eligible item. When a waiting (`queued`/`held`) job's priority changed,
the sync loop updates it and emits `job.reprioritized { from, to, reason }`, then
triggers a decision. Running jobs keep their priority.

**Full issue context into the job** (the owner, phase 3 addition). The prompt is the issue
body, then a block:

```
[job-hopper issue context]
repo: owner/repo · issue: #N · url: …
title: …
labels: a, b · author: owner
priority: 75 (label:hopper:p1) · project item: <project title> · Priority=P1 (or "none")
recent comments (oldest first, up to recentComments; only allowlisted authors, no hopper-marked comments — anyone else's text never reaches the job):
- <author> at <ISO>: <body, ≤ 1000 chars>
...
[how to report on your issue]
Your issue is $HOPPER_ISSUE_URL (repo $HOPPER_REPO, number $HOPPER_ISSUE_NUMBER).
To comment on it: gh issue comment "$HOPPER_ISSUE_NUMBER" -R "$HOPPER_REPO" --body "$(printf '%s\n%s' "$HOPPER_COMMENT_MARKER" "<your text>")"
Always start your comments with $HOPPER_COMMENT_MARKER. job-hopper posts your status, questions and result for you.
Do not close this issue and do not use "Closes #N" — closing the issue cancels you.
```

Size caps: body ≤ 64 000 chars, context block ≤ 16 000 chars (comments truncated to fit).

Job environment, set on the job's herdr tab with `herdr tab create --env`:
- `HOPPER_ISSUE_URL`, `HOPPER_REPO`, `HOPPER_ISSUE_NUMBER`, `HOPPER_ISSUE_TITLE`
- `HOPPER_COMMENT_MARKER` = `<!-- job-hopper v1 kind=job-comment -->`
- `HOPPER_JOB_ID`, added by the herdr-claude executor from `ctx.job.id`

The herdr-claude payload gains `env?: Record<string, string>`: keys must match
`^[A-Z_][A-Z0-9_]*$`, values contain no newline. The marker matters because the job
comments as the owner: the answer detector skips marked comments, and a job is paused (Claude
idle) while it waits for an answer anyway.

**GitHubApi port** (`src/sources/github/api.ts`) — the adapter's seam: `whoami()`,
`projectItems(owner, number)` → `{ url (issue url), index, fields: Record<string, string |
number> }[]` (throws `missing read:project scope` distinctly),
`searchOpenIssues({ owners, label })`, `listOpenIssues(repo, label)`, `getIssue(repo,
number)` → `{ state, labels, author, title, body, url, updatedAt }`,
`listComments(repo, number)` → `{ id, author, body, createdAt, url }[]`,
`ensureLabel(repo, name, color, description)`, `addLabels`, `removeLabels`,
`comment(repo, number, body)` → `{ id, url, createdAt }`, `editComment(repo, id, body)`.
Real adapter: `gh` CLI via `execFile` (no shell), JSON output, `gh api` for comments/labels,
timeouts, typed errors; env passes through (gh's keyring auth). Fake: an in-memory GitHub
(issues, labels, comments, authors) used by unit and integration tests.

**Discovery:** `repos` non-empty → `listOpenIssues` per repo (no search lag). Else
`searchOpenIssues` over `owners` (or `whoami()`), restricted to repos owned by them —
GitHub search can lag new issues by up to about a minute. Eligible: open, has `label`,
author in `authors`, no `hopper:done` / `hopper:failed`, repo allowed. Already-claimed
issues with no job here (another machine, a wiped database) are **not** re-run: an issue
labelled `hopper:claimed` with no local job is skipped and shown in status detail.

**Item → job:** key = issue URL; title → goal; prompt = body + issue context (above); env as
above; empty body → claimed, then failed with error "empty issue body"; priority per
"Priority"; cwd = `repoPaths[repo]` (expanded) else `defaultCwd`.

**Write criteria (owner decision, 2026-10-03: the bot does not post to issues)** The
hopper's only issue writes are labels (state) and one completion comment. Nothing else: no
claim, progress, question, answered, failure or cancel comment; no reactions, issue edits,
closes, or PR comments. Jobs get no way to write to their issue (no token, no helper), and their
prompt says nothing about commenting (owner direction: the job does not talk on the
issue): the issue context block ends at the comments list, with no footer. A question goes to the owner through the UI and the Grok Bot routine
webhook, never onto the issue; a reply on the issue is not an answer.

The completion comment starts with a hidden marker line
`<!-- job-hopper v1 kind=finished job=<jobId> -->` (older hopper comments carry the same
`<!-- job-hopper v1 ` prefix, so the context filter still drops them). Before posting, the
adapter lists comments and reuses one already carrying the identical marker (idempotent
retries). Bodies are sent on stdin (`gh api … -X POST --input -`), never argv, and truncated to
60 000 characters with a "(truncated)" note (GitHub's limit is 65 536).

| report | on GitHub |
|--------|-----------|
| claimed | ensure labels `hopper:claimed`, `hopper:done`, `hopper:failed` exist (`gh label create --force`, once per repo per process); add `hopper:claimed`. **No comment** |
| finished | **the one comment**, one fixed line of hopper facts: `job-hopper: finished (job <first 8 of id>, <startedAt→finishedAt, e.g. 4m12s>)`. No result, no summary, no model-written text; remove `hopper:claimed`, add `hopper:done` |
| failed | **no comment**; remove `hopper:claimed`, add `hopper:failed` (removing it is the re-run gesture) |
| cancelled | **no comment**; remove `hopper:claimed` |

Progress and questions are not reported to the source at all (`SourceReport` has no such kinds).
Stored `sourceState.source` keys from before this rule (`claimCommentId`, `progressCommentId`,
`questionComments`, `answeredComments`) and `sourceState.sync` keys (`reportedQuestions`,
`answeredQuestions`, `lastProgressAt`) stay in the JSON and are never read; no column changed, no
migration. `progressCommentSeconds` left `sources.yaml`: `migrate-sources-yaml.ts` (install) dropped
its lines; since phase 5 slice 4 the daemon's plugins-file migration drops the key instead (that
script is gone).

A failure never goes to the issue as text. It is one stderr line in the daemon log
(`job-hopper: job <id> failed (<issue url>): <error>`, `src/engine/failure-log.ts`), the job's
`error` in `/api/jobs`, and the `job.failed` row (with its error) in the UI event feed.

**Signals (check):** per active job, `getIssue`:
- issue `closed`, or `label` removed → `cancel` (reason `issue closed` / `label removed`);
  issue 404/410 → `cancel` (`issue gone`). Jobs are told not to close their own issue.
- **Error classes:** `GitHubApi` errors carry `permanent` (404/410/403/422) vs transient
  (network, 5xx, rate limit, timeout); `check` turns a permanent error on one job into the
  `issue gone` cancel and never fails the whole sync for it.

**Authors outside the allowlist are never acted on** — not as issues, not as answers.

## Webhooks from a file

`~/.config/job-hopper/webhooks.yaml` (`JOB_HOPPER_WEBHOOKS_FILE`):

```yaml
version: 1
webhooks:
  - name: grok-bot
    url: http://127.0.0.1:4795/hook
    events: ["question.escalated", "job.finished", "job.failed"]   # or ["*"]
    secret: "<hex>"              # or secretFile: ~/.config/job-hopper/grok-bot.secret
    active: true
```

Loaded at startup and re-read when its mtime changes (checked every 5 s). Reconcile by
`name` into the store (`upsertByName`; names absent from the file are deleted, their
pending deliveries failed). Invalid file → previous subscriptions kept, error shown in
`GET /api/webhooks` `config.error`. Inline `secret` in a file readable by group/other →
loaded, with a warning in `config.warnings`. Signing, retries, backoff, delivery log: as
phase 1.

## Versioned event payloads

Every event — stored, SSE, `/api/events`, webhook body — is the envelope:

```json
{ "schemaVersion": 1, "seq": 1, "id": "uuid", "type": "job.queued", "at": "ISO",
  "jobId": "…", "laneId": "…", "machineId": "…", "decisionId": "…", "questionId": "…",
  "data": { … } }
```

`schemaVersion` is the version of **that type's** payload schema. `src/events/schemas.ts`
holds one zod schema per event type (`data`) plus the envelope, and `EVENT_SCHEMA_VERSIONS`
(all `1` today). `npm run schemas` writes `docs/schemas/envelope.v1.json` and
`docs/schemas/<type>.v1.json`, and `docs/events.md` documents each type. Tests: every
`EVENT_TYPES` entry has a schema; committed JSON Schema files equal a fresh export;
**every event emitted during the integration suite validates** against its schema. A
breaking payload change bumps that type's version and adds `<type>.v2.json`; the old file
stays as documentation of what older consumers received.

Migration 3: `events.schema_version` (existing rows → 1), `jobs.source_key` (nullable;
`CREATE UNIQUE INDEX` — SQLite cannot `ADD COLUMN … UNIQUE`), the webhooks table's `name`
(existing rows get `legacy-<id>` first, then the unique index; they are removed at the first
reconcile since no file names them). `EVENT_SCHEMA_VERSIONS` lives in `src/domain/types.ts`
(the store stamps it; `src/events/` imports it). Payload schemas are **strict** (unknown
keys rejected) so an undeclared field fails the conformance test; additive changes keep the
version, removals/renames/retypes bump it. `job.requeued.reason` is a free string. Events
stored before phase 3 read as v1 and are not re-validated (stated in `docs/events.md`).
Migration 5 drops that unique index and recreates `jobs.source_key` as a plain index (re-run); jobs are untouched.
A shared test helper (`test/support/conformance.ts`) subscribes to the event log and
validates every event a test emits.

## Configuration added (env)

`JOB_HOPPER_SOURCES_FILE` and `JOB_HOPPER_GH_BIN` were removed in phase 5 slice 4 (sources.yaml
folded into plugins.yaml `jobSources`; the gh bin is github-gh's `bin` option).

| var | default |
|-----|---------|
| `JOB_HOPPER_SOURCES_FILE` | `~/.config/job-hopper/sources.yaml` |
| `JOB_HOPPER_WEBHOOKS_FILE` | `~/.config/job-hopper/webhooks.yaml` |
| `JOB_HOPPER_GH_BIN` | `gh` |
| `JOB_HOPPER_UI_SESSION_HOURS` | `12` |

## Construction contract added

```text
src/sources/index.ts   createGitHubSource(o: { name: string; config: GitHubSourceConfig;
                         api: GitHubApi; clock: Clock }): JobSource
                       createGhCliApi(o: { bin: string; timeoutMs?: number }): GitHubApi
                       createFakeGitHub(o?): FakeGitHub  (implements GitHubApi + test helpers)
                       loadSourcesFile(path): { github?: GitHubSourceConfig } | { error }
                       createSourceSync(o: { sources: JobSource[]; host: SourceHost; clock: Clock;
                         pollMs: (s) => number }): SourceRegistry & { start(); stop(): Promise<void>; syncNow(name?) }
                       SourceHost — the interface in src/domain/ports.ts (ingest, cancel, answer,
                         reprioritize, setSourceState); the engine implements it
src/events/index.ts    EVENT_SCHEMAS, ENVELOPE_SCHEMA, EVENT_SCHEMA_VERSIONS, validateEvent(e) → { ok } | { ok:false, issues }
                       exportJsonSchemas(): Record<filename, object>
src/webhooks/config.ts loadWebhooksFile(path), createWebhookConfigWatcher(o: { path; store; clock; intervalMs })
src/http/ui/index.ts   registerUiRoutes(app, o: { engine; questions; port: () => number; dataDir; clock; sessionHours })
                       (port is a getter: known only after listen)
main.ts                startApp(config, seams?) — seams { herdr?, executors?, github?: GitHubApi,
                         sources?: JobSource[], webhookConfigIntervalMs? } for tests only

Engine changes (T008): `cancel(id, reason)` (reason no longer hard-coded); `ingest`,
`reprioritize`, `setSourceState` implementing SourceHost; `job.reprioritized` joins the
decision TRIGGERS; `src/ui/app.js` learns `job.reprioritized`.
```

## Settled in phase 3 (2026-10-02)

- **Claude Code can leave its transcript scrolled up** after a long prompt (an issue body
  plus context): the reply and its marker sit below the viewport behind `N new message
  (ctrl+End) ↓`. The monitor detects the indicator, sends Ctrl+End as raw text
  (`herdr pane send-text <pane> ESC[1;5F` — herdr has no key name for it) and reads again
  before judging. Found live: it had produced false `idle` questions whose text was the
  indicator, posted to the issue.
- **Screen chrome, full list:** status/spinner line (`✻ ✶ ✳ ✢ ✽`), plain-glyph spinner frames
  (`· Symbioting… (20s …)`), `(ctrl+b to run in background)`, the new-message indicator, user
  echo, `⏵` mode line, effort indicator, spinner tips. Each was found live; expect more after
  a Claude Code upgrade.
- **`job.queued.data.source`** carries the job's `JobSourceRef` (top level of `data`).
- **Tests drive jobs through sources**: a test-only manual `JobSource` plus a `scripted`
  executor that reads `{"op": …}` from the first prompt line (so a fake GitHub issue body
  drives the same ops); every integration test checks event conformance on stop.
- **The daemon unit runs with `PrivateTmp=true`**, so a `/tmp` path in `sources.yaml` /
  `webhooks.yaml` (e.g. `secretFile`) is invisible to it. Keep referenced files under
  `$HOME`. The herdr unit has no `PrivateTmp`, so job working directories under `/tmp` work.
- **Projects priority is unverified live**: the `gh` token lacks `read:project`; the source
  falls back to labels and reports `projectErrors`. Rank mode assumes `gh project item-list`
  returns project order — check when the scope exists.

---

# Phase 4 — a GitHub App instead of gh-as-the owner (2026-10-03)

The `gh` source acts as the owner: its comments are his, so a hidden marker was the only way to
tell them from his replies, and it sees every repo he can see. A GitHub App fixes both: it
posts as its own bot, and **its installations are the repo allowlist**. Polling stays — no
inbound webhook to the laptop.

## Directories added

| dir | owns | must not import |
|-----|------|-----------------|
| `src/sources/github/app/` | the App `GitHubApi` adapter: app config file loader, JWT + installation tokens (`@octokit/auth-app`), REST + GraphQL via `@octokit/request`, per-repo scoped token minting | engine, http, store |
| `scripts/create-github-app.*` | the manifest-flow helper the owner runs once | everything in `src/` except small pure helpers it imports explicitly |

## App configuration (files the owner's one click produces)

`~/.config/job-hopper/github-app.json` (mode 600):

```json
{ "version": 1, "appId": 123456, "slug": "job-hopper-owner",
  "botLogin": "job-hopper-owner[bot]", "clientId": "Iv23…",
  "htmlUrl": "https://github.com/apps/job-hopper-owner",
  "owner": "owner", "privateKeyFile": "~/.config/job-hopper/github-app.pem",
  "webhookSecretFile": "~/.config/job-hopper/github-app-webhook.secret",
  "createdAt": "ISO" }
```

`github-app.pem` and `github-app-webhook.secret`, both mode 600. The client secret the
conversion returns is **not stored** (nothing uses it). The webhook secret is stored for a
later optional webhook; the app's webhook is created **inactive** and nothing listens.

## The App GitHubApi adapter

`createGitHubAppApi({ appFile, baseUrl?, clock })`:
- Reads `github-app.json` and the PEM, then `createAppAuth({ appId, privateKey, request })`.
  - JWT (RS256, ≤ 10 min) for `GET /app/installations`.
  - Installation tokens (cached by the library, refreshed before expiry) for everything else.
- `listInstalledRepos()`: every installation → `GET /installation/repositories` (paginated)
  → `owner/repo`. The installation id is kept per repo for later calls.
- Issues: `GET /repos/{o}/{r}/issues?labels=<label>&state=open&per_page=100` (paginated,
  pull requests skipped), `GET /repos/{o}/{r}/issues/{n}`.
- Comments: paginated, oldest first. Create, edit, labels add/remove, label create (422
  "already_exists" → ok).
- `projectItems(owner, number)`: GraphQL `projectV2(number)` items with field values.
  - Tried as `organization(login)`, then `user(login)`.
  - GitHub Apps can read **organization** Projects (v2) with `organization_projects: read`.
    **Projects (v2) owned by a personal account cannot be read with an installation token**
    (GitHub's docs: user-owned projects need a personal token). the owner's repos are
    user-owned, so in app mode priority comes from labels. A project lookup failure still
    falls back to labels with `projectErrors`. `organization_projects: read` stays in the
    manifest because the directive asks for project read, and it is what enables project
    priority for any org-owned repo.
- `botLogin()` = config `botLogin`. `whoami()` = the same.
- `mintRepoToken(repo)`: `auth({ type: 'installation', installationId, repositoryNames:
  [repoName], permissions: { issues: 'write' }, refresh: true })`. `refresh: true` matters:
  the library caches installation tokens for 59 min, so without it a refresh hands back the
  same token, about to expire (B2).
- **Cold installation lookup (B6):** on a repo whose installation id is not cached, it calls
  `GET /repos/{o}/{r}/installation` with the JWT. A 404 is a permanent "app not installed on
  <repo>".
- `searchOpenIssues` throws a permanent error. App mode never searches (B7).
- Errors → `GitHubApiError` with the phase-3 classification (401 from a bad key → permanent,
  message names the app config).

## Source changes (one GitHub source, two identities)

The `github` source logic is reused for both adapters. Differences are driven by the API's
optional methods:

| | gh adapter (`github`) | App adapter (`github-app`) |
|---|---|---|
| repos scanned | `repos` allowlist, else search over `owners` | `listInstalledRepos()`; if config `repos` is non-empty, the intersection. Empty → `[]` and `detail.setup = "install the app: <installUrl>"`, **never** a search (B7) |
| hopper's own comments | first line matches the marker | **author == `botLogin()`**, or the marker (secondary) |
| a human answer | first comment after the question, allowlisted author, no marker | first comment after the question, allowlisted author, **author ≠ bot**, no marker |
| job comments | `gh issue comment` (as the owner) with `$HOPPER_COMMENT_MARKER` | `"$HOPPER_COMMENT_CMD" "<text>"` (as the app) |

`isHopperComment(c)` = `(botLogin && c.author === botLogin) || hasMarker(c.body)`. It is
used for context filtering and answer detection. **Comment reuse on retry** (app mode)
requires author == bot **and** the same marker: a stranger planting a marker comment can
never be "reused", which would end in a 403 edit (N2). Config refuses an `authors` list
containing the bot login. Hopper comments still carry the marker line.

**Names and detail fields (B4), fixed now:**
- App source: name and kind `github-app`.
- gh source: name `github`, kind `github`. `source.ts` takes `kind` from its options.

| field | app | gh |
|-------|-----|----|
| `mode` | `app` | `gh` |
| `slug`, `htmlUrl`, `installUrl` (`https://github.com/apps/<slug>/installations/new`), `configUrl` (`https://github.com/settings/installations`) | yes | — |
| `installedRepos` (string[]) | yes | — |
| `setup` (what the owner must do next, or absent) | yes | — |
| `appError` (app file unreadable or key rejected) | yes | — |
| `enabledSetting` (`auto`/`true`/`false`) | — | yes |
| `paused` (reason, when paused) | yes | yes |
| phase-3 fields (`authors`, `label`, `repos`, `projectErrors`, `repoErrors`, `checkErrors`, `permanentErrors`, `skippedClaimedWithoutJob`) | yes | yes |

**Enablement.** `sources.yaml` gains `githubApp:` (same keys as `github:` minus `owners`,
plus `appFile`). `github.enabled` becomes `auto | true | false`, default `auto`. `auto`
means enabled exactly when no app config file exists, **checked on every sync**. So creating
the app switches new pulls from gh to the app with no restart. Mechanism (B3): both sources
are always constructed unless set to `false`, and each has `paused()`. Paused, a source only
checks and reports its own active jobs. The gh source pauses while `auto` and the app file
exists. The app source pauses while the file is missing or unreadable, with
`detail.setup: "run bash ~/.local/lib/job-hopper/scripts/create-github-app.sh"`. It starts
on its own once the file appears, and re-reads it when its mtime changes (so a `--force`
recreate needs no restart).

**the owner's live file (B1).** The installed `~/.config/job-hopper/sources.yaml` says
`enabled: true` (phase-3 starter). `install.sh` rewrites that exact starter line
(`  enabled: true              # false: pull nothing from GitHub`) to `enabled: auto` once
and says so. Any other value is left alone with a printed warning. The phase-4 starter
writes `auto` and a `githubApp:` block.

## Jobs comment as the app — the per-job token file

**Removed 2026-10-03** (write criteria, "GitHub source"): no token keeper, no job token files, no
`hopper-comment`, no `HOPPER_COMMENT_*` / `HOPPER_TOKEN_*` / `HOPPER_GITHUB_API` env. Jobs get
`HOPPER_ISSUE_URL`, `HOPPER_REPO`, `HOPPER_ISSUE_NUMBER`, `HOPPER_ISSUE_TITLE` as read-only
context. The text below is the history of what was built.

A job must comment on its issue as the app without holding the app's private key, because
the key can mint tokens for every installed repo. The source's **token keeper** handles it:
- On `claimed` it mints `mintRepoToken(repo)`: one repo, `issues: write` only. It writes
  `<dataDir>/job-tokens/<sha256(issueUrl)[0..16]>.json` as
  `{ "version": 1, "token", "expiresAt", "repo": "owner/repo", "issue": <number> }`.
  - The directory is 700 (chmod again if it already exists).
  - The file is written 600 to a temp name with `O_EXCL`, then renamed into place.
  - A failed mint never fails the claim report. The next refresh retries.
- `refresh(activeJobs)`, called from `check()`: mints for any active job whose file is
  missing or has under 15 min left, and **deletes orphan files** (no active job of this
  source). This is how terminal jobs' files go away (B5).
- It also deletes the file on the final report.
- `<dataDir>` is `~/.local/share/job-hopper`, outside the daemon's `PrivateTmp` and readable
  by the herdr panes.

The path is deterministic from the issue URL, so it is in the job's env at ingest:

| env | value |
|-----|-------|
| `HOPPER_ISSUE_URL`, `HOPPER_REPO`, `HOPPER_ISSUE_NUMBER`, `HOPPER_ISSUE_TITLE` | as phase 3 |
| `HOPPER_COMMENT_MARKER` | as phase 3 (secondary identification) |
| `HOPPER_TOKEN_FILE` | the job's token file (App source only) |
| `HOPPER_COMMENT_CMD` | `~/.local/lib/job-hopper/scripts/hopper-comment` (App source only, absolute path) |
| `HOPPER_GITHUB_API` | API base URL (default `https://api.github.com`; tests point it at a fake) |
| `HOPPER_TOKEN_WAIT_MS` | how long `hopper-comment` waits for the token file (default 30000; tests) |
| `HOPPER_JOB_ID` | added by the herdr executor |

**`hopper-comment`** (`scripts/hopper-comment`, a bash wrapper running
`scripts/hopper-comment.ts` with Node): `hopper-comment "text"` or text on stdin.
- Reads `HOPPER_TOKEN_FILE`, waiting up to 30 s for it to appear. Refuses an expired token,
  saying so, and refuses a file whose `repo`/`issue` differ from `HOPPER_REPO` /
  `HOPPER_ISSUE_NUMBER`.
- `POST {HOPPER_GITHUB_API}/repos/{HOPPER_REPO}/issues/{HOPPER_ISSUE_NUMBER}/comments` with
  body `HOPPER_COMMENT_MARKER + "\n" + text`, truncated to 60 000 chars.
- Prints the comment URL. Exit 0 on success, 1 on any failure (message on stderr).
- Node built-ins only.

The App source's context block replaces the `gh issue comment` instruction with: "To comment
on your issue: `"$HOPPER_COMMENT_CMD" "<your text>"` (posts as the job-hopper app). **Never
comment with `gh`**: it posts as the owner, and a comment from him after a question reads as
his answer." (N5: panes are still logged in to `gh` as the owner.)

**Residual, stated:** the token file is readable by any process running as the owner, for at
most about an hour, and covers only that repo's issues. That is far narrower than the gh
source, whose job comments ran on the owner's full `gh` login.

## The manifest-flow helper (`scripts/create-github-app.sh`)

`bash ~/.local/lib/job-hopper/scripts/create-github-app.sh [--name <app-name>] [--owner
<login>] [--no-webhook] [--force]` runs `scripts/create-github-app.ts`:

1. Refuses if `github-app.json` exists (unless `--force`).
2. Starts an HTTP server on `127.0.0.1:<random port>` and generates a random `state`.
3. Serves `/` (the start page): a form that auto-submits `POST
   https://github.com/settings/apps/new?state=<state>` with field `manifest`. The manifest
   is shown below.
4. Opens `http://127.0.0.1:<port>/` with `xdg-open`, and prints it too (with a `qrencode`
   QR if available — this is a desktop page, the QR is a convenience).
5. GitHub shows the owner the prefilled "Create GitHub App" page. He clicks the create
   button; GitHub redirects to `http://127.0.0.1:<port>/callback?code=…&state=…`.
6. The callback checks `state` (mismatch → 400, nothing stored) and runs
   `POST https://api.github.com/app-manifests/{code}/conversions` (unauthenticated, code
   valid for 1 h).
7. It writes the files (umask 077, temp file + rename, refuses symlinks; a null
   `webhook_secret` → no secret file and `webhookSecretFile: null`). `slug`, `botLogin`
   (`<slug>[bot]`) and `htmlUrl` come **from the conversion response**, never from the
   manifest name: names are global and at most 34 characters, so the owner may have renamed it on
   GitHub's page. It answers with a page holding the **install link**
   `https://github.com/apps/<slug>/installations/new`. The script prints the same link and
   exits 0.
   - The local server rejects any request whose `Host` is not `127.0.0.1:<port>` (DNS
     rebinding) and accepts the callback once only (N4).
8. It times out after 15 min (exit 1, nothing written).

Manifest:

```json
{ "name": "job-hopper-<owner>",
  "url": "https://github.com/<owner>",
  "description": "Pulls jobs for job-hopper on the owner's laptop from issues labelled hopper.",
  "hook_attributes": { "url": "https://example.invalid/job-hopper-webhook", "active": false },
  "redirect_url": "http://127.0.0.1:<port>/callback",
  "public": false,
  "default_permissions": { "issues": "write", "metadata": "read", "organization_projects": "read" },
  "default_events": [] }
```

- `issues: write` now covers only labels and the one completion comment (write criteria). The
  app could later drop to fewer permissions; not changed here.

- `hook_attributes` exists only to make GitHub issue a webhook secret for later. The URL uses
  the reserved `.invalid` TLD and the hook is inactive, so nothing is ever delivered.
  `--no-webhook` omits it, in case GitHub refuses the placeholder.
- Contents permission: **not requested**. Jobs work on local clones, and the hopper never
  reads repo contents through the API.
- `--org <name>` posts to `https://github.com/organizations/<name>/settings/apps/new`
  instead (as built; `--owner` only sets the owner login used in the name and homepage).
- `privateKeyFile` / `webhookSecretFile` are written as absolute paths.

Base URLs are overridable (`JOB_HOPPER_GITHUB_WEB`, `JOB_HOPPER_GITHUB_API`) so tests run the
whole flow against a fake GitHub. `--no-open` skips `xdg-open`.

## the owner's clicks (also in the summary)

1. Run `bash ~/.local/lib/job-hopper/scripts/create-github-app.sh`. The browser opens on
   GitHub's "Create GitHub App for owner" page, prefilled.
2. Click **Create GitHub App for owner**. The browser returns to `127.0.0.1` with
   "App created" and an **Install** link; the terminal prints the same link.
3. Click the link → **Install** → **Only select repositories** → pick the repos → **Install**.
   (A private app owned by owner installs only on owner's own account.)
4. Nothing else: within one sync (60 s) the `github-app` source shows `ok` with the
   installed repos, and the `gh` source stops discovering (auto). Restarting is not needed.

To add or remove repos later: https://github.com/settings/installations → job-hopper →
Configure.

## Configuration added

`sources.yaml`:
```yaml
github:
  enabled: auto            # auto | true | false — auto: on only while no GitHub App is configured
  # … phase-3 keys …
githubApp:
  enabled: true            # still needs ~/.config/job-hopper/github-app.json (create-github-app.sh)
  appFile: ~/.config/job-hopper/github-app.json
  repos: []                # optional extra restriction inside the installations
  authors: [owner]
  label: hopper
  priorityLabels: { "hopper:p0": 100, "hopper:p1": 75, "hopper:p2": 50, "hopper:p3": 25 }
  defaultPriority: 50
  repoPaths: {}
  defaultCwd: ~/workbench/app-workflows
  executor: herdr-claude
  model: null
  progressCommentSeconds: 300
  recentComments: 10
  projects: {}
```
A `sources.yaml` without `githubApp:` gets these defaults, so the owner's existing file works
unchanged.

## Construction contract added

```text
src/sources/github/app/index.ts  loadGitHubAppFile(path) → { ok: true, app } | { ok: false, reason: 'missing' | string }
                                 createGitHubAppApi(o: { appFile: string; baseUrl?: string; clock: Clock }): GitHubApi
                                   & { appStatus(): { ok: true; slug; botLogin; htmlUrl } | { ok: false; reason } }
                                   (lazy: reads the file on first use; a missing file → permanent GitHubApiError 'no app configured')
                                 createFakeGitHubServer(o) — node:http fake of the endpoints above + JWT/installation
                                   token verification, for tests (test/support or src/…/app/fake-server.ts)
src/sources/github/tokens.ts     createJobTokenKeeper(o: { dir: string; api: GitHubApi; clock: Clock }) →
                                   { pathFor(issueUrl): string; ensure(job): Promise<void>; refresh(jobs): Promise<void>; drop(job): void }
src/sources/github/source.ts     createGitHubSource(o: { …phase 3…, name, kind, mode: 'gh' | 'app', paused?: () => string | undefined,
                                   tokens?: JobTokenKeeper, commentCmd?: string, apiBase?: string })
src/sources/sync.ts              honours JobSource.paused() (T004)
main.ts seams                    AppSeams.githubApp?: GitHubApi (tests) beside .github
```

## Settled in phase 4 (2026-10-03)

- **Composition:** `src/sources/compose.ts` (`composeSources(o)`) builds both GitHub sources
  from `sources.yaml`. `scripts/migrate-sources-yaml.ts` is install's sources step: it writes
  the starter when the file is absent, and migrates the phase-3 starter line to `auto`.
- **`appFile` default:** `github-app.json` next to `sources.yaml` (the same
  `~/.config/job-hopper/github-app.json` once installed; tests never see the real one).
- **`JOB_HOPPER_GITHUB_API`** (env, optional) is the API base for the App adapter, the manifest
  helper and the jobs' `HOPPER_GITHUB_API`. One name for one concept. `createGitHubAppApi`
  takes `clock` as well.
- **Pause rules, as built:**
  - gh pauses (`GitHub App configured`) only while `githubApp.enabled` is true and the app
    file is readable. With the app source set to `false`, gh keeps running.
  - The app source pauses only on a missing or unreadable app file. An invalid file or a
    rejected key still syncs, so the error shows in `appError`/`lastError` and is retried.
- **Bot in `githubApp.authors`:** refused at startup when the app file loads (the source shows
  `error`), otherwise at discover.
- **Invalid `sources.yaml`:** both GitHub sources show `error`. A missing file: `githubApp`
  defaults, waiting for the app file.
- **Bot-author identity in answers and context is defence in depth.** Config refuses the bot
  in `authors`, so the author allowlist already excludes bot comments there. A reviewer
  mutation removing the bot check therefore survives as an equivalent mutant. Where bot
  identity is load-bearing — comment reuse (author is bot **and** marker) — the
  planted-marker test pins it.
- **Switch latency:** with the default `pollSeconds: 60`, the gh→app switch happens within
  one poll of `github-app.json` appearing.

## Grok Bot routine webhook

The built-in notifier plugin `grokbot-routine` (`src/plugins/notifier/grokbot-routine/`, since
phase 5 slice 5) POSTs to a Grok Bot routine (https://cursor.com/help/grok-bot/routines) when a
question reaches the owner (questions never go onto the issue). Not a **Webhook subscription**: no store row, no
schema change, no domain event; in-memory only.

- Events: questions only — `question.escalated` with `data.target === 'human'` and not
  `data.renotify`. Never `job.finished` or `job.failed`.
- Config: the instance's `envFile` option (plugins.yaml `notifiers:`; the built-in `grok-bot`
  instance's is `grokbot-webhook.env` beside plugins.yaml), `GROKBOT_WEBHOOK_URL=` and `GROKBOT_WEBHOOK_KEY=`, parsed with `util.parseEnv`. Read at
  each matching event, so a file created later applies without a restart.
  Absent: silent no-op. Present but missing a variable or unreadable: one warning
  per event, skipped. Mode readable by group/other: one warning per process.
- Request: `Authorization: Bearer <key>`, JSON body `{ source: 'job-hopper', kind, at, jobId,
  issueTitle, issueUrl, question, questionId, answerUrl? }` (title/url from the job's source
  ref, else null).
  200 = a run started.
- Delivery: 10 s timeout; 3 attempts, backoff `base * 2^(n-1)` (base 1000 ms), retried only on
  network error, 429, 5xx; other non-2xx is final. Success logs kind, jobId, status; final
  failure logs an error. The key is never logged. Work runs deferred, off the event listener;
  `stop()` unsubscribes and awaits in-flight posts.
- `createGrokBotNotifier({ name, path, logger, baseMs?, timeoutMs? })` → `Notifier`; the job's
  title and url come from `events.job(id)`. `AppSeams.grokbotBaseMs` lets tests shorten the backoff.

`JOB_HOPPER_GROKBOT_WEBHOOK_FILE` was this section's env var; removed in slice 5 ("Settled in slice 5").

## Phase 5 — every part is a plugin (2026-10-03, in progress)

Owner direction (owner decision, 2026-10-03): the **router** (Jev) decides admission; **Fable
assesses questions** — it decides whether a question escalates to the owner, nothing else.
Every part is broken out as a **plugin**: any piece can be swapped, writing a custom plugin is
easy, and the choices offered come from what is detected on the machine. Consultant-reviewed
(approve-with-changes, all changes folded in below). Glossary terms land with the slice that
introduces them in code.

### Roles, plugins, instances

A **role** is a slot the engine calls through one port. A **plugin** implements one role. A
**plugin instance** is a plugin plus validated options, under a name.

| role | port | slots | built-in plugins | reload |
|---|---|---|---|---|
| `router` | `Router { name; advise(job) → Advice }` (was `JevAdvisor`) | 1 | `jev-router`, `pass-through` | live |
| `answerer` | `Answerer { name; answer(req, signal) → { answer, confident, reason } }` | 0..1 | `claude-cli` | live |
| `assessor` | `Assessor { name; assess(req, draft, signal) → { escalate, reason } }` | 1 | `claude-cli-assessor`, `always-escalate` | live |
| `executor` | `Executor` (unchanged) | 1..n | `herdr-claude`, `test` | restart |
| `job-source` | `JobSource` (unchanged) | 0..n | `github-gh`, `github-app` | restart |
| `machine-source` | `MachineSource` (unchanged) | 1 | `local` | restart |
| `usage-source` | `UsageSource` (unchanged) | 0..n | none in production; `fake` stays a test fake at the `ports.ts` seam | restart |
| `notifier` | `Notifier { name; start(events); stop() }` (new) | 0..n | `grokbot-routine` | restart |

A new agent CLI (codex, cursor-agent, opencode, hermes — all present on server) is a new
`executor` plugin; nothing is generic over CLIs.

**Not plugins — invariants:** the decider, store, engine loop, HTTP guard and UI session, the
event log, **webhook subscriptions** (`webhooks.yaml` stays: a core subsystem with stored
deliveries and signing, not a swappable part), the **risk rules** (`src/questions/risk.ts`,
code, not config — no setting can weaken the guard), the **rules file** (the owner's standing
rules, given to answerer and assessor), and the human as the last question stop.

### Question pipeline

1. The answerer (if configured) drafts: `{ answer, confident, reason }`. Not confident, error,
   or no answerer → straight to the human.
2. The assessor gets the full request (question, job prompt, rules file, previous attempts)
   plus the draft and the answerer's reason, and returns `{ escalate, reason }`.
   **Fails closed:** timeout, error, parse failure or a missing field → escalate. Only an
   explicit, schema-valid `escalate: false` accepts. The question text comes from a job that
   reads issue bodies and runs with `--dangerously-skip-permissions`; it may try to talk the
   assessor out of escalating — the fail-closed contract and the risk rules are the
   containment.
3. Risk rules run on question and draft after the assessor; a hit escalates regardless.
4. Accepted → the draft is the answer (typed into the pane). Escalated → the human.

`claude-cli-assessor` runs with the answerer's lockdown (`--tools ''`, `--strict-mcp-config`,
`--setting-sources ''`, `--json-schema`). Default instances: answerer `opus` (`claude-cli`,
model `opus`), assessor `fable` (`claude-cli-assessor`, model `fable`). `risky` leaves the
answerer contract (judging risk is the assessor's job); it stays optional on stored attempts.

Stage owner: `questions.body.tier` holds the answerer's instance name, the assessor's, or
`human`. Created with the configured answerer's name (or `human` with none) — replacing the
hard-coded `'opus'` in `src/store/questions.ts`. **Recovery** restarts every open non-human
question from the answer stage whatever its `tier` (drafts are not persisted mid-flight; the
cost is one repeated call), so old rows at `tier: fable` (meaning "Fable answering") are safe.

### Plugin contract

A plugin is one ES module — `.ts` run by Node's type stripping (erasable syntax only;
relative imports carry `.ts`) or `.js` — with a default export:

```ts
import type { PluginDefinition } from 'job-hopper/plugin'; // type-only, erased at runtime
export default {
  id: 'always-proceed',
  role: 'router',
  describe: 'Admits every job as proceed_full',
  options: (z) => z.object({ note: z.string().default('') }),
  async detect(sys) { return { status: 'available' }; },
  create(ctx, options) {
    return { name: 'always-proceed', async advise() { return { action: 'proceed_full', reason: options.note || 'always', details: {} }; } };
  },
} satisfies PluginDefinition<'router'>;
```

- **Options are a zod schema** built from the `z` the core passes in (established library:
  zod 4, already a dependency — no hand-rolled validator). The core validates with
  `safeParse` before `create`; `z.toJSONSchema()` renders options in `/api/plugins` and the UI.
  Plugin authors need not import zod.
- **Detection** `detect(sys)` → `available` | `unavailable` + reason | `needs-setup` + the
  command to run. Cheap; never a paid model call; **never executes a GUI binary** (`grokbot`
  is Electron: `which` only). Kit: `which(bin)`, `version(bin, args)` (5 s timeout, CLIs
  only), `exists(path)`, `pythonImports(python, module)`, `env(name)`. Models cannot be listed
  offline: `claude` model options are free strings, with `opus`, `sonnet`, `fable` as
  suggestions. `github-gh` reports `needs-setup` when `gh auth status` fails.
- `create(ctx, options)`: `ctx` = clock, logger, dataDir, the plugin's own scratch dir.
- A plugin can import only `node:` builtins unless it ships its own `node_modules` in its
  directory.

### Where plugins live, and loading

- Built-in: `src/plugins/<role>/<id>/index.ts`, listed in `src/plugins/builtin.ts`.
- Custom: `~/.config/job-hopper/plugins/<id>/index.ts` (`JOB_HOPPER_PLUGIN_DIR`), loaded by
  dynamic `import()` at start and on rescan. Same contract and validation. A custom id equal
  to a built-in id is refused. Plugin dir readable by group/other → warning.
- Types for out-of-tree authors: `install.sh` writes `~/.config/job-hopper/plugins/tsconfig.json`
  mapping `job-hopper/plugin` to `<install>/src/plugins/sdk.ts`. `npm run plugin:check <dir>`
  type-checks with that mapping, then runs the real loader and `detect`.
  `examples/plugins/<role>/` holds one minimal runnable plugin per role.

### Configuration — `~/.config/job-hopper/plugins.yaml`

The truth for which instance fills which role. Mode 600, owner-editable, mtime-watched (5 s).
Live roles (router, answerer, assessor) swap between calls; restart roles show
`changed — restart pending` in `/api/plugins`.

```yaml
version: 1
router:    { name: jev, plugin: jev-router, options: { jevSrc: ~/workbench/jev-src/grok-bot-jev, python: python3 } }
answerer:  { name: opus, plugin: claude-cli, options: { model: opus } }
assessor:  { name: fable, plugin: claude-cli-assessor, options: { model: fable } }
executors: [ { name: herdr-claude, plugin: herdr-claude, options: { cwd: ~/workbench/app-workflows } }, { name: test, plugin: test } ]
jobSources:
  - { name: github, plugin: github-gh, options: { enabled: auto, bin: gh, appFile: ~/.config/job-hopper/github-app.json, authors: [owner], label: hopper } }
  - { name: github-app, plugin: github-app, options: { appFile: ~/.config/job-hopper/github-app.json, authors: [owner], label: hopper } }
machines:  { name: local, plugin: local, options: { lanes: 4 } }
usageSources: []
notifiers: [ { name: grok-bot, plugin: grokbot-routine, options: { envFile: ~/.config/job-hopper/grokbot-webhook.env } } ]
```

The `jobSources` options are the old sources.yaml blocks' keys (design "GitHub source", "Phase 4
Configuration added") plus github-gh `bin` and `appFile` (with `enabled: auto` it pauses while that
file is readable; `null`: never) and github-app `apiUrl`. The written file holds every option
explicitly; the example shows a few.

- **Job-source instance names stay exactly `github` and `github-app`**: sync state and
  `jobs.source_key` dedup are keyed by them; a rename would re-pull or drop items.
- `sources.yaml` folds into `jobSources[].options`. Part-choosing env vars are removed (no
  compatibility path); env keeps process settings only — as built, "Settled in slice 4".
- **Migration runs in the daemon, in the slice that removes each input:** on boot with no
  `plugins.yaml`, build it from `sources.yaml` and the current env, write it 600, rename the
  inputs `*.migrated`. Any leftover `JOB_HOPPER_*` var no longer read → a loud boot warning.
  `systemd/job-hopper.service` changes in the same slice.
- **Router mode** (shadow/active) is decider state, not a plugin option: stays live in the
  store, `settings.jevMode` → `routerMode` by store migration; toggled in the UI as today.

### UI and mutation

A **Plugins** panel: per role, the configured instance, its detection status, and every
plugin for that role (built-in and custom) with its detection result; **Rescan**. Each
instance has its own options form, independent of every other instance's: changing one
never touches another's section of `plugins.yaml`.

`POST /ui/api/plugins` (session-guarded) may **select** a detected-available plugin for a
role, enable/disable an instance, or **edit one instance's options** — except its
**command-bearing options**, writing `plugins.yaml` atomically (mode 600). This amends "No
route creates or changes a … setting": plugin selection and option editing join router mode
as UI-session mutations.

**Command-bearing options** (owner decision, owner decision, 2026-10-03, issue #6 option (a)): an
option that names a program, its arguments, a working directory, an interpreter, or a file
that is sourced or executed — `bin`, `args`, `cwd`, `python`, `jevSrc`, `envFile` and their
kind. A plugin marks each in its schema with `.meta({ commandBearing: true })`; zod 4 carries
the mark into `z.toJSONSchema()`, so `/api/plugins` and the UI see it. The UI shows these
read-only; they are edited only in `plugins.yaml`. Why: a UI session is readable by jobs
running with `--dangerously-skip-permissions` (see "UI session and mutations"), and a job
that can rewrite an executor's `cwd`/`args` runs its own commands on the next restart.

An options edit:
- carries `{ role, name, options }` — one instance, its whole options object;
- is refused (409) if any command-bearing value differs from the file's current value
  (compared after parsing both with the plugin's schema), or if the file changed since the
  form was read (`mtime` round-tripped as `version`);
- is validated with the plugin's own schema before the write; invalid → 400 with zod's issues,
  nothing written;
- applies like a file edit: live roles swap between calls, restart roles show `changed —
  restart pending`.

Per piece, in the words of issue #6: "task" is an **executor** instance ("task" is not a
glossary word); "connector" is a **job source** or **notifier** instance; a **lane** has no
options of its own — lane count is the **machine** instance's `lanes` option.

Residual risk: a session holder can still change non-command options — a router's
thresholds, an answerer's model, a source's labels or authors allowlist. Each can change
which jobs are pulled or how a question is drafted; none can run a command, and the
assessor's fail-closed contract and the risk rules (code, not options) still stand.

### Failure

| role | on create failure or unavailable |
|---|---|
| router | `pass-through`; advice `source: fallback`; `/api/health` says `fallback: true` (also while the router's own advice is `source: fallback`) |
| answerer | none → questions go to the assessor-less human path |
| assessor | `always-escalate` (fail safe) |
| executor | jobs naming it `held`, reason `executor <name> unavailable`; never failed or re-routed |
| job source / notifier | dropped; error in `/api/plugins` |

### Persisted-state migrations

Store (`src/store/migrations.ts`) rewrites rows; changed event types bump `schemaVersion`;
stored old events are not rewritten (read raw by version; v1 schemas stay in docs/export).

- `jobs.body.jevAdvice` → `advice` `{ action, reason, details, source, at }`; `jevUsed` →
  `details.jevUsed` (jev-router only). `job.prioritized` v2.
- `decisions.body.jevMode` → `routerMode`; `Decision.jev[]` → `advice[]`, `withJev` →
  `withAdvice`; `decision.made` v2; `divergence` schema to match.
- `settings.jevMode` → `routerMode`; `jev.mode_changed` → `router.mode_changed` v1.
- `DeciderPolicy.jevCheapBoost` → `routerCheapBoost`.
- `AnswerTier`/`ANSWER_TIERS` → `string` (instance names); `question.escalated.target` and
  `question.answered.by` `z.enum` → `z.string()`, v2. Question rows unchanged.

### Slices (each test-first, each lands runnable)

1. **Plugin core through the router** (landed; "Settled in slice 1" below): SDK + contract, registry, loader (built-in + custom),
   detection kit, `plugins.yaml` (router section) + watch, `GET /api/plugins`, `Router` port,
   `jev-router`, `pass-through`, Jev→router renames and store migrations, `/api/health` shows
   fallback. Glossary first.
2. **Questions** (landed; "Settled in slice 2" below): answerer + assessor roles, pipeline,
   fail-closed assessor, recovery.
3. **Executors** as plugins (landed; "Settled in slice 3" below); `EXECUTOR_NAMES` removed; held-when-unavailable.
4. **Job, machine, usage sources** as plugins (landed; "Settled in slice 4" below); `sources.yaml` + env
   migration in the daemon; unit file updated.
5. **Notifier** port + `grokbot-routine` (landed; "Settled in slice 5" below).
6. **Examples + `plugin:check`** + plugin tsconfig from `install.sh`.
7. **UI Plugins panel** + `POST /ui/api/plugins` (select, enable/disable, per-instance option
   editing except command-bearing options) + rescan. Issue #6.
8. **Install on server** (when no herdr-claude job runs) and live verification.

### Settled in slice 1 (2026-10-03)

- **Roles are what exists.** `Role` is `'router'` only; each later slice adds its role to
  `ROLES` (`src/domain/plugins.ts`) with its port. No role is declared before its code.
- **`detect(sys, options)`.** Detection gets the validated options: whether jev-router can run
  depends on its `jevSrc` and `python`. The catalogue in `/api/plugins` detects each plugin
  with its default options (`{}` parsed); a plugin whose options have no defaults shows
  `needs-setup`. The configured instance is detected with its own options.
- **Router context carries the router mode.** `create(ctx, options)` gets
  `ctx.routerMode()` for the router role (`RoleContext` in `sdk.ts`): Jev is told job-hopper's
  mode, as before. Other roles will add their own context fields.
- **Fallback, all paths:** unknown plugin, invalid options, detection not `available`,
  `create` throwing → `pass-through` stands in (advice `source: fallback`, reason `router
  <name> unavailable: …`). A router whose `advise` throws (custom plugins may break the
  contract) → fallback advice for that call. `fallback: true` in `/api/health` and
  `/api/router` while either holds, or while the router's own last advice was `source:
  fallback` (jev-router's shim failing); it clears on the next real advice.
- **plugins.yaml in slice 1** (router part superseded by "Router selection"): no file, or a file without `router` → the env-derived instance
  `{ name: jev, plugin: jev-router, options: { jevSrc: JOB_HOPPER_JEV_SRC, python:
  JOB_HOPPER_PYTHON } }`. An invalid file → the last good router is kept (at start: the
  env-derived one) and the error is in `/api/plugins` `config.error` — the `webhooks.yaml`
  rule. Nothing is written; the daemon-side migration is slice 4. File readable by
  group/other → warning. Unknown top-level keys are refused; the later sections are accepted
  unread.
- **`JOB_HOPPER_JEV_ADVISOR`** (removed by "Router selection") accepted only `router` (the installed unit sets it). `fake` is a
  test double at the `Router` seam (`AppSeams.router`), not a plugin and not configurable.
  `JOB_HOPPER_JEV_MODE` and `JOB_HOPPER_JEV_CHEAP_BOOST` keep their names until slice 4 removes
  part-choosing env; they feed `routerMode` and `routerCheapBoost`.
- **Scratch dir** is `<dataDir>/plugin-data/<id>` — not under the plugin dir, which holds only
  plugin code. jev-router keeps writing `jev-runs.jsonl` in the data dir.
- **Migration 4** (`src/store/migrate-router.ts`, a function migration — the runner now takes
  SQL or a function): `jevUsed` moves into `details.jevUsed` for **every** stored advice
  (fake and fallback rows too), so no field is lost. Decision bodies are renamed including
  the jobs inside `inputs`. Hold reasons and divergence notes already stored keep their old
  text; the next Decision rewrites a held job's reason (`router …`) and emits `job.held`.
- **Superseded payloads stay readable:** `src/events/legacy.ts` keeps `job.prioritized` v1,
  `decision.made` v1 and `jev.mode_changed` v1; `validateEvent` checks an event against the
  schema of its own type and version; the envelope accepts the retired `jev.mode_changed`.
- **Custom plugin ids** match `^[a-z0-9][a-z0-9-]*$`; a second custom plugin with a taken id
  is refused like a built-in collision. A plugin module that throws on import is an error in
  `/api/plugins`, never a boot failure.

### Router selection (issue #7, 2026-10-03)

Owner direction: a router is wanted, configurable from what is on the system and swappable.
The Fable advisor only assesses whether a question escalates.
Fable is the **assessor** (`claude-cli-assessor`, model `fable`);
it never routes. The router was `jev-router` only because the env named it.

Supersedes the slice-1 bullets "plugins.yaml in slice 1" (env-derived router) and
"`JOB_HOPPER_JEV_ADVISOR`":

- **No router named in plugins.yaml** (no file, no `router` section, or an invalid file at
  start) → the host chooses one from what is detected: the first router plugin in catalogue
  order (built-ins in `BUILTIN_PLUGINS` order, then custom) that detects `available` with its
  default options and starts; the instance is named after the plugin (`jev-router`). None →
  `pass-through`, **chosen, not a fallback** (`fallback: false`, advice `source: pass-through`).
  Detection re-runs on every plugins.yaml reload.
- **Named in plugins.yaml** → that instance, exactly; when it cannot run, pass-through stands in
  as a fallback, as before. Swapping is editing the `router` section (live, between calls).
- `/api/plugins` `router.selection` is `file` or `detected`.
- `JOB_HOPPER_JEV_SRC`, `JOB_HOPPER_PYTHON`, `JOB_HOPPER_JEV_ADVISOR` are removed (no
  compatibility path; a set one is ignored). Jev elsewhere than `~/workbench/jev-src/grok-bot-jev`
  → name `jev-router` with `jevSrc` in plugins.yaml. The installed unit no longer sets
  `JOB_HOPPER_JEV_ADVISOR`.
- Picking the router from the UI is slice 7 (`POST /ui/api/plugins` select), unchanged.

### Settled in slice 2 (2026-10-03)

- **Roles:** `ROLES` is `router`, `answerer`, `assessor`. Built-ins `claude-cli` (answerer;
  options `bin` `claude`, `model` `opus`, `timeoutMs` 180000, `effort` optional:
  low|medium|high|xhigh|max → `--effort`), `claude-cli-assessor` (`bin`, `model` `fable`,
  `timeoutMs`), `always-escalate`. Detection: `which bin`, then `<bin> --version`; a failing
  version is `unavailable`. Never a model call.
- **The core validates, never trusts.** The question service parses every draft (`answer`
  string, `confident` boolean, `reason` string) and every assessment (`escalate` boolean,
  `reason` string) with zod. A malformed draft is an answerer error; `{"escalate": "false"}`,
  a missing field, `null`, a string, `{ error }`, a throw or the stage timeout is an assessor
  error — both go to the human. Each call is bounded by `JOB_HOPPER_ANSWER_TIMEOUT_MS` in the
  service (and aborted), whatever the plugin's own timeout.
- **Attempt shape.** One flat `QuestionAttempt`, so old rows type-check: `tier` = who (instance
  name or `human`), new optional `role` (`answerer` | `assessor` | `human`; absent before slice
  2) and `escalate` (assessor), `outcome` gains `drafted`. The draft is appended (`drafted`) in
  the tx that hands the question to the assessor, so the trail shows what was assessed. The
  assessment attempt carries `escalate` (only when schema-valid), `reason`, `riskRules` (the
  risk rules run in its tx) and `error`; its `outcome` is the final one (`accepted` or
  `escalated`). `risky` stays optional, written only by pre-slice-2 rows.
- **Who answered.** `answeredBy` and `question.answered.by` = the answerer instance (it wrote the
  text that was typed); `tier` stays at the assessor (the last stage that held it).
- **Every stage is announced.** `question.escalated.target` = the stage entered: the answerer
  (`reason: asked`, or `restarted after a daemon restart`), the assessor (`drafted by <answerer>`),
  `human`. `question.escalated` and `question.answered` are v2 (`target`/`by` free strings);
  their v1 schemas stay in `src/events/legacy.ts` for stored events.
- **Stage names are unambiguous.** plugins.yaml refuses an answerer or assessor named `human`,
  and the two with one name; the host refuses the same collision when one comes from the env
  (config error, last good instances kept). `answerer: null` = no answerer (questions go
  straight to the human; `/api/plugins` shows `instance: null`); absent = the env-derived one;
  `assessor: null` is refused (the slot is never empty).
- **Env-derived instances** (no section in plugins.yaml): answerer `{ name: opus, plugin:
  claude-cli, options: { bin: JOB_HOPPER_CLAUDE_BIN, model: JOB_HOPPER_ANSWER_MODEL_A, timeoutMs:
  JOB_HOPPER_ANSWER_TIMEOUT_MS } }`, assessor `{ name: fable, plugin: claude-cli-assessor,
  options: { bin, model: JOB_HOPPER_ANSWER_MODEL_B, timeoutMs } }`. `JOB_HOPPER_ANSWERER=fake`
  puts the fake doubles (`src/questions/fake-answerer.ts`) at the seams; `AppSeams.answerer` /
  `.assessor` (tests) win over both. Neither is a plugin; `/api/plugins` still reports the host.
- **Failure, as built.** Answerer unknown, invalid options, not detected or failing `create` →
  no answerer (`/api/plugins` `answerer.active: null`, `fallback: true`, `reason`). Assessor →
  always-escalate stands in under the instance's name (`active: always-escalate`, `fallback:
  true`), every assessment `{ escalate: true, reason: "assessor <name> unavailable: …" }`. The
  instance name from plugins.yaml overrides whatever the plugin calls itself (as for the router).
- **The assessor prompt** (`src/plugins/assessor/claude-cli-assessor/prompt.ts`) fences each
  untrusted part (job prompt, goal, output, question, draft, the answerer's reason, earlier
  attempts) with one more backtick than its longest run, so text inside cannot close its block;
  the rules file is the only trusted section. The prompt is the first line; fail-closed parsing
  and the risk rules are the containment.
- **Built-in plugins may import zod** (in-tree, a dependency); custom plugins still get it only
  as the `z` passed to `options`.
- **No store migration.** Question rows are read as they are; `test/store/fixtures/
  pre-assessor.sqlite` (written by 7d9d4e0's own repositories) reads, validates and restarts.
  Recovery also sends to the human a question created at `human` (no answerer) whose
  announcement a restart cut off.
- **Human expiry past the timer limit** (found by that fixture): `setTimeout` fires a delay over
  2^31−1 ms (~24.8 days) after 1 ms, so such an expiry now re-arms instead of expiring at once.

### Settled in slice 3 (2026-10-03)

- **Roles:** `ROLES` adds `executor` (port `Executor`, unchanged). Built-ins
  `src/plugins/executor/herdr-claude/` and `src/plugins/executor/test/`; the adapters stay in
  `src/executors/`. `EXECUTOR_NAMES` is gone: an executor is a plugin instance and jobs name the
  instance (`spec.executor`). Custom executor plugins load like any other (tested end to end).
- **herdr-claude options:** `bin` (`herdr`), `claudeBin` (`claude`), `session` (`job-hopper`;
  `default` refused), `args` (`[--dangerously-skip-permissions]`), `cwd`
  (`~/workbench/app-workflows`, `~` expanded), `trustWorkdir` (true), `pollMs` (1000),
  `idleQuestionMs` (20000). Detection: `which bin`, then `which claudeBin` — never `--version`,
  never a model call, nothing launched. `claudeBin` exists for detection only: herdr starts
  `claude` itself (`--kind claude`, resolved on herdr's PATH). `test`: no options, always available.
- **6d, as built:** no `kind` option. `screen.ts` parses only Claude Code's TUI, so a `kind`
  other than `claude` could not work; another agent CLI is another executor plugin (Phase 5
  "Roles, plugins, instances"). The tools are configuration already: `args` are the agent's own
  arguments (`--allowedTools`, `--permission-mode`, `--mcp-config`, …), per instance. Revisit
  `kind` when a second parser exists.
- **Herdr session is an instance option**, not process env: two herdr-claude instances may use two
  sessions. The env-derived instance takes `JOB_HOPPER_HERDR_SESSION`. This amends "env keeps …
  herdr session" in "Configuration — plugins.yaml"; slice 4 drops the var with the rest.
- **plugins.yaml `executors:`** — 1..n instances, names unique (refused otherwise: a job names
  one). No section → env-derived instances, one per `JOB_HOPPER_EXECUTORS` name, each an
  instance of the plugin with that id; `herdr-claude` takes `JOB_HOPPER_HERDR_BIN`,
  `JOB_HOPPER_CLAUDE_BIN`, `JOB_HOPPER_HERDR_SESSION`, `JOB_HOPPER_CLAUDE_ARGS`,
  `JOB_HOPPER_CLAUDE_CWD`, `JOB_HOPPER_TRUST_WORKDIR`, `JOB_HOPPER_HERDR_POLL_MS`,
  `JOB_HOPPER_IDLE_QUESTION_MS`. `JOB_HOPPER_EXECUTORS` accepts any instance-shaped name; an
  unknown one is an unavailable executor, not a boot failure. Slice 4 removes these vars.
- **Restart role:** executors are built once in `host.start()`. A later change of the section
  (or its removal, when the env-derived set differs) → `/api/plugins` `executors.pending =
  { status: 'changed — restart pending', instances }`; nothing changes until restart. Reverting
  clears it. An invalid file keeps the running set and leaves `pending` as it was.
- **Held when unavailable, through the pure decider.** `ExecutorRegistry.unavailable()` lists
  configured instances that cannot run (unknown plugin, invalid options, detection not
  `available`, `create` throwing) with the reason; the engine passes it in as
  `DecisionInputs.unavailableExecutors`; `nativeHold` checks it first, reason `executor <name>
  unavailable: <reason>`. A resuming job and an active-mode admit are held too. Intake accepts an
  item naming an unavailable executor **without payload validation** (no executor to ask); a name
  configured nowhere still fails at intake (`unknown executor …`). A job running at a restart
  whose executor is then unavailable is requeued (as before for an unregistered one) and held.
- **The instance name wins** over the plugin's own `name` (`Object.create` over the plugin's
  executor, so its other members and closures are untouched). `/api/health` `executors` lists the
  runnable names only; `/api/plugins` `executors.instances[]` = `{ instance, detection, active,
  reason? }`, `active: null` for one that cannot run.
- **Command-bearing marks** (`.meta({ commandBearing: true })`): herdr-claude `bin`, `claudeBin`,
  `args`, `cwd`; claude-cli and claude-cli-assessor `bin`; jev-router `jevSrc`, `python`. zod
  carries the mark into `z.toJSONSchema()`; `/api/plugins` shows it. `session` is not marked (it
  names a herdr session, not a program).
- **Tests:** `AppSeams.herdr` swaps the herdr-claude built-in for `herdrClaudePlugin(seam)`
  (detection `available`, the seam client driven); `AppSeams.executors` still register after the
  plugin-built ones.
- **No store migration.** Instance names default to the old executor names (`herdr-claude`,
  `test`), so stored `spec.executor` values keep working. `DecisionInputs.unavailableExecutors` is
  new: Decisions stored before this slice lack it (read-only history; nothing replays them).

### Settled in slice 4 (2026-10-03)

- **Roles:** `ROLES` adds `job-source` (0..n; built-ins `github-gh`, `github-app`), `machine-source` (1;
  built-in `local`, option `lanes`, default 4) and `usage-source` (0..n; none built in — the fake usage
  source is a test double, `AppSeams.fakeUsage`; production has no usage reading, the decider's
  `usedFrac` is 0 as before). All three are restart roles: `/api/plugins` `jobSources`, `machines`,
  `usageSources` = `{ instances: InstanceStatus[], pending? }`, the same shape as `executors`
  (`ExecutorInstanceStatus` renamed `InstanceStatus`). plugins.yaml `machines:` is one instance (a
  map, never a list); `jobSources` and `usageSources` names are unique (refused otherwise).
- **Instance names stay `github` and `github-app`.** The migration writes exactly those; `ctx.instanceName`
  (new in `PluginContext`) is what a source calls itself, and the host refuses a job source whose
  `source.name` differs (its jobs would be keyed under a name no sync slot has). The machine id is
  the machine instance's name (`local`: lanes are stored under it).
- **Detection.** github-gh: `which bin`, then `gh auth status` through the new kit method
  `succeeds(bin, args)` (exit 0 within 5 s, output discarded) — `needs-setup`, command `gh auth login`,
  when it fails. github-app: the app file exists → `available`, else `needs-setup`, command
  `bash ~/.local/lib/job-hopper/scripts/create-github-app.sh`. Never a paid call. **A job source whose
  detection says needs-setup is still built** (`instantiate(…, needsSetupRuns)`): a restart role
  cannot re-detect, and both GitHub sources heal on their own (gh after `gh auth login`, the app
  source when its file appears — phase 4's no-restart switch). `unavailable` (gh not installed)
  drops it. Every other role still needs `available`.
- **Job source instance.** `create` returns `{ source, pollMs }` (the source's own cadence, from
  `pollSeconds`) or `{ disabled: { kind, detail } }` (options
  `enabled: false`) — listed `disabled` in `/api/sources`, never run. A source that cannot run is a
  fixed `error` status with the reason (kind = plugin id). `RoleContext['job-source']` = `knownKeys`,
  `rerunnable`; `RoleContext['machine-source']` = `executors()` (asked on every list, so
  seam executors registered after the host count).
- **The gh source's pause** no longer reads the app source's config: github-gh has its own `appFile`
  (default `~/.config/job-hopper/github-app.json`; `null` never pauses). The migration writes the app
  source's app file there, or `null` when `githubApp.enabled` was false — the phase-4 rule as before.
- **Plugins-file migration** (`src/plugins/migrate.ts`, `ensurePluginsFile`), first thing in `startApp`:
  - plugins.yaml exists → nothing (never overwritten; a `sources.yaml` beside it → boot warning
    "no longer read").
  - else build every section: `answerer`/`assessor` (claude-cli `opus` / claude-cli-assessor `fable`,
    `bin` = `CLAUDE_BIN`, models `ANSWER_MODEL_A/B`, `timeoutMs` = `JOB_HOPPER_ANSWER_TIMEOUT_MS`),
    `executors` (one per `EXECUTORS` name; herdr-claude with `HERDR_BIN`, `CLAUDE_BIN`, `HERDR_SESSION`,
    `CLAUDE_ARGS`, `CLAUDE_CWD`, `TRUST_WORKDIR`, `HERDR_POLL_MS`, `IDLE_QUESTION_MS`), `jobSources`
    (sources.yaml's `github:` and `githubApp:` blocks as options — their YAML nodes, so comments
    survive — plus `bin` = `GH_BIN`, the gh `appFile`, `apiUrl` = `GITHUB_API`; no `github:` block →
    `{ enabled: false }`, as before; the app's `appFile` beside sources.yaml when unset), `machines`
    (`LOCAL_LANES`), `usageSources: []`. No `router` section: the router stays detected, as before.
    The removed vars keep their old validation and defaults; an invalid one, an unparseable
    sources.yaml or a block that is not a mapping → the boot fails loudly, nothing written or renamed.
  - sources.yaml is `JOB_HOPPER_SOURCES_FILE` (read this once more) or `sources.yaml` beside plugins.yaml.
  - written mode 600 to a temp file, then `link`ed into place (fails rather than replace a file that
    appeared meanwhile), then sources.yaml → `sources.yaml.migrated` (`.migrated-<ms>` if taken).
  - nothing to migrate → the same builder with no inputs: the built-in instances (github-gh
    `enabled: false`, github-app waiting for `github-app.json` beside plugins.yaml — what a missing
    sources.yaml meant). So there is always one file. An absent section later means those same
    built-in instances (`builtinInstances`), not the env.
- **Env keeps process settings only:** host, port, db, tick, router mode (seed) and cheap boost, the
  decider's limits and lane idle grace, webhook base, `JOB_HOPPER_ANSWER_TIMEOUT_MS` (kept: it is the
  question service's per-stage ceiling, a bound on every plugin whatever its own `timeoutMs` — the
  fail-closed containment, not a part's option), rules file, human renotify/timeout, resume boost,
  max questions, keep panes, webhooks file, Grok Bot env file (removed in slice 5), UI session hours, plugin dir,
  plugins file. Removed, no compatibility path: `EXECUTORS`, `HERDR_BIN`, `HERDR_SESSION`,
  `HERDR_POLL_MS`, `CLAUDE_BIN`, `CLAUDE_ARGS`, `CLAUDE_CWD`, `TRUST_WORKDIR`, `IDLE_QUESTION_MS`,
  `ANSWERER` (`fake`: the doubles are test seams now, `test/support/fake-questions.ts`),
  `ANSWER_MODEL_A`/`_B`, `LOCAL_LANES`, `SOURCES_FILE`, `GH_BIN`, `GITHUB_API` (the daemon's: now
  github-app `apiUrl`; `scripts/create-github-app.ts` still reads it). Renamed: `JEV_MODE` →
  `ROUTER_MODE`, `JEV_CHEAP_BOOST` → `ROUTER_CHEAP_BOOST` (glossary: "Jev mode" is not a word).
- **Leftover variables:** `loadConfig` puts every set `JOB_HOPPER_*` key it does not read into
  `config.leftoverEnv` unvalidated; `startApp` prints one `WARNING: set but no longer read …` line
  naming them all, on every boot, migration boot included.
- **Command-bearing marks added:** github-gh `bin`, `appFile`, `defaultCwd`, `repoPaths`; github-app
  `appFile`, `defaultCwd`, `repoPaths`, `apiUrl`. `apiUrl` is where the app's JWT and installation
  tokens are sent; `appFile` selects the private key and so the identity the source acts as — a UI
  session must change neither. `local` has none.
- **Dropped keys:** the migration deletes `progressCommentSeconds` from both blocks (no progress
  comment exists since the T009 rule, 2026-10-03; the options schemas are strict), covering what
  `migrate-sources-yaml.ts` did for it at install.
- **Unit file and install:** `systemd/job-hopper.service` sets only `JOB_HOPPER_HOST`, `_PORT`,
  `_PLUGINS_FILE`, `_WEBHOOKS_FILE` (a test checks none is a leftover). `install.sh` no longer writes
  or edits sources.yaml (`scripts/migrate-sources-yaml.ts` is gone); when plugins.yaml is absent and
  an old unit is installed, it restarts the daemon once on the new code **under the old unit** and
  waits for plugins.yaml, so the migration reads that unit's environment — then installs the new
  unit. A fresh install gets the built-in instances (gh off, app source waiting for
  create-github-app.sh), no longer a gh-auto starter.
- **Tests:** `startTestApp` writes plugins.yaml (`TEST_PLUGINS`: executor `test`, no job sources) and
  passes the fake question doubles and the fake usage source as seams; `AppSeams.github` /
  `.githubApp` swap the GitHub plugins' adapters (detection then `available`), like `.herdr`.
- **No store migration.** Instance names equal the old source and executor names; jobs, sync state
  and lanes are keyed as before. the owner's sources.yaml survives as `sources.yaml.migrated`.

#### Configuration (env), as of slice 5

| var | default |
|-----|---------|
| `JOB_HOPPER_HOST` | `127.0.0.1` |
| `JOB_HOPPER_PORT` | `4790` |
| `JOB_HOPPER_DB` | `~/.local/share/job-hopper/job-hopper.db` |
| `JOB_HOPPER_TICK_MS` | `2000` |
| `JOB_HOPPER_ROUTER_MODE` | `shadow` (initial router mode only; the stored setting wins once set) |
| `JOB_HOPPER_SOFT_LIMIT` / `HARD_LIMIT` | `0.7` / `0.95` |
| `JOB_HOPPER_ROUTER_CHEAP_BOOST` | `10` |
| `JOB_HOPPER_WEBHOOK_BASE_MS` | `1000` |
| `JOB_HOPPER_LANE_IDLE_GRACE_MS` | `5000` |
| `JOB_HOPPER_ANSWER_TIMEOUT_MS` | `180000` — the question service's per-stage ceiling |
| `JOB_HOPPER_RULES_FILE` | `~/.config/job-hopper/rules.md` |
| `JOB_HOPPER_HUMAN_RENOTIFY_MS` / `HUMAN_TIMEOUT_MS` | `900000` / `86400000` |
| `JOB_HOPPER_RESUME_BOOST` | `20` |
| `JOB_HOPPER_MAX_QUESTIONS` | `5` |
| `JOB_HOPPER_KEEP_PANES` | `false` |
| `JOB_HOPPER_WEBHOOKS_FILE` | `~/.config/job-hopper/webhooks.yaml` |
| `JOB_HOPPER_UI_SESSION_HOURS` | `12` |
| `JOB_HOPPER_PLUGIN_DIR` | `~/.config/job-hopper/plugins` |
| `JOB_HOPPER_PLUGINS_FILE` | `~/.config/job-hopper/plugins.yaml` |

### Settled in slice 5 (2026-10-03)

- **Role:** `ROLES` adds `notifier` (0..n, a restart role). Port `Notifier { name; start(events);
  stop() }` (`src/domain/ports.ts`); `events` is `NotifierEvents { subscribe(listener) → unsubscribe;
  job(id) }` — the event log's feed plus the job an event names (Grok Bot's payload carries the
  issue title and url). `/api/plugins` `notifiers` has the restart-role shape (`instances`,
  `pending`). `PluginHost.startNotifiers(events)` / `stopNotifiers()` are called by `main.ts`
  where the Grok Bot notifier used to start and stop (stop awaits in-flight posts).
- **Built-in `grokbot-routine`**, one option `envFile` (default `~/.config/job-hopper/grokbot-webhook.env`),
  marked command-bearing: the file holds the bearer key and the URL it is sent to, so a UI session
  must not point it elsewhere. Behaviour unchanged (questions only, read at each event, retries).
  Logs go through `ctx.logger` (warn for what was `console.error`).
- **Detection:** the env file only, through the new kit method `readable(path)`; never runs, nor
  `which`es, the Grok Bot app. Missing → `needs-setup` with a `printf … > <file>` command;
  unreadable → `needs-setup`, `chmod 600 <file>`. **A notifier that needs setup still runs**
  (`needsSetupRuns`, as for job sources): the file is read at each event, so one written later
  applies without a restart — the phase-4 behaviour.
- **Failure:** unknown plugin, invalid options, `unavailable`, `create` or `start` throwing → dropped,
  reason in `/api/plugins` (`active: null`); never a boot failure. A failing `stop` is logged.
- **Migration, both upgrade orders end with Grok Bot configured:**
  - no plugins.yaml (slice 5 installed over the pre-slice-4 unit): the plugins-file migration writes
    `notifiers: [ { name: grok-bot, plugin: grokbot-routine, options: { envFile } } ]`, `envFile` =
    `JOB_HOPPER_GROKBOT_WEBHOOK_FILE` if set (read this once more), else `grokbot-webhook.env`
    beside plugins.yaml. The variable alone counts as a migration.
  - plugins.yaml without `notifiers` (slice 4 installed first): **chosen: the built-in instance for
    an absent section**, not a section-level rewrite. It is the rule every section already follows
    since slice 4 ("an absent section means the built-in instances"), it writes nothing into
    the owner's file, and it cannot race an edit. The built-in `grok-bot` instance's `envFile` is
    `grokbot-webhook.env` beside plugins.yaml — never a hardcoded home path. Cost, accepted: a
    non-default `JOB_HOPPER_GROKBOT_WEBHOOK_FILE` beside an existing plugins.yaml is not carried
    over; the leftover-variable warning names it, and the fix is a `notifiers` section. The
    installed unit never set it. `notifiers: []` = no notifiers.
- **`JOB_HOPPER_GROKBOT_WEBHOOK_FILE` removed** (no compatibility path; leftover warning). `src/grokbot/`
  moved to `src/plugins/notifier/grokbot-routine/`.
- **No store migration.** Nothing was ever stored for Grok Bot.

## Phase 6 — owner direction, not yet built (2026-10-03)

Four items from the owner. None is designed to completion; each records his words, the code it
touches, the open questions, and its tie to the plugin architecture (North star). Nothing here
is a commitment to a shape.

### 6a. Self-repair

Owner request: the app repairs and reinstalls itself in place.

Meaning: if an install breaks, or a restart kills work, the app detects it and repairs itself.
Today `scripts/install.sh` copies the tree to `~/.local/lib/job-hopper` (`DEST`) and runs
`systemctl --user restart job-hopper`. A restart fails running non-idempotent jobs
(`recover()` in `src/engine/recovery.ts`: `interrupted by daemon restart`) and a broken copy
leaves the unit crash-looping with nobody to notice. Another worker is making running jobs
survive restart; self-repair covers what that does not.

Touches: `scripts/install.sh`, `src/main.ts` (startup), `src/engine/recovery.ts`,
`GET /api/health`, the systemd unit files, `src/events/` (a repair event).

Open questions:
- What counts as "broken": unit failed or flapping, health check red, dist/source mismatch, missing dependency, schema ahead of code?
- Who repairs: a second watchdog unit (the daemon cannot repair itself while down), or `ExecStartPre`, or `OnFailure=`?
- Reinstall from where: the clone, a pinned git ref, a retained last-good copy in `~/.local/lib/job-hopper.prev`?
- Roll back to last-good, or roll forward? What stops a repair loop?
- How is a repair surfaced: event, UI banner, GitHub comment (never on a job issue; see no-comment rule)?
- A repair must never touch `~/.local/share/job-hopper` (persisted state).

Plugin tie: the repair is a role candidate (a `repairer` slot with detection and action), but
has one caller today; build it plain first, extract on a second real caller.

### 6b. Webhook subscription in the UI

Owner request: subscriptions are visible and configurable in the UI.

Meaning: the UI shows each subscription (name, url, events, active, last delivery state) and
lets the owner edit it. Today `webhooks.yaml` is the only source (`src/webhooks/config.ts`,
reconciled by `name` into the store; dispatch in `src/webhooks/dispatcher.ts`; read-only
`src/http/webhooks.ts`). Repo law: no route creates or changes a webhook; the only mutations are
`POST /ui/api/*` behind a UI session. The edit therefore goes through a new `POST /ui/api/webhooks`
(session, exact Origin, same-origin, JSON), and the law line "webhooks only from `webhooks.yaml`"
changes in the same commit.

Touches: `src/webhooks/config.ts`, `src/http/ui/` (mutation route), `src/ui/app.js` + `index.html`,
`AGENTS.md` loopback rule, design "UI session and mutations".

Open questions:
- Source of truth after an edit: the UI writes `webhooks.yaml` (file stays truth, comments lost) or the store owns it (file becomes seed)?
- Secrets: show, mask, never display? `secretFile` handling in a form.
- Which fields are editable; may the UI create and delete, or edit only?
- Validation: reuse the zod `entry` schema; same error text in the UI.
- Same machinery as issue #6 (per-piece configuration in the UI)? Probably one editor, two data sets.

Plugin tie: a subscriber is a notifier instance (Phase 5 slice 5, `Notifier` port). Subscription
editing is the generic per-instance option editor of slice 7 applied to the notifier role, not a
webhook-only screen.

### 6c. Own herdr session visible and attachable

The owner: the hopper's own herdr session should be visible in the UI and attachable in a single click.

Meaning: the UI shows the herdr session (herdr-claude option `session`, default `job-hopper`; unit
`job-hopper-herdr`) with its state, and offers attach. Attach is `herdr session attach job-hopper`,
a terminal action; the page is a browser on a loopback-only app.

Touches: `src/executors/herdr/` (session name, status via `client.ts`), `src/http/state.ts`
(expose session name and liveness), `src/ui/app.js`, `src/http/host-guard.ts` (no change expected).

Options (not decided):
1. Copyable command: show `herdr session attach job-hopper` with a copy button. Zero new surface; two clicks including paste.
2. Terminal URL handler: a `terminal:`/custom-scheme link registered by the OS to open a terminal running the command. One click; per-machine setup, and a link that runs a command is an execution surface.
3. Loopback-only helper: `POST /ui/api/herdr/attach` spawns a terminal emulator on the host. One click; the daemon launches a GUI process, which breaks "the hopper pulls".
4. Embedded terminal in the page (web terminal over the herdr socket). One click, no host terminal; largest surface and a new dependency.

Open questions: which terminal does the owner use; is a host-side spawn acceptable under the
loopback law; read-only view (screen mirror) as a first step?

Plugin tie: the executor plugin (slice 3) reports its own session and attach command; the UI
renders whatever the active executors declare, so another backend with another multiplexer
needs no UI change.

### 6d. Backends are configuration

Owner direction: herdr can drive any agent; the tools used are defined in the configuration.

Meaning: which agent runs a job is configuration, not code. `herdr agent start --kind` accepts
pi, claude, codex, gemini, cursor, devin, agy, cline, omp, mastracode, opencode, copilot, kimi,
kiro, droid, amp, grok, hermes, kilo, qodercli, qwen, maki (`herdr agent start --help`).
Today `src/executors/herdr/cli-client.ts` hardcodes `--kind claude`; `screen.ts` parses the
Claude Code TUI (turn anchor, gutter, `JOB_HOPPER_*` markers) and `PROTOCOL_FOOTER` assumes
Claude echoes it; `src/config.ts` has `EXECUTOR_NAMES = ['test', 'herdr-claude']`; the executor
is named `herdr-claude`.

Touches: `src/executors/herdr/cli-client.ts` (kind parameter), `screen.ts` (per-kind parsing),
`executor.ts`, `src/config.ts` (`EXECUTOR_NAMES`), `plugins.yaml` options, `docs/glossary.md`
(rename `herdr-claude` if the executor stops being Claude-specific).

Open questions:
- One `herdr` executor with `kind` as an option, or one plugin per backend? Config-only if parsing is uniform.
- Screen parsing per kind: does each TUI echo the footer and keep the anchor? Without that, how is turn end detected: herdr's own agent status, or a per-kind parser plugin?
- "Define the tools to be used": does that mean the tool allow-list passed as agent args (`-- ...args`) per instance?
- Existing jobs persist `spec.executor = 'herdr-claude'`: a rename needs a migration in `src/store/migrations.ts`.
- Idempotence flag per backend (recovery treats non-idempotent as fail-on-restart).

Plugin tie: this is Phase 5 slice 3 ("Executors as plugins; `EXECUTOR_NAMES` removed"). Slice 3
landed with the tools as the `args` option and without `kind` (see "Settled in slice 3": one
parser exists); `kind` arrives with a second parser.
