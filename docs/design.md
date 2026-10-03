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
