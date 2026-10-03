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

> **Superseded in part by Phase 3:** every `POST`/`PUT`/`DELETE` route in this table is
> removed (404); jobs come from job sources, mutations go through `/ui/api/*` behind a UI
> session. The `GET` routes stand. See "Phase 3 — the hopper pulls".

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
| `job.reprioritized` | `{ from, to, reason }` — phase 3, source re-sort |
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

---

# Phase 2 — Claude in herdr, and questions (2026-10-02)

## Directories added

| dir | owns | must not import |
|-----|------|-----------------|
| `src/executors/herdr/` | `herdr-claude` executor: herdr CLI client (port + real adapter), screen protocol parser, pane lifecycle | engine, http, store, questions |
| `src/questions/` | answer chain: `Answerer` adapters (`claude` CLI, `fake`), risk rules, rules-file loader, `QuestionService` (escalation, timers, recovery) | engine internals, http, executors |

## herdr-claude executor

Job: `executor: "herdr-claude"`, payload
`{ prompt: string (required, non-empty), cwd?: string (absolute or ~; default config
JOB_HOPPER_CLAUDE_CWD), model?: string, expectedMs?: number, timeoutMs?: number }`.

**herdr session.** job-hopper owns the named session `JOB_HOPPER_HERDR_SESSION`
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
`--dangerously-skip-permissions`. `agent_not_ready` (blocked at startup): read the visible
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

**Turn anchor (B1).** At every send record `{ seq: state_change_seq, anchor }` where
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

Lifecycle: executor returns `question` → engine, in one tx: question created (`open`,
tier `opus`), job `waiting_answer` + `questionId`, `resumeOn` = its machine, lane idle (or
closed if draining), events `question.asked`. Then `QuestionService.handle(questionId)`
runs the chain off the decision path:

1. **opus** — `question.escalated {target: "opus"}`; `Answerer` opus.
2. accepted iff `confident && !risky && no risk rule matched`; else `fable`:
   `question.escalated {target: "fable", reason}`; `Answerer` fable with `previous`.
3. accepted iff the same test; else **human**: question `tier: human`,
   `escalatedToHumanAt`, `expiresAt = now + JOB_HOPPER_HUMAN_TIMEOUT_MS`,
   `question.escalated {target: "human", reason, text, jobId, goal, answerUrl, notifyCount: 1}`.
   Every `JOB_HOPPER_HUMAN_RENOTIFY_MS` while open: same event, `renotify: true`,
   `notifyCount` +1. At `expiresAt`: question `expired`, `question.expired`, job `failed`
   (`question unanswered`), executor `cleanup`.

An `Answerer` error counts as not confident (logged with `error`) and escalates.
**Accepted answer** (any tier, incl. human via API): question `answered`, `answer`,
`answeredBy`; `question.answered {by, answer}`; job → `queued` with `pendingAnswer`,
`questionId` kept, so the decider re-admits it (pinned to `resumeOn`, priority
`+ policy.resumeBoost`). Claim of a job with `pendingAnswer` calls `executor.resume(ctx,
answer)` and clears `pendingAnswer`. A human answer while a model tier is in flight wins;
the late model result is logged (`outcome: escalated`, reason `superseded`) and ignored.

**Every attempt is appended** (`questions.addAttempt`) with tier, model, timestamps,
answer, confident, risky, riskRules, reason, error, outcome — the escalation trail.

**Claude CLI answerer.** argv exactly `["-p", "--model", <opus|fable>, "--output-format",
"json", "--json-schema", <AnswerVerdict schema>, "--no-session-persistence",
"--setting-sources", "", "--strict-mcp-config", "--tools", ""]` (`--tools` last, so its
list cannot swallow another flag), prompt on stdin, cwd = the
data dir (so no project CLAUDE.md is loaded), env scrubbed of `CLAUDECODE`/`CLAUDE_CODE_*`,
timeout `JOB_HOPPER_ANSWER_TIMEOUT_MS` (180000). Read `structured_output`; missing or
invalid → `{ error }`. The prompt states: you answer on the owner's behalf for an unattended
coding agent; standing rules; job prompt; recent pane output (last 120 lines); the
question; earlier tiers' attempts; mark `risky` for deleting, deploying, force-push,
spending money, credentials, sending messages, or anything irreversible; `confident`
only if the rules and context settle it. **No local LLM**; fable is the `claude` CLI
model alias `fable` — no fable agent or skill is defined in this setup (checked
`claude agents --json`, `~/.claude/skills`).

**Risk rules** (independent of the model; case-insensitive, word-bounded, over question +
answer): `\b(delete|deleting|remove (all|the)|rm -rf|drop (table|database)|truncate|wipe)\b` ·
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
`status === 'open'` and (model results) `tier` = the producing tier; `onAnswered` /
`onExpired` run synchronously inside it. The engine's side is compare-and-set too: it acts
only if the job is `waiting_answer` with that `questionId`.

**Question budget (B6).** At most `JOB_HOPPER_MAX_QUESTIONS` (5) questions per job; the
next question fails the job `too many questions` (and cleans up). When `detectedBy` is
`idle`, the answerer prompt says the agent may simply have finished and that a valid answer
is "If the job is complete, end your message with JOB_HOPPER_DONE".

**Recovery at startup (B2, B3).**
- `claimed`/`running` jobs: idempotent executor → requeued (`job.requeued`) as before;
  non-idempotent (herdr-claude) → `executor.cleanup(job)`, job `failed` `interrupted by
  daemon restart`, `job.failed`. Never re-run: a second run repeats real side effects.
  Reattaching to the live pane is carried work.
- `waiting_answer` jobs, by their question: `open` → leave it (QuestionService.recover
  re-runs a model tier or re-arms human timers; a human question past `expiresAt` expires
  now); `answered` → requeue with that answer; `expired`/`cancelled`/missing → job `failed`,
  `cleanup`.
- `pendingAnswer` is cleared in the same tx that records the resume's outcome (not at claim),
  so a restart mid-resume does not lose the answer — but a restart mid-resume of a
  herdr-claude job fails it per the first rule.

**Cancel** of a `waiting_answer` job: question `cancelled`, `executor.cleanup`, job
`cancelled`.

## Decider changes

`waiting_answer` jobs are in neither `waiting` nor `running`, hold no lane, and are not
inputs. A waiting job with `pendingAnswer`: effective priority `+ policy.resumeBoost` in
both modes; pinned to `job.resumeOn ?? spec.machineId`; Jev holds do not apply to it (the
job was already admitted once) — it is never re-held for Jev.

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
| `question.escalated` | `{ questionId, target: "opus"\|"fable"\|"human", reason, text, jobId, goal?, answerUrl?, notifyCount?, renotify? }` |
| `question.answered` | `{ questionId, by: tier, answer }` |
| `question.expired` | `{ questionId, after_ms }` |

## Configuration added (env)

| var | default |
|-----|---------|
| `JOB_HOPPER_EXECUTORS` | `test,herdr-claude` |
| `JOB_HOPPER_HERDR_BIN` | `herdr` |
| `JOB_HOPPER_HERDR_SESSION` | `job-hopper` |
| `JOB_HOPPER_HERDR_POLL_MS` | `1000` |
| `JOB_HOPPER_CLAUDE_BIN` | `claude` |
| `JOB_HOPPER_CLAUDE_ARGS` | `--dangerously-skip-permissions` |
| `JOB_HOPPER_CLAUDE_CWD` | `~/workbench/workflow-personal-app-management` |
| `JOB_HOPPER_TRUST_WORKDIR` | `true` |
| `JOB_HOPPER_IDLE_QUESTION_MS` | `20000` |
| `JOB_HOPPER_ANSWERER` | `claude` (`fake` for tests) |
| `JOB_HOPPER_ANSWER_MODEL_A` / `_B` | `opus` / `fable` |
| `JOB_HOPPER_ANSWER_TIMEOUT_MS` | `180000` |
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
src/questions/index.ts        createClaudeCliAnswerer(o: { tier: 'opus'|'fable'; model: string;
                                bin: string; cwd: string; timeoutMs: number }): Answerer
                              createFakeAnswerer(o: { tier; script: (req) => AnswerVerdict | { error } }): Answerer
                              createQuestionService(o: { store: Store; clock: Clock; answerers: Answerer[];
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
- **The fake answerer** (`JOB_HOPPER_ANSWERER=fake`, tests only): answer `fake <tier>
  answer`; opus confident unless the question says "hard" or "unsure", fable unless
  "unsure"; both risky if it says "risky"; real risk rules still apply.
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
| `src/sources/` | `JobSource` adapters (`github`), the GitHub API port + `gh` CLI adapter + in-memory fake, `sources.yaml` loader, the sync loop | engine internals (uses the narrow `SourceHost` it is given), http |
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
`/api/decisions[/:id]` · `/api/events` · `/api/events/stream` (SSE) · `/api/jev` ·
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
| POST | `/ui/api/jev` | `{ mode }` | set Jev mode |
| POST | `/ui/api/logout` | `{}` | drop the session |

**Residual risk, stated.** Still able to act or read:
- A process running **as the owner** that reads `ui-login-code`/`ui-login.html` or the
  browser profile's `localStorage`. That includes Claude jobs running with
  `--dangerously-skip-permissions`.
- A job (or any script using the owner's `gh` token) that posts an issue comment without the
  hopper marker. That comment counts as the owner's answer, so a job can answer its own
  question.
- Every local user can **read** the GET API, which exposes prompts, issue context and job
  environment.

Blocked: other OS users acting, any web page (cross-site, DNS rebinding via the Host
guard), and local processes that do not deliberately read job-hopper's or the browser's
files.

## Job sources

`JobSource` port (`src/domain/ports.ts`). The **sync loop** (`createSourceSync`) runs per
source every `pollSeconds`:

1. `discover()` → for each item whose `key` has no job: create one via the host's
   `ingest(item)` — spec `{ executor: item.executor, payload: { prompt, cwd, model?, env },
   priority, goal: title, submittedBy: "<source>:<author>", kind: "coding" }`; `item.invalid`
   or a payload the executor rejects → job created and failed in one tx (`job.queued` +
   `job.failed`); for items that already have a job: `host.reprioritize(jobId,
   item.priority, item.priorityReason)` (re-sort; applies only to queued/held),
   `source: JobSourceRef`, with `payload.prompt = item.prompt`, `payload.env = item.env` —
   then `report({kind:'claimed'})`, merge the returned patch into
   `sourceState`. Duplicate key → skip (dedupe by store unique index).
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
  defaultCwd: ~/workbench/workflow-personal-app-management
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
above; empty body → claimed, then failed with a comment "empty issue body"; priority per
"Priority"; cwd = `repoPaths[repo]` (expanded) else `defaultCwd`.

**Comments.** Every hopper comment starts with a hidden marker line
`<!-- job-hopper v1 kind=<kind> job=<jobId>[ question=<questionId>] -->` — the hopper posts
as the owner, so the marker is how its own comments are told apart from his replies. Before
posting, the adapter lists comments and reuses one already carrying the identical marker
(idempotent retries). Bodies are sent on stdin (`gh api … -X POST --input -`), never argv,
and truncated to 60 000 characters with a "(truncated)" note (GitHub's limit is 65 536).

| report | on GitHub |
|--------|-----------|
| claimed | ensure labels `hopper:claimed`, `hopper:done`, `hopper:failed` exist (`gh label create --force`, once per repo per process); add `hopper:claimed`; comment "🦘 job-hopper claimed this as job `<id>` (priority N, executor X, cwd …)" |
| progress | one progress comment per job, **edited in place** (`editComment`), throttled |
| question (human tier only) | comment with the question, the escalation trail summary (tier · confident · risky · rules), and "Reply to this issue to answer." |
| answered | comment "Answered by <tier>: …" (also for opus/fable answers, so the issue tells the whole story) |
| finished | comment with the result summary; remove `hopper:claimed`, add `hopper:done` |
| failed | comment with the error; remove `hopper:claimed`, add `hopper:failed` |
| cancelled | comment "cancelled (<reason>)"; remove `hopper:claimed` |

**Signals (check):** per active job, `getIssue` + `listComments` (all pages:
`gh api --paginate --slurp "repos/O/R/issues/N/comments?per_page=100"`):
- issue `closed`, or `label` removed → `cancel` (reason `issue closed` / `label removed`);
  issue 404/410 → `cancel` (`issue gone`). Jobs are told not to close their own issue.
- job `waiting_answer` and its question comment id is in `sourceState.source`: the answer is
  the first comment with a **numeric id greater than the question comment's id**, by an
  author in `authors`, whose first line does not match `^<!-- job-hopper v1 ` (that also
  covers the jobs' own `HOPPER_COMMENT_MARKER`), body trimmed and non-empty. Edits are
  ignored. Comments by anyone else are ignored.
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
A shared test helper (`test/support/conformance.ts`) subscribes to the event log and
validates every event a test emits.

## Configuration added (env)

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
| `src/sources/github/tokens.ts` | the per-job token keeper (writes/refreshes/deletes job token files) | engine, http |
| `scripts/create-github-app.*` | the manifest-flow helper the owner runs once | everything in `src/` except small pure helpers it imports explicitly |
| `scripts/hopper-comment*` | the job's helper for commenting on its own issue as the app | `src/` (standalone; Node built-ins only) |

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
  defaultCwd: ~/workbench/workflow-personal-app-management
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
