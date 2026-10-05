# hopper — design

The contract every module is built against. Types: `src/domain/types.ts`; seams:
`src/domain/ports.ts`; words: `docs/glossary.md`.

## North star

Owner decision (2026-10-03): hopper is an extendable plugin architecture.

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

One process. Node ≥ 24 runs the TypeScript directly (type stripping) — the daemon has no build
step. The UI is the one built part: `ui/` (React, shadcn/ui, Tailwind, d3) → `npm run build:ui`
→ `ui/dist`, which the daemon serves (issue #14, "UI rework" below).
Fastify for HTTP, Postgres (`pg`) for storage, the only store (issue #53) ("Deployable" below), zod for request validation.

## Directories and what each must not know

| dir | owns | must not import |
|-----|------|-----------------|
| `src/domain/` | types (`types.ts`, re-exporting the ones split out to stay readable: `usage.ts` usage readings, usage report, accounts; `machines.ts` attached machines and their edit; `webhooks.ts` the webhooks edit; `question-gates.ts`; `routing.ts` routing rules; `plugins.ts`), ports | anything else in `src/` |
| `src/decider/` | `decide(inputs, decisionId): Decision` — pure, no I/O, no clock | everything but `domain/` |
| `src/store/` | the database seam (`db.ts`: Postgres through `postgres-worker.ts`), schema, migrations, repositories, event log, config documents, login codes | engine, http, decider |
| `src/webhooks/` | signing, dispatcher, retry/backoff, the secret of a subscription from the runtime (`dispatcher.ts`), the UI edit of the subscriptions (`edit.ts`, rows in the store) | engine, http, decider |
| `src/plugins/` | the plugin SDK (`sdk.ts`, imported by authors as `hopper/plugin`), built-in list (`builtin.ts`), custom loader, detection kit, `plugins.yaml` + watch, the host's contract (`host-types.ts`), the role slots (`router-slot.ts` with the shared `instantiate`, `queue-sorter-slot.ts`, `level-slot.ts`, `executor-slot.ts`, `source-slots.ts` for job, machine and usage sources, `notifier-slot.ts`), attaching an ssh target as an `ssh` machine instance (`attached-edit.ts`; `attached-slot.ts` wires it into the host), the plugins-file migration and the built-in instances (`migrate.ts`), the locked-down `claude -p` runner the claude plugins share (`claude-print.ts`), `expand-home.ts`; built-in plugins under `<role>/<id>/` (`router/jev-router/` holds the Jev shim; `escalation-level/claude-cli/` holds its prompt; `executor/herdr-claude/`, `executor/command/` and `executor/test/` wrap the adapters in `src/executors/`; `job-source/github-gh/` and `job-source/github-app/` build the GitHub sources of `src/sources/`; `machine-source/local/` wraps `src/machines/`; `machine-source/ssh/`, `machine-source/docker/`, `machine-source/client/` are the attached machines, reached through the context's `target` (issue #74); `usage-source/claude-plan/` reads Claude subscription usage and the Claude account from the claude CLI (parser, runner, background refresh); `notifier/grokbot-routine/` is the Grok Bot routine webhook — env-file reader and notifier; `queue-sorter/priority/`, `queue-sorter/oldest-first/`, `queue-sorter/newest-first/` the built-in queue sorters); the routing rules as configured, their report and UI edit (`routing-config.ts`); the plugin store (`plugin-store.ts` the service, `plugin-store-catalogue.ts` its catalogue, `plugin-store-git.ts` its git mirror — "Plugin store") | engine, http, store, decider, questions |
| `src/executors/` | `Executor` adapters (`test`, `herdr/`, `command.ts` — a job's body run on its machine through its connection) and the registry; reached through the executor plugins. The connections and their target authentication ("Target authentication"): `ssh.ts` (key-only ssh to pinned host keys), `docker.ts` (the docker socket check, the proxy's allowlist), `client.ts` (a client target's tunnel, signed calls); `env.ts` the scrubbed child environment | engine, http, store, plugins |
| `src/client/` | the hopper client ("Client targets"), installed on a client target as plain files: `server.ts` (signed `POST /herdr`, `/release`, `/load` over HTTP/2 on the tunnel), `tunnel.ts` (its ssh to the hopper), `release.ts` (the client release: its files, its id, checking and installing one — "Client releases"), `main.ts`; `relay.ts`, the forced command of its key on the hopper's machine; `signature.ts` (the token's HMAC, shared with `src/executors/client.ts`); `ssh-options.ts` (the hardened ssh options, shared with `src/executors/ssh.ts`) | everything in `src/` outside `src/client/` |
| `src/machines/` | `MachineSource` adapters: `local` (reached through the `local` machine-source plugin), attached machines (`createAttachedMachines`, following plugins.yaml; ssh probe and herdr path resolution through the herdr CLI client's ssh argv; the container probe, `docker container inspect`), the detected ssh targets (`ssh-config.ts`), keeping each client target on the hopper's client release (`client-release.ts`), `combineMachineSources` | engine, http, store, plugins |
| `src/usage/` | `UsageSource` adapters: `fake` — a test double at the seam (`AppSeams.fakeUsage`), never composed in production (the production usage source is the `claude-plan` plugin) | engine, http, store, plugins |
| `src/routing/` | routing rules: the plugins.yaml `routing:` schema and the pure matching applied at intake (`routeItem`) — no I/O (issue #18) | everything but `domain/` |
| `src/engine/` | the loop: gather → decide → apply (the queue sorter asked while gathering, `queue-order.ts`); job lifecycle; routing at intake (`source-host.ts`); restart recovery | http |
| `src/auth/` | sign-in through identity providers (issue #39): `auth.yaml` load (`config.ts`), the role rules (`roles.ts`, pure), the identity provider port (`provider.ts`) and its adapters `oidc.ts` (openid-client), `github.ts` (openid-client + the GitHub REST API), `saml.ts` (@node-saml/node-saml), password sign-in (`password.ts`, argon2), the sign-in flow — flows, tickets, bindings, no sign-in (`index.ts`) | engine, http, store, plugins, decider, questions |
| `src/secrets/` | the runtime's secrets (`runtime.ts`): a secret by name, from the variable or the mounted file `<name>_FILE` names ("Secrets") | everything |
| `src/update/` | self-update ("Self-update"): install.json, the git mirror of the update repository, the build of the next install (install.sh build-only mode), the swap, the restart (exit or respawn), restart blockers; the move of a job-hopper install to the new names (`rename.ts`, "Rename from job-hopper") | engine, http, plugins, decider |
| `src/http/` | Fastify routes, SSE, static UI; the UI session, its role check and the sign-in routes (`ui/`); the API reference (`openapi.ts` the document, `api-reference.ts` Scalar at `/docs/`); the plugin store's read side (`plugin-store.ts`) | executors, plugins (reads them through the `PluginsView` and `PluginStoreView` ports) |
| `ui/` | the UI: Vite + React + shadcn/ui + Tailwind + d3, built to `ui/dist` (gitignored) — browser only. `ui/src/model/` is pure (tested from `test/ui/`); `ui/src/components/ui/` is vendored shadcn | all of `src/` at runtime; **type-only** imports from `src/domain/types.ts` (the wire contract has one definition) |
| `site/` | the install page, published to GitHub Pages by `.github/workflows/pages.yml` with `scripts/get.sh` beside it as `install.sh`: one static `index.html`, no build step, nothing loaded from another site | everything in the repo at runtime; it links to the docs on GitHub |
| `examples/plugins/` | one minimal runnable custom plugin per role, for authors (`docs/plugins.md`); imports only `hopper/plugin` types and `node:` builtins | everything in `src/` at runtime |
| `src/main.ts` | composition root: config → store → plugins.yaml (written when absent) → plugin host (every part) → plugin store → engine → server | — |
| `src/startup-log.ts` | the daemon's startup lines (listening, parts, sign-in) | — |
| `src/cli.ts` | the operator CLI `hopper`: config documents, login codes, `help` — against the daemon's database | engine, executors |

## The decider

`decide(inputs: DecisionInputs, decisionId: string): Decision`. Deterministic: same inputs,
same Decision. Algorithm, in order:

1. **Usage fraction per machine.** `usedFrac(m)` = max of `used/limit` over readings whose
   `machineId` is `m` or absent. Readings with `limit <= 0` are ignored and noted in
   `reasons`. **Informational readings** (`informational: true` — a window that limits one
   model only, issue #18) are skipped. No readings → `0`.
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

- **Triggers:** interval tick (`HOPPER_TICK_MS`, default 2000) plus the events
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
  one pass, so they reach the same Decision; the source's claim report (label) runs off
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
  one-claim-per-tick, **no dependency between jobs**. Owner decision (issue #11), replacing a
  proposed dependency detector: every job runs in parallel; jobs settle overlaps themselves,
  either by stating the assumptions they made or by making the needed fix in the other project,
  annotated with which way the dependency runs; nothing blocks or holds. So the hopper has no
  dependency detector and no dependency hold; an **overlap** is settled inside the jobs, and the
  protocol footer ("Phase 2") tells each job so. Adding one back needs the owner's say-so. GitHub calls inside one source sync stay serial (GitHub's REST guidance:
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

## Gate router

Jev (`~/workbench/jev-src/grok-bot-jev`, Python) is a per-request classifier: TypeSafe's
`system_one` answers intent / reuse_cache / needs_subagent / stop_retry / complexity, and
`route_task` maps that to one action. It has **no notion of machines, lanes, or usage
budgets**, so it cannot be the usage source. hopper uses it for what it is: the
**admission and prioritization layer** per job. Usage budgets come from `UsageSource`.

grok-bot-jev (`~/workbench/jev-src/grok-bot-jev`, Python) is the open-source reference router around
Jev: its `route_task` asks **gates** — intent / reuse_cache / needs_subagent / stop_retry /
complexity — through `system_one`, and maps the answers to one action. It has **no notion of
machines, lanes, or usage budgets**, so it cannot be the usage source. The gate router uses it for
what it is: the **admission and prioritization layer** per job. Usage budgets come from
`UsageSource`. `fake` is a test double at the `Router` seam (`test/support/fake-router.ts`), never
configured. Mode is the **router mode** (`settings.routerMode`, `POST /ui/api/router-mode`).

- `jev-router`: spawns `<python> src/plugins/router/jev-router/jev_shim.py` with JSON on stdin, in its
  own process group (a timeout kills the group, so no `claude` outlives it) and with the Claude Code
  markers scrubbed from the environment. The shim puts the Jev repo on `sys.path`, loads Jev's
  **own** `config.yaml` (its kill switch is honoured), overrides only `mode` (hopper's) and
  `logging.path` (hopper's data dir), sets `PYTHONDONTWRITEBYTECODE=1`, calls
  `route_task(state)`, prints the result. Nothing is written under the Jev repo. `router.py`
  imports `typesafe_sdk` at module load (via `src.jev_client`); when that package is absent the
  shim installs a stub whose `Choice`/`Noul`/`Score` only record their instructions and criteria.
- **Jev gates: TypeSafe where it is set up, Haiku for the rest** (owner decision, 2026-10-03, issue #19:
  keep Jev and TypeSafe; TypeSafe is better at some things; Haiku through the existing Claude
  login, no new paid key). Jev's router runs unchanged; the shim replaces only the
  `system_one` it imported. Each gate in `typesafeGates` (default `intent`, `reuse_cache`,
  `stop_retry`: crisp classifications of the job state, where TypeSafe's calibrated probabilities
  feed Jev's thresholds) goes to TypeSafe through Jev's own `jev_client.system_one` — when
  a key is set and `python` imports `typesafe_sdk`. The key is `TYPESAFE_API_KEY` from the daemon's
  environment, else the trimmed contents of `typesafeKeyFile` (`~/.config/hopper/typesafe-api-key`,
  mode 600), read on **every** call: writing the file switches TypeSafe on for the next job with
  no restart (issue #28); an absent or empty file leaves it off. The key reaches only the shim's
  environment, where Jev's own `secrets.py` reads it. Every other gate (`needs_subagent`, `complexity`: judgement
  of how much work a goal implies), and every gate TypeSafe fails on, goes to Haiku: one
  locked-down `claude -p --model <model>` run (`claudeArgv`, `claude-print.ts`), prompt on stdin,
  output bound to a schema of TypeSafe's answer shapes, cwd = the data dir. The shim checks every
  gate is answered and every choice is a label Jev offered. Advice details gain `gatesBy`
  (gate → `typesafe` | `haiku`) and, when TypeSafe was wanted but could not answer,
  `typesafeError` (no key is not an error: TypeSafe is simply off).
- Options: `jevSrc`, `python`, `claudeBin` (`claude`), `model` (`haiku`), `typesafeGates`,
  `typesafeKeyFile` (command-bearing: its contents go to TypeSafe),
  `timeoutMs` (60000: one Haiku run over all five gates took about 20 s on the hopper host, the CLI start included). `detect` needs
  `python`, `<jevSrc>/src/router.py` and `claudeBin`; its detail says whether TypeSafe is on.
- Advice from a real router run has `source: "jev-router"`; `details.jevUsed` mirrors the
  router's own `jev_used`. Any failure (Haiku failing or leaving a gate unanswered, timeout, bad
  JSON) → advice `{ action: proceed_full, source: fallback, details: { jevUsed: false }, reason:
  "jev unavailable: …" }` — the router's own documented safe fallback.
- Job → Jev state: `goal` ← `spec.goal`, `kind` ← `spec.kind`, plus `spec.meta` keys
  `cached_artifact`, `cached_note`, `prior_error`, `same_error_count`, `sources_found`,
  `constraints`.
- `fake` router (test double): deterministic, no network, mirrors grok-bot-jev's precedence from job
  metadata: bypass marker → `proceed_full` (gatesAsked false); `meta.cached_artifact` →
  `reuse_cache`; `meta.prior_error` and `same_error_count >= 1` → `stop_retry`; kind
  `lookup` → `run_deterministic`; `chat` → `chat_only`; `account` → `ask_human`;
  `meta.needs_subagent` → `allow_subagent`; `research`/`browser` → `research_capped`; else
  `proceed_full`.
- **Mode** (router mode) is hopper's, persisted in the store (`settings.routerMode`),
  initialised from `HOPPER_ROUTER_MODE` (default `shadow`), switched at runtime in the UI
  (`POST /ui/api/router-mode`).

## HTTP API

> **Superseded in part by Phase 3:** every `POST`/`PUT`/`DELETE` route in this table is
> removed (404); jobs come from job sources, mutations go through `/ui/api/*` behind a UI
> session. The `GET` routes stand. See "Phase 3 — the hopper pulls".

Loopback (`127.0.0.1`), plus the LAN names when set — "Reaching the UI across the LAN". JSON everywhere; errors are
`{ error: string }` with 400/404/409.

| method | path | body / query | returns |
|--------|------|--------------|---------|
| GET | `/api/health` | | `{ ok, version, routerMode, router, fallback, executors, uptimeS }` (phase 5) |
| POST | `/api/jobs` | `JobSpec` | 201 `Job` · 400 unknown executor / invalid payload |
| GET | `/api/jobs` | `?status=queued,held&limit=100` | `{ jobs: Job[] }` newest first |
| GET | `/api/jobs/:id` | | `Job` · 404 |
| POST | `/api/jobs/:id/cancel` | | `Job` · 404 · 409 terminal |
| POST | `/api/jobs/:id/approve` | | `Job` (emits `job.approved`) · 404 · 409 terminal |
| GET | `/api/queue` | | `{ waiting: Job[], running: Job[], waitingAnswer: Job[], ended: Job[] }` — `waiting` in queue order; `ended` = jobs ended in the last 24 h, newest end first (issue #45). No counts: the UI counts the lists |
| GET | `/api/machines` | | `{ machines: (MachineSnapshot & { lanes: Lane[], usage: UsageReading[] })[] }` |
| GET | `/api/decisions` | `?limit=50` | `{ decisions: Decision[] }` newest first |
| GET | `/api/decisions/:id` | | `Decision` · 404 |
| GET | `/api/events` | `?after=0&limit=200&types=job.queued,…` | `{ events: DomainEvent[] }` |
| GET | `/api/events/stream` | `?after=<seq>` or `Last-Event-ID` | SSE (below) |
| GET | `/api/router` | | `{ mode, router, plugin, fallback, reason? }` (phase 5; was `GET /api/jev`) |
| GET | `/api/plugins` | | `PluginsReport` (phase 5): roles, config, router instance + selection + detection + fallback, every plugin |
| GET | `/api/question-gates` | | `QuestionGatesView` (issue #18): `{ rulesFile: { path, text, version, missing }, riskRules: { name, describe }[] }` |
| GET | `/api/usage` | | `{ readings: UsageReading[] }` |
| PUT | `/api/usage/fake` | `{ used, limit, unit?, machineId? }` | `{ readings }` · 404 if no fake source |
| POST | `/api/webhooks` | `{ url, events?: string[], secret?: string }` | 201 `WebhookSubscription` (secret shown once) |
| GET | `/api/webhooks` | | `{ subscriptions }` (secret omitted) |
| DELETE | `/api/webhooks/:id` | | 204 · 404 |
| GET | `/api/webhooks/deliveries` | `?subscriptionId=&limit=100` | `{ deliveries }` newest first |
| GET | `/` | | the UI |

## SSE

`GET /api/events/stream`. Replays events after `Last-Event-ID`, else `?after=`, then live (a reconnecting EventSource reuses its first URL, so the header wins).
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
x-hopper-event: job.finished
x-hopper-delivery: <delivery id>
x-hopper-timestamp: <unix seconds>
x-hopper-signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>

<DomainEvent JSON>
```

Delivery is **at-least-once**; receivers dedupe on `x-hopper-delivery`. Before each POST
the dispatcher moves `nextAttemptAt` past the timeout and keeps the id in an in-memory
in-flight set, so the sweep never sends one delivery twice concurrently. Deleting a
subscription marks its pending/retrying deliveries `failed`.

2xx within 5 s = delivered. Otherwise attempt `n` schedules the next at
`now + min(base * 2^(n-1), 300 s)`, `base` = 1 s (configurable for tests); after 6 attempts
the delivery is `failed`. Due deliveries are swept every 500 ms and on enqueue; pending
deliveries survive a restart. The secret comes from the runtime: the variable the subscription's
`secretEnv` names (or the mounted file `<secretEnv>_FILE` names), read at each delivery ("Secrets").
None given: nothing is sent, and the delivery retries naming the variable.

## Construction contract

One factory per module. `src/main.ts` and the integration tests wire these; nothing else
constructs adapters.

```text
src/store/index.ts      openStore(o: { path: string; clock: Clock; idGen?: IdGen }): Store
src/webhooks/index.ts   createWebhookDispatcher(o: { store: Store; clock: Clock; baseMs: number;
                          timeoutMs?: number; maxAttempts?: number; sweepMs?: number }): WebhookDispatcher
src/plugins/index.ts    createPluginHost(o: { pluginDir; pluginsFile; dataDir; clock; logger; routerMode();
                          jobSourceContext?; machineContext?; defaultLevels?; defaultExecutors?;
                          kit?; builtins?; intervalMs? }): PluginHost
                          — start(), stop(), router (live), routerStatus(), levels(), executors(),
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
- **Only `127.0.0.1` is accepted** for `HOPPER_HOST`; config refuses anything else.
  *Superseded by "Reaching the UI across the LAN" (issue #16): `HOPPER_HOST` is gone.*
- **Static UI files are read once at startup**; a UI change needs a daemon restart.
- **The installed daemon runs from a copy** (`~/.local/lib/hopper`, made by
  `scripts/install.sh`), so switching branches in the source checkout never breaks it.

## Configuration (env)

Slice 4 of phase 5 removed every part-choosing variable and renamed `JEV_MODE` / `JEV_CHEAP_BOOST`;
the current list is "Settled in slice 4" → "Configuration (env), as of slice 5".

| var | default |
|-----|---------|
| `HOPPER_LAN_NAMES` | empty (loopback only) — "Reaching the UI across the LAN" |
| `HOPPER_LAN_PEERS` | empty — set with `LAN_NAMES` |
| `HOPPER_PORT` | `4790` |
| `HOPPER_DB` | `~/.local/share/hopper/hopper.db` |
| `HOPPER_TICK_MS` | `2000` |
| `HOPPER_JEV_MODE` | `shadow` (initial router mode only; the stored setting wins once set) |
| `HOPPER_LOCAL_LANES` | `4` |
| `HOPPER_SOFT_LIMIT` / `HARD_LIMIT` | `0.7` / `0.95` |
| `HOPPER_JEV_CHEAP_BOOST` | `10` |
| `HOPPER_WEBHOOK_BASE_MS` | `1000` |
| `HOPPER_LANE_IDLE_GRACE_MS` | `5000` |

---

# Phase 2 — Claude in herdr, and questions (2026-10-02)

## Directories added

| dir | owns | must not import |
|-----|------|-----------------|
| `src/executors/herdr/` | `herdr-claude` executor: herdr CLI client (port + real adapter), screen protocol parser, pane lifecycle | engine, http, store, questions |
| `src/questions/` | the question pipeline: `QuestionService` (the escalation levels, lowest first → risk rules on an answer → accepted or human; timers, recovery), risk rules, rules-file loader, the fake double at the `EscalationLevel` seam. The levels themselves are plugins (`src/plugins/`, issue #134) | engine internals, http, executors, plugins |

## herdr-claude executor

Job: `executor: "herdr-claude"`, payload
`{ prompt: string (required, non-empty), cwd?: string (absolute or ~; default config
HOPPER_CLAUDE_CWD), model?: string, expectedMs?: number, timeoutMs?: number }`.

**herdr session.** hopper owns the named session of the herdr-claude instance's `session` option
(default `hopper`), run headless by its own unit `hopper-herdr.service`
(`herdr --session hopper server`). Every herdr call is `herdr --session <s> …`, JSON on
stdout, errors JSON on stderr with exit 1. Never the default session — herdr's own doctrine
forbids driving a user's session from outside it. Spawned processes get an environment with
`CLAUDECODE` and every `CLAUDE_CODE_*` variable removed.

**Lanes → panes.** One herdr workspace labelled `hopper` (found by label, else created
`--no-focus`). One **tab per job run**, created with `--cwd <job cwd>` and labelled
`<laneId> · <jobId first 8>`; its root pane hosts Claude. The executor keeps `laneId →
paneId` for the job now on that lane and saves `{ session, workspaceId, tabId, paneId,
agentName, cwd }` with `ctx.saveState` the moment the pane exists. A job in
`waiting_answer` keeps its pane ("parked") while its lane is freed; on resume the lane it
is claimed onto maps to the parked pane.

**Start.** `agent start jh-<jobId first 8> --kind claude --pane <pane> --timeout 60000 --
<HOPPER_CLAUDE_ARGS> [--model <payload.model>]`, default args
`--dangerously-skip-permissions`. **Readiness wait:** herdr refuses `agent start` until the new pane is at its shell
prompt, answering `agent_pane_busy` ("agent target pane … is not an available shell") when
it is sent a few ms after `tab create` — seen live with 4 jobs claimed at once. The CLI
client maps that code to `paneBusy`; the executor retries `agent start` every 100 ms on
exactly that code until the 60000 ms start deadline, then fails the job
(`pane … never reached its shell prompt`). Any other error fails at once. **One pane per
lane:** the executor refuses to map a pane already held by another lane (job `failed`,
pane left untouched). `agent_not_ready` (blocked at startup): read the visible
screen; if it is Claude's folder-trust dialog (contains `trust this folder`) **and the
dialog names the job's cwd** and `HOPPER_TRUST_WORKDIR` is true → send `down enter`,
log it via progress message `trusted workdir <cwd>`, wait for `idle`. Anything else blocking
startup → `failed` with the screen text.

**Work tree** (issue #121). A job's **work tree** is its cwd: all of its coding work happens
under it — clones, git worktrees, builds, scratch and temporary files — never in a copy
outside it (`/tmp` or anywhere else). Opening the pane there is not enough on its own: Claude
Code's scratchpad lives under `/tmp` by default and its system prompt sends temp files there,
which is how a job drifted out of its tree. So the hopper directs it three ways:

- **Environment.** The tab gets `CLAUDE_CODE_TMPDIR` and `TMPDIR` = `<cwd>/.hopper-scratch`,
  the job's **scratch dir**: Claude's scratchpad and every tool's temp files land inside the
  tree. The payload cannot move them.
- **The scratch dir ignores itself.** Before `agent start`, the pane's own shell runs
  `mkdir -p <scratch> && printf '*\n' > <scratch>/.gitignore && printf 'hopper-scratch-%s\n' ready`
  (`pane run`) — in the pane, so on whichever machine the work tree is. A fresh shell drops what
  is typed before its prompt (seen live), so the executor waits up to 1000 ms for
  `hopper-scratch-ready` in the pane's output (`pane wait-output`) and runs the command again,
  until the 60000 ms start deadline, then fails the job (`pane … never ran the scratch dir
  command`). Nothing is written to a repository's own `.gitignore`.
- **The prompt says so.** The footer's work-tree line names the cwd and the scratch dir, and
  tells the job to ask rather than work in a tree outside it.

Running or installing what a job built, and reading files elsewhere, stays allowed: the rule is
about where the work is done, not what is touched.

**Prompt, once.** `agent prompt <agent> <prompt + protocol footer>` (no `--wait`). Footer:

```
[hopper publishing rule] Any text you send to GitHub (commit messages, branch names, pull request titles and bodies, issue text) describes the change and how it was verified, in neutral terms. Never quote or name the repository owner or any other person. Never include personal or machine details: email addresses, people's names, IP addresses, hostnames, tailnet names, home directory paths, usernames, machine or pane ids, port numbers of local machines, codes, tokens or secrets.
[hopper work tree] This job's work tree is <cwd>. Do all of the job's work inside it: clones, git worktrees, edits, builds, test runs, scratch and temporary files go under it. Never make or work in a copy of the code outside it, under /tmp or anywhere else. Temporary files go in <cwd>/.hopper-scratch: git ignores it, and TMPDIR and your scratchpad point there. Running or installing what you built, and reading files elsewhere, is fine. If the job seems to need a work tree outside this one, ask instead.
[hopper parallel work] Other jobs run at the same time as this one, possibly in the same repos. Nothing orders or holds jobs for each other: no job waits for another.
If your work overlaps another job's, sort it out yourself. Either state the assumptions you made about the other work, or make the needed fix in the other project and annotate it with which way the dependency runs (which work depends on which).
[hopper protocol] When you need an answer from the user, ask exactly one question and end your message with a line containing only: HOPPER_QUESTION
When the job is completely finished, end your final message with a line containing only: HOPPER_DONE
If the job cannot be done, end with a line containing only: HOPPER_FAILED followed by the reason.
```

The publishing rule leads the footer so every job gets it, whatever its source; the work-tree
line follows with the job's own cwd (`protocolFooter(cwd)`); the last line stays the turn anchor. It names no comment path: jobs never write to issues.

**Monitor** every `HOPPER_HERDR_POLL_MS` (1000): `agent get` (status, `state_change_seq`)
and `agent read --source recent-unwrapped --lines 200`.

**Turn anchor (B1).** At every send record `{ seq: state_change_seq, anchor }` (saved in
`job.executorState.turn` with `blockedAtSend`, before the prompt, so a restarted daemon can
watch the same turn) where
`anchor` is the last line of what was sent as Claude echoes it — the footer's last line
(`If the job cannot be done, …`) on the first turn, the answer's last line on a resume.
Only output lines **after the last occurrence of the anchor** count. **Every** outcome
below except `blocked`, agent gone and timeout requires status `idle`/`done` **and**
`state_change_seq` greater than at send. Marker normalisation: strip the Claude Code gutter
(`●`, `⎿`), whitespace, and surrounding `` ` `` / `*`; `HOPPER_DONE` and
`HOPPER_QUESTION` must then equal the whole line; `HOPPER_FAILED` is a prefix match
(after the anchor only). Parser tests cover: a wrapped echoed footer, the previous turn's
marker still on screen, a marker in backticks or bold. Then:

| observed | outcome |
|----------|---------|
| marker line `HOPPER_DONE` is the last marker (whole line, trimmed) and status idle/done | `finished`, result `{ summary: <assistant text of the final turn, ≤ 4000 chars>, paneId }` |
| last marker `HOPPER_FAILED` | `failed`, error = text after the marker on that line or the next line |
| last marker `HOPPER_QUESTION` | `question`, `detectedBy: marker`, text = the assistant message before the marker |
| status `blocked` (question/approval UI) | `question`, `detectedBy: blocked`, text = the visible dialog |
| idle/done with no marker after the anchor for `HOPPER_IDLE_QUESTION_MS` (20000) | `question`, `detectedBy: idle`, text = last assistant message ("stopped waiting for input") |
| agent gone (`agent get` error / pane closed) | `failed`, `claude exited` + last output |
| `timeoutMs` (default 3600000) exceeded | interrupt, `failed` `timed out` |

Marker matching: a line equal to the marker after trimming whitespace and the `●`/`⎿`
gutter. The prompt echo contains the markers mid-line only, never as a whole line.
Progress: on change of the last non-empty assistant line, `ctx.progress(min(0.9,
elapsed / expectedMs), line)` (`expectedMs` default 600000).

**Parked.** When a turn parks on a question (any `question` outcome) the monitor saves
`parkedSeq` = the `state_change_seq` it saw, for `answeredInPane` ("Questions" → "Answered in
the pane"). The next send drops it.

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
`QuestionService.firstStage()`: the first escalation level's instance name, or `human` with none),
job `waiting_answer` + `questionId`, `resumeOn` = its machine, lane idle (or closed if
draining), events `question.asked`.

**Visible and answerable at once.** From that commit on, the question is in `GET /api/questions`
(every open question, whatever its stage) and the job in `/api/queue` `waitingAnswer`; the UI
refreshes both on `question.asked` and shows the answer box at every stage, not only `human`.
The owner may answer while a level works on it: their answer wins, the in-flight level call is
aborted (`superseded`), no level above is called, and nothing is pushed. **Push is gated:** the
Grok Bot routine webhook fire only on `question.escalated {target: "human"}` — after every level
escalates, or a risk rule hits. Worst case between ask and push: every level's stage timeout back
to back (`levels × HOPPER_ANSWER_TIMEOUT_MS`; 6 min with the two built-in levels). Then
`QuestionService.handle(questionId)` runs the pipeline off the decision path (issue #134 replaced
the answerer → assessor pair with escalation levels; full contract in "Question pipeline" under
Phase 5):

1. **the levels, lowest first** — for each: `question.escalated {target: <level>, reason}` (`asked`
   for the first; for the next, why the one below escalated: `<level>: <its reason>`, or `<level>
   failed: <error>`). The level replies `{ answer?, escalate, reason }`, given the request, the
   trail so far (the levels below with their recommendations) and its place (`level: { number, of }`).
   `escalate: false` with an answer **answers**: go to 2. Anything else — `escalate: true`, an error,
   a timeout, a malformed reply, a level that cannot run — **escalates** to the next level up.
   Owner decision (issue #134): a question climbs only as far as it needs; a simple one is settled
   at the first level, a complex one climbs.
2. **risk rules** over question + the answer to be typed; a hit → human, past every level above.
3. **accepted** → that answer is typed in, by that level. **human** (past the top level, no levels,
   or a risk rule hit): question `tier: human`,
   `escalatedToHumanAt`, `expiresAt = now + HOPPER_HUMAN_TIMEOUT_MS`,
   `question.escalated {target: "human", reason, text, jobId, goal, answerUrl, notifyCount: 1}`.
   Every `HOPPER_HUMAN_RENOTIFY_MS` while open: same event, `renotify: true`,
   `notifyCount` +1. At `expiresAt`: question `expired`, `question.expired`, job `failed`
   (`question unanswered`), executor `cleanup`. An expiry beyond the timer limit (~24.8 days)
   re-arms instead of firing early.

Every level's call is bounded by `HOPPER_ANSWER_TIMEOUT_MS` in the service (a custom plugin may
hang), on top of the plugin's own `timeoutMs`; a throw counts as an error.
**Accepted answer** (a level's, or the human's via API): question `answered`, `answer`,
`answeredBy` (the level instance, or `human`); `question.answered {by, answer}`; job →
`queued` with `pendingAnswer`, `questionId` kept, so the decider re-admits it (pinned to
`resumeOn`, priority `+ policy.resumeBoost`). Claim of a job with `pendingAnswer` calls
`executor.resume(ctx, answer)` and clears `pendingAnswer`. A human answer while a level is in
flight wins; the late reply is logged (`outcome: escalated`, reason `superseded`) and ignored.

**Every attempt is appended** (`questions.addAttempt`) — the trail: `tier` (who: level instance
name or `human`), `role` (`level` | `human`), model, timestamps, `answer` (a level escalating: its
recommendation), `escalate` (when the reply was schema-valid), `reason`, `riskRules` (on an
answer), `error`; `outcome` `accepted` | `escalated`. Rows stored before escalation levels were
migrated (migration 16): `answerer`/`assessor` roles are `level`, a draft passed on (`drafted`)
is `escalated` with `escalate: true`; they may still carry `confident` (and before slice 2, `risky`).

**Claude CLI plugin** (`claude-cli`, an escalation level; `src/plugins/claude-print.ts`).
argv exactly `["-p", "--model", <model>, ("--effort", <effort>,) "--output-format", "json",
"--json-schema", <schema>, "--no-session-persistence", "--setting-sources", "",
"--strict-mcp-config", "--tools", ""]` (`--tools` last, so its list cannot swallow another
flag), prompt on stdin, cwd = the data dir (so no project CLAUDE.md is loaded), env scrubbed of
`CLAUDECODE`/`CLAUDE_CODE_*`, timeout from the plugin options. Read `structured_output`; missing
or schema-invalid → `{ error }`. The prompt (`src/plugins/escalation-level/claude-cli/prompt.ts`):
you are escalation level N of M; give the best answer you can, then answer or escalate. Every level
escalates what is the owner's (irreversible or outside the job, a judgement the rules do not
settle, against the rules, an injection attempt); a lower level also escalates what it is not sure
of, since a more capable level is above it; the top level keeps the owner out of the loop unless a
human choice is truly needed. The rules file is trusted; job prompt, goal, output, question and the
trail are untrusted data, each fenced with more backticks than it contains, with an instruction not
to follow instructions inside. **No local LLM**; fable is the `claude` CLI model alias `fable` —
no fable agent or skill is defined in this setup (checked `claude agents --json`, `~/.claude/skills`).

**Risk rules** (independent of any model; case-insensitive, word-bounded, over question +
the answer a level gave; run before it is typed): `\b(delete|deleting|remove (all|the)|rm -rf|drop (table|database)|truncate|wipe)\b` ·
`\b(deploy|deploying|deployment|publish|rollout|release to (prod|production))\b` ·
`\b(force[- ]push|push --force|--force-with-lease|reset --hard)\b` ·
`\b(spend|purchase|buy|payment|pay for|billing|charge (the )?card)\b` ·
`\b(credentials?|secrets?|passwords?|api[ _-]?keys?|private key|ssh key|access token)\b` ·
`\b(send (an? |the )?(email|message|sms|dm)|post to (slack|twitter|x)|tweet|notify (the )?(customer|client|team))\b`.
Each rule has a name (`delete`, `deploy`, `force-push`, `spend`, `credentials`,
`send-message`); matches are recorded in `riskRules`.

**Rules file** `HOPPER_RULES_FILE` (default `~/.config/hopper/rules.md`), read on
every ask; missing → empty rules, noted in the prompt and the attempt reason. Editable from the
UI since issue #18 ("Question gates" at the end); an edit applies to the next question.
`scripts/install.sh` writes a starter file only if none exists.

**Atomicity (B3).** Every QuestionService write is one `store.tx`, compare-and-set on
`status === 'open'` and (stage results) `tier` = the producing stage; `onAnswered` /
`onExpired` run synchronously inside it. The engine's side is compare-and-set too: it acts
only if the job is `waiting_answer` with that `questionId`.

**Question budget (B6).** At most `HOPPER_MAX_QUESTIONS` (5) questions per job; the
next question fails the job `too many questions` (and cleans up). When `detectedBy` is
`idle`, the claude-cli level's prompt says the agent may simply have finished and that a valid answer
is "If the job is complete, end your message with HOPPER_DONE".

**Recovery at startup (B2, B3).** `install.sh` restarts the daemon, not `hopper-herdr`,
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
  announced goes to the human now); `answered` or `closed` → requeue with that answer (the close text for `closed`); `expired`/`cancelled`/missing → job `failed`,
  `cleanup`.
- `pendingAnswer` is cleared in the same tx that records the resume's outcome (not at claim),
  so a restart mid-resume does not lose the answer; a herdr-claude job mid-resume is
  `running` and follows the first two rules (its resume turn is the saved `turn`).

**Cancel** of a `waiting_answer` job: question `cancelled`, `executor.cleanup`, job
`cancelled`.

**Close** (`POST /ui/api/questions/:id/close`, the card's Close button): the owner ends an open
question, at any stage, without answering. `QuestionService.closeByHuman`, one tx as for a human
answer: an in-flight stage call aborted (`superseded`), timers cleared, attempt `{ tier: human,
role: human, outcome: accepted, reason: "closed without answering" }`, question `closed` with
`answer` = the close text and `answeredBy: human`, `question.closed { questionId, answer }`
(not `question.answered`: no answer was given, and a consumer must be able to tell). Then the
same `onAnswered` as an answer: job → `queued` with `pendingAnswer` = the close text,
`job.requeued { reason: "closed" }`; the resume types it into the pane. Close text
(`CLOSED_ANSWER`, `src/questions/service.ts`): "The owner closed this question without answering.
Continue on your own judgement; if you cannot, end with HOPPER_FAILED and say why."
Recovery treats a `closed` question like an `answered` one (requeue with its answer).

**Dismiss** (`POST /ui/api/questions/:id/dismiss`, the card's Dismiss button; issue #37): the owner
drops an open question that needs no action any more — typically one whose job has moved on, or
whose work was done elsewhere. `QuestionService.dismissByHuman`, one tx: an in-flight stage call
aborted (`superseded`), timers cleared (no re-notify, no expiry), question `dismissed` with no
answer and no attempt, `question.dismissed { questionId }`, then `onDismissed`: a job still
`waiting_answer` on that question is `cancelled` (`job.cancelled { reason: "question dismissed" }`,
its source told as for any cancel) and its pane cleaned up after the commit; a job that has moved
on is left alone (compare-and-set, no log line). Nothing is typed into any pane. Close lets the job
go on; Dismiss ends it. The card marks a job that has moved on (`job moved on: <status>`).

**Seen** (`POST /ui/api/questions/:id/seen`; issue #37): `seenAt` set once on the question, kept
after; any status. The Questions view posts it for every open question at the human stage without
`seenAt` while it is shown with a UI session. The nav badge counts open questions at the human stage
without `seenAt`, so it clears once they are seen, answered, closed or dismissed. No event: seen
changes no job and nothing outside the UI reads it. Only human-stage questions are marked, so a
question seen while still with an escalation level badges when it reaches the owner.

**Question history** (issue #37): every question stays in the `questions` table with its text,
trail, answer and status; nothing prunes it. The Questions view lists handled ones (status not
`open`, newest first, the last 200 from `GET /api/questions?status=all&limit=200`) as one compact
line each — time, outcome, first line of the question — that opens to the question, the answer
and who gave it, and the job. The history is local to the hopper's SQLite file: no route sends it
anywhere, and the hopper writes nothing of a question to GitHub (it writes only labels).

**Answered in the pane.** The owner may type the answer straight into a parked pane instead of
the UI. On every engine tick, `src/engine/pane-answers.ts` asks the executor of each
`waiting_answer` job `answeredInPane(job)` (port method; herdr-claude implements it; the decider
is untouched). herdr-claude: the monitor saves `parkedSeq` (the `state_change_seq` at which the
turn parked) in `executorState`; a job parked before that field existed uses its turn's send
`seq`. Answered when `agent get` shows the same pane with `state_change_seq > parkedSeq` **and**
either status `working` or a typed echo below the question (`typedAfterQuestion` in
`screen.ts`: the first `❯` block after Claude's reply to the turn anchor, above the input box).
A seq move alone is not enough (herdr's own idle/done flip moves it). The answer is the typed
text, or `(answered in the pane)` when no echo can be read (a dialog answered with keys). The
new turn is `{ seq: parkedSeq, anchor: last typed line (else the old anchor), blockedAtSend:
false }`. Then one tx: `QuestionService.answeredInPane` (stage aborted `superseded`, timers
cleared, attempt `reason: "answered in the pane"`, question `answered` by `human`,
`question.answered { by: human, answer, via: "pane" }`, no `onAnswered`, nothing typed), job
`running` on an idle lane of its `resumeOn` machine with the new `executorState`,
`job.reattached { reason: "answered in the pane" }`; after the commit `runner.reattach` watches
the turn to its outcome, exactly as after a restart. **Lanes:** the job already runs
physically, so it never waits: with no idle lane it opens one more (`lane.opened`) and runs
**over the lane cap** until it ends; the decider counts that busy lane like any other and drains
or closes the extra lane after. **Missed:** a reply turn that starts and ends between two ticks
with no readable echo (e.g. a dialog answered by keys) is not seen; the question stays open and
can still be answered or closed in the UI.

**Logged out** the card shows, where the answer box would be, "Log in to answer or close:
`bash ~/.local/lib/hopper/scripts/open-ui.sh`". A 403 on any mutation drops the stored
token and every card shows the same notice. In the UI rework this is `ui/src/views/questions.tsx`
(the notice is `data-slot="login-notice"`; Close sits next to Send answer and asks first in a
dialog, `components/confirm.tsx`, never `window.confirm`); `test/ui/questions.test.ts` renders
the whole app in happy-dom against a fake daemon.

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
`/api/queue` gains `ended: Job[]` (issue #5): ended jobs, newest `finishedAt` first, at most 20 — the UI board's Ended column.
(Issue #45: `ended` is now every job ended in the last 24 h, and `counts` is gone; see "One job store".)

## Events added

| type | `data` |
|------|--------|
| `question.asked` | `{ questionId, text, detectedBy }` (event `jobId`, `questionId` set) |
| `question.escalated` | `{ questionId, target: <stage>, reason, text, jobId, goal?, answerUrl?, notifyCount?, renotify? }` — v2: `target` is an escalation level's instance name, or `human` (v1: `"opus"\|"fable"\|"human"`) |
| `question.answered` | `{ questionId, by: <level instance>\|"human", answer }` — v2 (v1: `by` from `opus\|fable\|human`) |
| `question.expired` | `{ questionId, after_ms }` |

## Configuration added (env)

Removed in phase 5 slice 4 except the answer timeout, rules file, human timers, resume boost and max
questions; each part's setting is now a plugin option ("Settled in slice 4").

| var | default |
|-----|---------|
| `HOPPER_EXECUTORS` | `test,herdr-claude` |
| `HOPPER_HERDR_BIN` | `herdr` |
| `HOPPER_HERDR_SESSION` | `hopper` |
| `HOPPER_HERDR_POLL_MS` | `1000` |
| `HOPPER_CLAUDE_BIN` | `claude` |
| `HOPPER_CLAUDE_ARGS` | `--dangerously-skip-permissions` |
| `HOPPER_CLAUDE_CWD` | `~/workbench/app-workflows` |
| `HOPPER_TRUST_WORKDIR` | `true` |
| `HOPPER_IDLE_QUESTION_MS` | `20000` |
| `HOPPER_ANSWER_TIMEOUT_MS` | `180000` — plugin `timeoutMs` default from the env, and the service's ceiling on one level's call |
| `HOPPER_RULES_FILE` | `~/.config/hopper/rules.md` |
| `HOPPER_HUMAN_RENOTIFY_MS` | `900000` (15 min) |
| `HOPPER_HUMAN_TIMEOUT_MS` | `86400000` (24 h) |
| `HOPPER_RESUME_BOOST` | `20` |
| `HOPPER_MAX_QUESTIONS` | `5` |

## Construction contract added

```text
src/executors/herdr/index.ts  createHerdrClaudeExecutor(o: { herdr: HerdrClient; clock: Clock;
                                defaultCwd: string; claudeArgs: string[]; trustWorkdir: boolean;
                                pollMs: number; idleQuestionMs: number }): Executor
                              createHerdrCliClient(o: { bin: string; session: string }): HerdrClient
src/questions/index.ts        createFakeLevel(o: { name; model?; script: (req, signal) => LevelReply | { error } }): EscalationLevel
                              createQuestionService(o: { store: Store; clock: Clock;
                                levels: () => readonly EscalationLevel[];
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
  via `executor.cleanup`, unless `HOPPER_KEEP_PANES=true`. Timeouts and failed startups
  close their pane too.
- **herdr unit:** a second `herdr --session X server` exits 1, so
  `hopper-herdr.service` has an `ExecCondition` that skips the start when that
  session's server already runs; it unsets `CLAUDECODE` and the `CLAUDE_CODE_*` markers
  because panes inherit the server's environment. `install.sh` never restarts an active
  herdr unit — that would kill every parked pane.
- **The level's reply schema is a literal draft-07 object.** zod's `toJSONSchema` stamps `$schema`
  draft 2020-12, which the claude CLI rejects ("no schema with key or ref"); every tier then
  exits 1 and every question reaches the human. Found live; the unit tests' fake `claude`
  could not see it.
- **Screen chrome** that is never progress: the status/spinner line, user echo, `⏵` mode
  line, the effort indicator (`… · /effort`), and spinner tips (`⎿  Tip: …`).
- **The fake levels** (`test/support/fake-questions.ts`, tests only; issue #134 policy): level
  `opus` answers `fake opus answer`, and escalates when the question says "unsure", "risky" or
  "hard"; level `fable` answers `fake fable answer`, and escalates when it says "risky" or "hard";
  real risk rules still apply.
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
`/api/usage` · `/api/questions[/:id]` · `/api/webhooks` (`{ subscriptions }`, rows of the store,
secrets omitted; the `config` status went with the document, issue #78) · `/api/webhooks/deliveries` ·
**new** `GET /api/sources` → `{ sources: SourceStatus[] }`.
omitted, plus `config: { path, loadedAt, error? }`) · `/api/webhooks/deliveries` ·
**new** `GET /api/sources` → `{ sources: SourceStatus[] }` · `GET /api/machines/config` (issue #18,
"Machines from the UI").

Every request (GET included) must carry `Host: 127.0.0.1:<port>` or `localhost:<port>`, or a
LAN name with the port; anything else is 421 — DNS-rebinding guard. A LAN request reads `/api/`
only with a UI session ("Reaching the UI across the LAN").

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
   expiry `HOPPER_UI_SESSION_HOURS`, default 12), rotate the code, and answer with a
   same-origin HTML page whose inline script stores the token in `localStorage`
   (`jh_session`) and goes to `/`. Mismatch → 403. `localStorage` is scoped to the exact
   origin incl. port, so no other server on `127.0.0.1` can read it. Sessions live in the store
   (`ui_sessions`, migration 6), so a daemon restart does not log the UI out; the row holds
   only the token's SHA-256 and the expiry, never the token. Expired rows are deleted on
   lookup. Logout deletes the row.
4. **`GET /ui/api/session`** with header `x-hopper-session` → `{ authenticated,
   expiresAt? }`. Without a valid session the page is read-only and says how to log in:
   `bash ~/.local/lib/hopper/scripts/open-ui.sh`.
5. **Mutations** — `POST` only, JSON body, all of: header `x-hopper-session` = a live
   session token (constant-time); `Origin` exactly `http://127.0.0.1:<port>` or
   `http://localhost:<port>`; `Sec-Fetch-Site`, when present, `same-origin`;
   `content-type: application/json`. The custom header is the CSRF defence (a cross-site
   page cannot set it or read the token). Any failure → 403 `{ error }`, logged.

| method | path | body | effect |
|--------|------|------|--------|
| POST | `/ui/api/jobs/:id/cancel` | `{}` | engine `cancel(id, "cancelled in UI")` (the source is told) |
| POST | `/ui/api/jobs/:id/approve` | `{}` | engine approve |
| POST | `/ui/api/questions/:id/answer` | `{ answer }` | `QuestionService.answerByHuman` (404/409) |
| POST | `/ui/api/questions/:id/close` | `{}` | `QuestionService.closeByHuman` (404/409): close without answering ("Questions" → Close) |
| POST | `/ui/api/questions/:id/dismiss` | `{}` | `QuestionService.dismissByHuman` (404/409): drop the question; a job still waiting on it is cancelled ("Questions" → Dismiss) |
| POST | `/ui/api/questions/:id/seen` | `{}` | `QuestionService.markSeen` (404): `seenAt` once; clears the nav badge |
| POST | `/ui/api/router-mode` | `{ mode }` | set router mode (phase 5; was `/ui/api/jev`) |
| POST | `/ui/api/plugins` | `{ action, … }` | edit plugins.yaml: one instance's options, select a plugin, add or remove a list role's instance, rescan (phase 5 slice 7, issue #4; "Settled in slice 7") |
| POST | `/ui/api/rules-file` | `{ text, version }` | replace the rules file whole (issue #18, "Question gates"): 400 over 64 KiB, 409 stale `version` |
| POST | `/ui/api/webhooks` | `{ action, name, … }` | edit the webhook subscriptions (rows in the store, issue #78): add (naming a `WEBHOOK_SECRET_*` variable), edit (url, events, active), remove one; answers `GET /api/webhooks`, never a secret (issues #18, #56) (issue #18, "Webhook subscriptions in the UI") |
| POST | `/ui/api/machines` | `{ action, … }` | add, edit or remove one attached machine in plugins.yaml, applied without a restart (issue #18; "Machines from the UI") |
| POST | `/ui/api/device-link` | `{ keep? }` | `{ links }`: `keep`'s code again while it is live, else a fresh login code, as `http://<LAN name>:<port>/#login=<code>`, one per LAN name; 409 without LAN names ("Reaching the UI across the LAN") |
| POST | `/ui/api/logout` | `{}` | drop the session |

Since issue #39 a session may also come from an identity provider, and each mutation needs a UI
role: "Sign-in: none, password, local, OIDC and SAML" (Roles).

**Residual risk, stated.** Still able to act or read:
- A process running **as the owner** that reads `ui-login-code`/`ui-login.html` or the
  browser profile's `localStorage`. That includes Claude jobs running with
  `--dangerously-skip-permissions`.
- Every local user can **read** the GET API, which exposes prompts, issue context and job
  environment.

Blocked: other OS users acting, any web page (cross-site, DNS rebinding via the Host
guard), and local processes that do not deliberately read hopper's or the browser's
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

Config `~/.config/hopper/sources.yaml` (`HOPPER_SOURCES_FILE`), validated with zod;
invalid → the source is `error` with the message, nothing is pulled.

```yaml
version: 1
github:
  enabled: true
  pollSeconds: 60
  owners: []            # discover across repos owned by these; empty → the `gh` user
  repos: []             # allowlist: when non-empty, ONLY these owner/repo are acted on
  authors: [owner]      # required, at least one login: no default allowlist
  label: hopper
  priorityLabels: { "hopper:high": 75, "hopper:low": 25 }
  defaultPriority: 50
  repoPaths: {}         # owner/repo → local path (cwd); default defaultCwd
  defaultCwd: ~/workbench/app-workflows
  executor: herdr-claude
  model: null           # optional claude model for jobs
  progressCommentSeconds: 300
  recentComments: 10    # comments passed into the job's context
  projects: {}          # per repo, optional — see "Priority"
  # projects:
  #   owner/hopper-sandbox:
  #     owner: owner
  #     number: 3
  #     mode: field         # field | rank
  #     field: Priority     # field mode: single-select or number field name
  #     map: { P0: 100, P1: 75, P2: 50, P3: 25 }   # single-select option → priority
```

**Priority** (owner request, phase 3 addition). Both sources are supported, configurable per repo;
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

**Filing labels** (issue #31). Filing a job needs only `label` (`hopper`); every job then runs
at `defaultPriority` (50). Optional, set by a person on the issue:

| label | effect |
|-------|--------|
| `hopper:high` | priority 75: runs before default jobs |
| `hopper:low` | priority 25: runs after default jobs |
| `hopper:backburner` | never picked up while set (not a priority: discovery skips the issue); a waiting job whose issue gets it is cancelled, a running job finishes. Removing the label takes the issue in again on the next poll |

The `hopper:p0`..`hopper:p3` labels are gone: removed from the issues and the watched repos.

`priorityReason` records which one applied, e.g. `project:Priority=P1`, `project:rank=2`,
`label:hopper:high` or `default`. **Re-sorted on every poll:** discovery recomputes the
priority of every eligible item. When a waiting (`queued`/`held`) job's priority changed,
the sync loop updates it and emits `job.reprioritized { from, to, reason }`, then
triggers a decision. Running jobs keep their priority.

**Full issue context into the job** (owner request, phase 3 addition). The prompt is the issue
body, then a block:

```
[hopper issue context]
repo: owner/repo · issue: #N · url: …
title: …
labels: a, b · author: owner
priority: 75 (label:hopper:high) · project item: <project title> · Priority=P1 (or "none")
recent comments (oldest first, up to recentComments; only allowlisted authors, no hopper-marked comments — anyone else's text never reaches the job):
- <author> at <ISO>: <body, ≤ 1000 chars>
...
[how to report on your issue]
Your issue is $HOPPER_ISSUE_URL (repo $HOPPER_REPO, number $HOPPER_ISSUE_NUMBER).
To comment on it: gh issue comment "$HOPPER_ISSUE_NUMBER" -R "$HOPPER_REPO" --body "$(printf '%s\n%s' "$HOPPER_COMMENT_MARKER" "<your text>")"
Always start your comments with $HOPPER_COMMENT_MARKER. hopper posts your status, questions and result for you.
Do not close this issue and do not use "Closes #N" — closing the issue cancels you.
```

Size caps: body ≤ 64 000 chars, context block ≤ 16 000 chars (comments truncated to fit).

Job environment, set on the job's herdr tab with `herdr tab create --env`:
- `HOPPER_ISSUE_URL`, `HOPPER_REPO`, `HOPPER_ISSUE_NUMBER`, `HOPPER_ISSUE_TITLE`
- `HOPPER_COMMENT_MARKER` = `<!-- hopper v1 kind=job-comment -->`
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
No comment write: the port has none.
Real adapter: `gh` CLI via `execFile` (no shell), JSON output, `gh api` for comments/labels,
timeouts, typed errors; env passes through (gh's keyring auth). Fake: an in-memory GitHub
(issues, labels, comments, authors) used by unit and integration tests.

**Discovery:** `repos` non-empty → `listOpenIssues` per repo (no search lag). Else
`searchOpenIssues` over `owners` (or `whoami()`), restricted to repos owned by them —
GitHub search can lag new issues by up to about a minute. Eligible: open, has `label`,
author in `authors`, no `hopper:done` / `hopper:failed` / `hopper:backburner`, repo allowed. Already-claimed
issues with no job here (another machine, a wiped database) are **not** re-run: an issue
labelled `hopper:claimed` with no local job is skipped and shown in status detail.

**Item → job:** key = issue URL; title → goal; prompt = body + issue context (above); env as
above; empty body → claimed, then failed with error "empty issue body"; priority per
"Priority"; cwd = `repoPaths[repo]` (expanded) else `defaultCwd`.

**Write criteria.** The hopper's only issue writes are labels (state) and closing the issue of a
finished job; it posts no comments at all (owner decision, 2026-10-04: a finished issue needs no
comment). A finished job's issue is closed with `state_reason: completed` (issue #38: finished work
leaves no open issue behind); a failed or cancelled job's issue stays open. No claim, progress,
question, answered, failure, cancel or completion comment; no reactions, other issue edits, or PR
comments. Jobs get no way to write to their issue (no token, no helper), and their prompt says
nothing about commenting (owner decision, 2026-10-04: a job has no reason to talk on its issue): the
issue context block ends at the comments list, with no footer. A question goes to the owner through
the UI and the Grok Bot routine webhook, never onto the issue; a reply on the issue is not an
answer.

Comments the hopper posted before this rule start with a hidden marker line (`<!-- hopper v1
kind=… -->`). They remain on issues, so the context filter still drops any comment carrying the
`<!-- hopper v1 ` prefix (and, in app mode, any by the bot).

| report | on GitHub |
|--------|-----------|
| claimed | ensure labels `hopper:claimed`, `hopper:done`, `hopper:failed` exist (`gh label create --force`, once per repo per process); add `hopper:claimed`. **No comment** |
| finished | **no comment**; remove `hopper:claimed`, add `hopper:done` |
| failed | **no comment**; remove `hopper:claimed`, add `hopper:failed` (removing it is the re-run gesture) |
| cancelled | **no comment**; remove `hopper:claimed` |

Progress and questions are not reported to the source at all (`SourceReport` has no such kinds).
Stored `sourceState.source` keys from before this rule (`claimCommentId`, `progressCommentId`,
`questionComments`, `answeredComments`, `finalCommentId`) and `sourceState.sync` keys (`reportedQuestions`,
`answeredQuestions`, `lastProgressAt`) stay in the JSON and are never read; no column changed, no
migration. `progressCommentSeconds` left `sources.yaml`: `migrate-sources-yaml.ts` (install) dropped
its lines; since phase 5 slice 4 the daemon's plugins-file migration drops the key instead (that
script is gone).

A failure never goes to the issue as text. It is one stderr line in the daemon log
(`hopper: job <id> failed (<issue url>): <error>`, `src/engine/failure-log.ts`), the job's
`error` in `/api/jobs`, and the `job.failed` row (with its error) in the UI event feed.

**Signals (check):** per active job, `getIssue`:
- issue `closed`, or `label` removed → `cancel` (reason `issue closed` / `label removed`);
  issue 404/410 → `cancel` (`issue gone`).
- **Except the job's own pull request** (issue #38): a closed issue whose last close event's closer
  is a merged pull request opened at or after the job's `createdAt` gives no signal — that is the
  job's work landing, and the job still has to install and verify. It runs on and ends as it
  reports (`finished` on `HOPPER_DONE`). `closingPullRequest` asks GraphQL
  (`src/sources/github/closer.ts`); a pull request opened before the job, a person, or a commit
  closing the issue cancels as above; a permanent error asking counts as "not its own".
- `hopper:backburner` on the issue of a waiting (`queued`/`held`) job → `cancel` (`backburner`);
  a running job is not touched.
- **Error classes:** `GitHubApi` errors carry `permanent` (404/410/403/422) vs transient
  (network, 5xx, rate limit, timeout). `check` cancels only on a 404 or 410 about the issue
  itself (`issue gone`). Any other error — permanent or not, such as no app configured, refused
  credentials (401), the app not installed on the repo, 403, a missing scope — is about the
  source, not the issue: the job is skipped, the error shown in `checkErrors`, and the next sync
  asks again. Never fails the whole sync for one job. Issue #52: the boot after an install could
  not read the app key, and every active job — running, and waiting on a question — was cancelled
  as `issue gone`. A restart or an update cancels no job.

**Authors outside the allowlist are never acted on** — not as issues, not as answers.

## Webhooks from a file

**Superseded** by "Webhook subscriptions in the database" (issue #78): no file and no document holds
them. Kept as the record of phase 2.

`~/.config/hopper/webhooks.yaml` (`HOPPER_WEBHOOKS_FILE`):

```yaml
version: 1
webhooks:
  - name: grok-bot
    url: http://127.0.0.1:<port>/hook
    events: ["question.escalated", "job.finished", "job.failed"]   # or ["*"]
    secret: "<hex>"              # or secretFile: ~/.config/hopper/grok-bot.secret
    active: true
```

Loaded at startup and re-read when its mtime changes (checked every 5 s), and at once after a
UI edit of it (issue #18, "Webhook subscriptions in the UI"). Reconcile by
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

`HOPPER_SOURCES_FILE` and `HOPPER_GH_BIN` were removed in phase 5 slice 4 (sources.yaml
folded into plugins.yaml `jobSources`; the gh bin is github-gh's `bin` option).

| var | default |
|-----|---------|
| `HOPPER_SOURCES_FILE` | `~/.config/hopper/sources.yaml` |
| `HOPPER_WEBHOOKS_FILE` | `~/.config/hopper/webhooks.yaml` |
| `HOPPER_GH_BIN` | `gh` |
| `HOPPER_UI_SESSION_HOURS` | `12` |

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

# Phase 4 — a GitHub App instead of gh-as-owner (2026-10-03)

The `gh` source acts as the owner: its comments are theirs, so a hidden marker was the only way to
tell them from their replies, and it sees every repo they can see. A GitHub App fixes both: it
posts as its own bot, and **its installations are the repo allowlist**. Polling stays — no
inbound webhook to the laptop.

## Directories added

| dir | owns | must not import |
|-----|------|-----------------|
| `src/sources/github/app/` | the App `GitHubApi` adapter: app config file loader, JWT + installation tokens (`@octokit/auth-app`), REST + GraphQL via `@octokit/request`, per-repo scoped token minting | engine, http, store |
| `scripts/create-github-app.*` | the manifest-flow helper the owner runs once | everything in `src/` except small pure helpers it imports explicitly |

## App configuration (files the owner's one click produces)

`~/.config/hopper/github-app.json` (mode 600):

```json
{ "version": 1, "appId": 123456, "slug": "hopper-<owner>",
  "botLogin": "hopper-<owner>[bot]", "clientId": "Iv23…",
  "htmlUrl": "https://github.com/apps/hopper-<owner>",
  "owner": "<owner>", "privateKeyFile": "~/.config/hopper/github-app.pem",
  "webhookSecretFile": "~/.config/hopper/github-app-webhook.secret",
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
- Comments: read only, paginated, oldest first. Labels add/remove, label create (422
  "already_exists" → ok).
- `projectItems(owner, number)`: GraphQL `projectV2(number)` items with field values.
  - Tried as `organization(login)`, then `user(login)`.
  - GitHub Apps can read **organization** Projects (v2) with `organization_projects: read`.
    **Projects (v2) owned by a personal account cannot be read with an installation token**
    (GitHub's docs: user-owned projects need a personal token). The owner's repos are
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
used for context filtering and answer detection. Config refuses an `authors` list
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
`detail.setup: "run bash ~/.local/lib/hopper/scripts/create-github-app.sh"`. It starts
on its own once the file appears, and re-reads it when its mtime changes (so a `--force`
recreate needs no restart).

**The owner's live file (B1).** The installed `~/.config/hopper/sources.yaml` says
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
- `<dataDir>` is `~/.local/share/hopper`, outside the daemon's `PrivateTmp` and readable
  by the herdr panes.

The path is deterministic from the issue URL, so it is in the job's env at ingest:

| env | value |
|-----|-------|
| `HOPPER_ISSUE_URL`, `HOPPER_REPO`, `HOPPER_ISSUE_NUMBER`, `HOPPER_ISSUE_TITLE` | as phase 3 |
| `HOPPER_COMMENT_MARKER` | as phase 3 (secondary identification) |
| `HOPPER_TOKEN_FILE` | the job's token file (App source only) |
| `HOPPER_COMMENT_CMD` | `~/.local/lib/hopper/scripts/hopper-comment` (App source only, absolute path) |
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
on your issue: `"$HOPPER_COMMENT_CMD" "<your text>"` (posts as the hopper app). **Never
comment with `gh`**: it posts as the owner, and a comment from them after a question reads as
their answer." (N5: panes are still logged in to `gh` as the owner.)

**Residual, stated:** the token file is readable by any process running as the owner, for at
most about an hour, and covers only that repo's issues. That is far narrower than the gh
source, whose job comments ran on the owner's full `gh` login.

## The manifest-flow helper (`scripts/create-github-app.sh`)

`bash ~/.local/lib/hopper/scripts/create-github-app.sh [--name <app-name>] [--owner
<login>] [--no-webhook] [--force]` runs `scripts/create-github-app.ts`:

1. Refuses if `github-app.json` exists (unless `--force`).
2. Starts an HTTP server on `127.0.0.1:<random port>` and generates a random `state`.
3. Serves `/` (the start page): a form that auto-submits `POST
   https://github.com/settings/apps/new?state=<state>` with field `manifest`. The manifest
   is shown below.
4. Opens `http://127.0.0.1:<port>/` with `xdg-open`, and prints it too (with a `qrencode`
   QR if available — this is a desktop page, the QR is a convenience).
5. GitHub shows the owner the prefilled "Create GitHub App" page. They click the create
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
{ "name": "hopper-<owner>",
  "url": "https://github.com/<owner>",
  "description": "Pulls jobs for hopper from issues labelled hopper.",
  "hook_attributes": { "url": "https://example.invalid/hopper-webhook", "active": false },
  "redirect_url": "http://127.0.0.1:<port>/callback",
  "public": false,
  "default_permissions": { "issues": "write", "metadata": "read", "organization_projects": "read" },
  "default_events": [] }
```

- `issues: write` now covers only labels and closing a finished job's issue (write criteria).
  Reading which pull request closed an issue needs nothing more (verified against the live app,
  2026-10-04). The
  app could later drop to fewer permissions; not changed here.

- `hook_attributes` exists only to make GitHub issue a webhook secret for later. The URL uses
  the reserved `.invalid` TLD and the hook is inactive, so nothing is ever delivered.
  `--no-webhook` omits it, in case GitHub refuses the placeholder.
- Contents permission: **not requested**. Jobs work on local clones, and the hopper never
  reads repo contents through the API.
- `--org <name>` posts to `https://github.com/organizations/<name>/settings/apps/new`
  instead (as built; `--owner` only sets the owner login used in the name and homepage).
- `privateKeyFile` / `webhookSecretFile` are written as absolute paths.

Base URLs are overridable (`HOPPER_GITHUB_WEB`, `HOPPER_GITHUB_API`) so tests run the
whole flow against a fake GitHub. `--no-open` skips `xdg-open`.

## The owner's clicks (also in the summary)

1. Run `bash ~/.local/lib/hopper/scripts/create-github-app.sh`. The browser opens on
   GitHub's "Create GitHub App for <owner>" page, prefilled.
2. Click **Create GitHub App for <owner>**. The browser returns to `127.0.0.1` with
   "App created" and an **Install** link; the terminal prints the same link.
3. Click the link → **Install** → **Only select repositories** → pick the repos → **Install**.
   (A private app owned by a user installs only on that user's own account.)
4. Nothing else: within one sync (60 s) the `github-app` source shows `ok` with the
   installed repos, and the `gh` source stops discovering (auto). Restarting is not needed.

To add or remove repos later: https://github.com/settings/installations → hopper →
Configure.

## Configuration added

`sources.yaml`:
```yaml
github:
  enabled: auto            # auto | true | false — auto: on only while no GitHub App is configured
  # … phase-3 keys …
githubApp:
  enabled: true            # still needs ~/.config/hopper/github-app.json (create-github-app.sh)
  appFile: ~/.config/hopper/github-app.json
  repos: []                # optional extra restriction inside the installations
  authors: [owner]        # required, at least one login; never the app's bot
  label: hopper
  priorityLabels: { "hopper:high": 75, "hopper:low": 25 }
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
  `~/.config/hopper/github-app.json` once installed; tests never see the real one).
- **`HOPPER_GITHUB_API`** (env, optional) is the API base for the App adapter, the manifest
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
  mutation removing the bot check therefore survives as an equivalent mutant. The bot
  check also filters old bot comments out of the job's context.
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
- Request: `Authorization: Bearer <key>`, JSON body `{ source: 'hopper', kind, at, jobId,
  issueTitle, issueUrl, question, questionId, answerUrl? }` (title/url from the job's source
  ref, else null).
  200 = a run started.
- Delivery: 10 s timeout; 3 attempts, backoff `base * 2^(n-1)` (base 1000 ms), retried only on
  network error, 429, 5xx; other non-2xx is final. Success logs kind, jobId, status; final
  failure logs an error. The key is never logged. Work runs deferred, off the event listener;
  `stop()` unsubscribes and awaits in-flight posts.
- `createGrokBotNotifier({ name, path, logger, baseMs?, timeoutMs? })` → `Notifier`; the job's
  title and url come from `events.job(id)`. `AppSeams.grokbotBaseMs` lets tests shorten the backoff.

`HOPPER_GROKBOT_WEBHOOK_FILE` was this section's env var; removed in slice 5 ("Settled in slice 5").

## Phase 5 — every part is a plugin (2026-10-03, in progress)

Owner direction (2026-10-03): the **router** (Jev) decides admission. Questions climb
**escalation levels** (owner decision, issue #134, replacing the 2026-10-03 "Fable assesses
questions" and the answerer → assessor pair): each level answers what it can settle or escalates
it to the next, and the owner is above the top level.
Every part is broken out as a **plugin**: any piece can be swapped, writing a custom plugin is
easy, and the choices offered come from what is detected on the machine. Consultant-reviewed
(approve-with-changes, all changes folded in below). Glossary terms land with the slice that
introduces them in code.

### Roles, plugins, instances

A **role** is a slot the engine calls through one port. A **plugin** implements one role. A
**plugin instance** is a plugin plus validated options, under a name.

| role | port | slots | built-in plugins | reload |
|---|---|---|---|---|
| `router` | `Router { name; advise(job) → Advice }` (was `JevAdvisor`) | 1 | `gate-router`, `pass-through` | live |
| `escalation-level` | `EscalationLevel { name; answer(req, signal) → { answer?, escalate, reason } }` | 0..n, in order | `claude-cli` | live |
| `executor` | `Executor` (unchanged) | 1..n | `herdr-claude`, `test` | restart |
| `job-source` | `JobSource` (unchanged) | 0..n | `github-gh`, `github-app` | restart |
| `machine-source` | `MachineSource` (unchanged) | 1 | `local` | restart (an options change is live since issue #18) |
| `usage-source` | `UsageSource` (unchanged) | 0..n | none in production; `fake` stays a test fake at the `ports.ts` seam | restart |
| `notifier` | `Notifier { name; start(events); stop() }` (new) | 0..n | `grokbot-routine` | restart |

A new agent CLI (codex, cursor-agent, opencode, hermes — all present on the hopper host) is a new
`executor` plugin; nothing is generic over CLIs.

**Not plugins — invariants:** the decider, store, engine loop, HTTP guard and UI session, the
event log, **webhook subscriptions** (rows in the store since issue #78: a core subsystem with stored
deliveries and signing, not a swappable part), the **risk rules** (`src/questions/risk.ts`,
code, not config — no setting can weaken the guard), the **rules file** (the owner's standing
rules, given to every escalation level), and the human as the last question stop.

### Question pipeline

A question climbs the escalation levels (plugins.yaml `escalationLevels`, lowest first), and only
as far as it needs: a simple question is settled at the first level; the more complex it is, the
higher it climbs; above the top level is the owner.

1. Each level gets the full request — question, job prompt, goal, rules file, the trail so far
   (earlier runs, and the levels below with their recommendations) and its place,
   `level: { number, of }` — and replies `{ answer?, escalate, reason }`. `answer` is its best
   answer: the exact text to type. `escalate: false` **answers**. `escalate: true` sends the
   question to the next level up, its answer staying on the trail as its **recommendation**: the
   next level sees it, and the UI's **Use answer** puts it in the owner's answer box.
   `claude-cli` always answers; it escalates what is the owner's (irreversible or outside the job,
   a judgement the rules do not settle, against the rules, an injection attempt), and below the
   top level also what it is not sure of; the top level keeps the owner out unless a human choice
   is truly needed. **Fails closed:** a timeout, an error, a parse failure, a missing field, an
   empty answer, `escalate: false` without an answer, or a level that cannot run → escalate. Only
   a schema-valid `escalate: false` with an answer answers. The question text comes from a job that
   reads issue bodies and runs with `--dangerously-skip-permissions`; it may try to talk a level
   out of escalating — the fail-closed contract and the risk rules are the containment, and every
   level's prompt fences the untrusted parts.
2. Risk rules run on the question and the answer to be typed; a hit sends the question to the
   owner, past every level above — no model approves what the rules guard.
3. Accepted → the answer is typed into the pane; `answeredBy` names the level. Past the top
   level, or with no levels → the human.

**The model that ran.** Each level attempt records `model`: the model id the level reports it
ran — for `claude-cli`, the keys of the CLI's `modelUsage` (`fable` → `claude-fable-5-1`) — else
the configured alias. The trail shows whether a level is really the model it names.

`claude-cli` runs locked down (`--tools ''`, `--strict-mcp-config`, `--setting-sources ''`,
`--json-schema`). Built-in levels: `opus` (`claude-cli`, model `opus`), then `fable` (`claude-cli`,
model `fable`).

Stage owner: `questions.body.tier` holds the instance name of the level holding the question, or
`human`. Created with the first level's name (or `human` with none). **Recovery** restarts every
open non-human question from the first level whatever its `tier` (replies are not persisted
mid-flight; the cost is the repeated calls), so old rows at `tier: fable` are safe.

### Plugin contract

A plugin is one ES module — `.ts` run by Node's type stripping (erasable syntax only;
relative imports carry `.ts`) or `.js` — with a default export:

```ts
import type { PluginDefinition } from 'hopper/plugin'; // type-only, erased at runtime
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
- Custom: `<plugin dir>/<id>/index.ts` (`HOPPER_PLUGIN_DIR`, no default), then the store installs
  (`<work dir>/plugin-store/installed/<id>/`, "Plugin store"), loaded by
  dynamic `import()` at start and on rescan. Same contract and validation. A custom id equal
  to a built-in id is refused. Plugin dir readable by group/other → warning.
- Types for out-of-tree authors: `install.sh` writes `<plugin dir>/tsconfig.json`
  mapping `hopper/plugin` to `<install>/src/plugins/sdk.ts`. `npm run plugin:check <dir>`
  type-checks with that mapping, then runs the real loader and `detect`.
  `examples/plugins/<role>/` holds one minimal runnable plugin per role. Author guide:
  `docs/plugins.md`.

### Configuration — `~/.config/hopper/plugins.yaml`

The truth for which instance fills which role. Mode 600, owner-editable, mtime-watched (5 s).
Live roles (router, queue sorter, escalation levels) swap between calls; restart roles show
`changed — restart pending` in `/api/plugins`.

```yaml
version: 1
router:    { name: gate-router, plugin: gate-router, options: { grokBotJevSrc: ~/workbench/jev-src/grok-bot-jev, python: python3, claudeBin: claude, claudeModel: haiku } }
escalationLevels:   # lowest first; above the top level is the owner
  - { name: opus, plugin: claude-cli, options: { model: opus } }
  - { name: fable, plugin: claude-cli, options: { model: fable } }
executors: [ { name: herdr-claude, plugin: herdr-claude, options: { cwd: ~/workbench/app-workflows } }, { name: test, plugin: test } ]
jobSources:
  - { name: github, plugin: github-gh, options: { enabled: auto, bin: gh, appFile: ~/.config/hopper/github-app.json, authors: [owner], label: hopper } }
  - { name: github-app, plugin: github-app, options: { appFile: ~/.config/hopper/github-app.json, authors: [owner], label: hopper } }
machines:  { name: local, plugin: local, options: { lanes: 4 } }
usageSources: []
notifiers: [ { name: grok-bot, plugin: grokbot-routine, options: { envFile: ~/.config/hopper/grokbot-webhook.env } } ]
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
  inputs `*.migrated`. Any leftover `HOPPER_*` var no longer read → a loud boot warning.
  `systemd/hopper.service` changes in the same slice.
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

**Command-bearing options** (owner decision, 2026-10-03, issue #6 option (a)): an
option that names a program, its arguments, a working directory, an interpreter, or a file
that is sourced or executed — `bin`, `args`, `cwd`, `python`, `grokBotJevSrc`, `claudeBin`, `envFile` and their
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
thresholds, an escalation level's model or the levels' order, a source's labels or authors
allowlist. Each can change which jobs are pulled or how a question is answered; none can run a
command, and the levels' fail-closed contract and the risk rules (code, not options) still stand.

### Failure

| role | on create failure or unavailable |
|---|---|
| router | `pass-through`; advice `source: fallback`; `/api/health` says `fallback: true` (also while the router's own advice is `source: fallback`) |
| escalation level | stays in its place and escalates every question it gets (`/api/plugins` `escalationLevels[].active: null`, `reason`); fail safe: a broken level never answers and never hides the levels above |
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
- Migration 16 (issue #134): plugins.yaml `answerer` + `assessor` → `escalationLevels` in the
  place of the first, the answerer then the assessor (a section left out meant the built-in
  instance, written in its place; `answerer: null` drops it; `claude-cli-assessor` →
  `claude-cli`; assessor `always-escalate` meant the owner decides every question → `[]`; a custom
  plugin keeps its id and loads only if it is an escalation-level plugin). Stored trails: every
  attempt gets a `role` (`level`, or `human` for the human's); a `drafted` answerer attempt is
  `escalated` with `escalate: true`. Event payloads unchanged (`target`, `by` are stage names);
  `plugin.installed.role` lists the new roles. A store install of an answerer or assessor plugin
  is refused at load (unknown role).

### Slices (each test-first, each lands runnable)

1. **Plugin core through the router** (landed; "Settled in slice 1" below): SDK + contract, registry, loader (built-in + custom),
   detection kit, `plugins.yaml` (router section) + watch, `GET /api/plugins`, `Router` port,
   `jev-router`, `pass-through`, Jev→router renames and store migrations, `/api/health` shows
   fallback. Glossary first.
2. **Questions** (landed; "Settled in slice 2" below): answerer + assessor roles, pipeline,
   fail-closed assessor, recovery. Replaced by escalation levels (issue #134).
3. **Executors** as plugins (landed; "Settled in slice 3" below); `EXECUTOR_NAMES` removed; held-when-unavailable.
4. **Job, machine, usage sources** as plugins (landed; "Settled in slice 4" below); `sources.yaml` + env
   migration in the daemon; unit file updated.
5. **Notifier** port + `grokbot-routine` (landed; "Settled in slice 5" below).
6. **Examples + `plugin:check`** + plugin tsconfig from `install.sh` (landed; "Settled in slice 6" below).
7. **UI Plugins panel** + `POST /ui/api/plugins` (select, per-instance option editing except
   command-bearing options) + rescan (landed; "Settled in slice 7" below). Issue #6.
8. **Install on the hopper host** (when no herdr-claude job runs) and live verification.

### Settled in slice 1 (2026-10-03)

- **Roles are what exists.** `Role` is `'router'` only; each later slice adds its role to
  `ROLES` (`src/domain/plugins.ts`) with its port. No role is declared before its code.
- **`detect(sys, options)`.** Detection gets the validated options: whether gate-router can run
  depends on its `grokBotJevSrc` and `python`. The catalogue in `/api/plugins` detects each plugin
  with its default options (`{}` parsed); a plugin whose options have no defaults shows
  `needs-setup`. The configured instance is detected with its own options.
- **Router context carries the router mode.** `create(ctx, options)` gets
  `ctx.routerMode()` for the router role (`RoleContext` in `sdk.ts`): Jev is told hopper's
  mode, as before. Other roles will add their own context fields.
- **Fallback, all paths:** unknown plugin, invalid options, detection not `available`,
  `create` throwing → `pass-through` stands in (advice `source: fallback`, reason `router
  <name> unavailable: …`). A router whose `advise` throws (custom plugins may break the
  contract) → fallback advice for that call. `fallback: true` in `/api/health` and
  `/api/router` while either holds, or while the router's own last advice was `source:
  fallback` (gate-router's shim failing); it clears on the next real advice.
- **plugins.yaml in slice 1** (router part superseded by "Router selection"): no file, or a file without `router` → the env-derived instance
  `{ name: jev, plugin: jev-router, options: { jevSrc: HOPPER_JEV_SRC, python:
  HOPPER_PYTHON } }`. An invalid file → the last good router is kept (at start: the
  env-derived one) and the error is in `/api/plugins` `config.error` — the `webhooks.yaml`
  rule. Nothing is written; the daemon-side migration is slice 4. File readable by
  group/other → warning. Unknown top-level keys are refused; the later sections are accepted
  unread.
- **`HOPPER_JEV_ADVISOR`** (removed by "Router selection") accepted only `router` (the installed unit sets it). `fake` is a
  test double at the `Router` seam (`AppSeams.router`), not a plugin and not configurable.
  `HOPPER_JEV_MODE` and `HOPPER_JEV_CHEAP_BOOST` keep their names until slice 4 removes
  part-choosing env; they feed `routerMode` and `routerCheapBoost`.
- **Scratch dir** is `<dataDir>/plugin-data/<id>` — not under the plugin dir, which holds only
  plugin code. gate-router keeps writing `gate-router-runs.jsonl` in the data dir.
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

Owner decision: use a router, configurable from what is on the system and swappable; the Fable
advisor only assesses questions, to decide whether they escalate to the owner. Fable is the **assessor** (`claude-cli-assessor`, model `fable`);
it never routes. (Since issue #134 Fable is the second built-in escalation level, `claude-cli`
model `fable`; still never a router.) The router was `gate-router` only because the env named it.

Supersedes the slice-1 bullets "plugins.yaml in slice 1" (env-derived router) and
"`HOPPER_JEV_ADVISOR`":

- **No router named in plugins.yaml** (no file, no `router` section, or an invalid file at
  start) → the host chooses one from what is detected: the first router plugin in catalogue
  order (built-ins in `BUILTIN_PLUGINS` order, then custom) that detects `available` with its
  default options and starts; the instance is named after the plugin (`gate-router`). None →
  `pass-through`, **chosen, not a fallback** (`fallback: false`, advice `source: pass-through`).
  Detection re-runs on every plugins.yaml reload.
- **Named in plugins.yaml** → that instance, exactly; when it cannot run, pass-through stands in
  as a fallback, as before. Swapping is editing the `router` section (live, between calls).
- `/api/plugins` `router.selection` is `file` or `detected`.
- `HOPPER_JEV_SRC`, `HOPPER_PYTHON`, `HOPPER_JEV_ADVISOR` are removed (no
  compatibility path; a set one is ignored). Jev elsewhere than `~/workbench/jev-src/grok-bot-jev`
  → name `jev-router` with `jevSrc` in plugins.yaml. The installed unit no longer sets
  `HOPPER_JEV_ADVISOR`.
- Picking the router from the UI is slice 7 (`POST /ui/api/plugins` select), unchanged.

### Settled in slice 2 (2026-10-03)

> Superseded by escalation levels (issue #134; "Question pipeline" under Phase 5). The answerer
> and assessor roles, `claude-cli-assessor`, `always-escalate`, `answerer: null` and the
> `drafted` outcome are gone; migration 16 rewrote plugins.yaml and the stored trails. Kept as
> the record of slice 2.

- **Roles:** `ROLES` is `router`, `answerer`, `assessor`. Built-ins `claude-cli` (answerer;
  options `bin` `claude`, `model` `opus`, `timeoutMs` 180000, `effort` optional:
  low|medium|high|xhigh|max → `--effort`), `claude-cli-assessor` (`bin`, `model` `fable`,
  `timeoutMs`), `always-escalate`. Detection: `which bin`, then `<bin> --version`; a failing
  version is `unavailable`. Never a model call.
- **The core validates, never trusts.** The question service parses every draft (`answer`
  string, `confident` boolean, `reason` string) and every assessment (`escalate` boolean,
  `reason` string) with zod. A malformed draft is an answerer error; `{"escalate": "false"}`,
  a missing field, `null`, a string, `{ error }`, a throw or the stage timeout is an assessor
  error — both go to the human. Each call is bounded by `HOPPER_ANSWER_TIMEOUT_MS` in the
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
  claude-cli, options: { bin: HOPPER_CLAUDE_BIN, model: HOPPER_ANSWER_MODEL_A, timeoutMs:
  HOPPER_ANSWER_TIMEOUT_MS } }`, assessor `{ name: fable, plugin: claude-cli-assessor,
  options: { bin, model: HOPPER_ANSWER_MODEL_B, timeoutMs } }`. `HOPPER_ANSWERER=fake`
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
- **herdr-claude options:** `bin` (`herdr`), `claudeBin` (`claude`), `session` (`hopper`;
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
  sessions. The env-derived instance takes `HOPPER_HERDR_SESSION`. This amends "env keeps …
  herdr session" in "Configuration — plugins.yaml"; slice 4 drops the var with the rest.
- **plugins.yaml `executors:`** — 1..n instances, names unique (refused otherwise: a job names
  one). No section → env-derived instances, one per `HOPPER_EXECUTORS` name, each an
  instance of the plugin with that id; `herdr-claude` takes `HOPPER_HERDR_BIN`,
  `HOPPER_CLAUDE_BIN`, `HOPPER_HERDR_SESSION`, `HOPPER_CLAUDE_ARGS`,
  `HOPPER_CLAUDE_CWD`, `HOPPER_TRUST_WORKDIR`, `HOPPER_HERDR_POLL_MS`,
  `HOPPER_IDLE_QUESTION_MS`. `HOPPER_EXECUTORS` accepts any instance-shaped name; an
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
  `args`, `cwd`; claude-cli `bin`; gate-router `grokBotJevSrc`, `python`, `claudeBin`. zod
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
  `bash ~/.local/lib/hopper/scripts/create-github-app.sh`. Never a paid call. **A job source whose
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
  (default `~/.config/hopper/github-app.json`; `null` never pauses). The migration writes the app
  source's app file there, or `null` when `githubApp.enabled` was false — the phase-4 rule as before.
- **Plugins-file migration** (`src/plugins/migrate.ts`, `ensurePluginsFile`), first thing in `startApp`:
  - plugins.yaml exists → nothing (never overwritten; a `sources.yaml` beside it → boot warning
    "no longer read").
  - else build every section: `answerer`/`assessor` (claude-cli `opus` / claude-cli-assessor `fable`,
    `bin` = `CLAUDE_BIN`, models `ANSWER_MODEL_A/B`, `timeoutMs` = `HOPPER_ANSWER_TIMEOUT_MS`),
    `executors` (one per `EXECUTORS` name; herdr-claude with `HERDR_BIN`, `CLAUDE_BIN`, `HERDR_SESSION`,
    `CLAUDE_ARGS`, `CLAUDE_CWD`, `TRUST_WORKDIR`, `HERDR_POLL_MS`, `IDLE_QUESTION_MS`), `jobSources`
    (sources.yaml's `github:` and `githubApp:` blocks as options — their YAML nodes, so comments
    survive — plus `bin` = `GH_BIN`, the gh `appFile`, `apiUrl` = `GITHUB_API`; no `github:` block →
    `{ enabled: false }`, as before; the app's `appFile` beside sources.yaml when unset), `machines`
    (`LOCAL_LANES`), `usageSources: []`. No `router` section: the router stays detected, as before.
    The removed vars keep their old validation and defaults; an invalid one, an unparseable
    sources.yaml or a block that is not a mapping → the boot fails loudly, nothing written or renamed.
  - sources.yaml is `HOPPER_SOURCES_FILE` (read this once more) or `sources.yaml` beside plugins.yaml.
  - written mode 600 to a temp file, then `link`ed into place (fails rather than replace a file that
    appeared meanwhile), then sources.yaml → `sources.yaml.migrated` (`.migrated-<ms>` if taken).
  - nothing to migrate → the same builder with no inputs: the built-in instances (github-gh
    `enabled: false`, github-app on `github-app.json` beside plugins.yaml — what a missing
    sources.yaml meant). Neither names `authors`, which has no default (no implicit
    allowlist), so both stay in `error` until plugins.yaml sets it. So there is always one file. An absent section later means those same
    built-in instances (`builtinInstances`), not the env.
- **Env keeps process settings only:** host, port, db, tick, router mode (seed) and cheap boost, the
  decider's limits and lane idle grace, webhook base, `HOPPER_ANSWER_TIMEOUT_MS` (kept: it is the
  question service's per-stage ceiling, a bound on every plugin whatever its own `timeoutMs` — the
  fail-closed containment, not a part's option), rules file, human renotify/timeout, resume boost,
  max questions, keep panes, webhooks file, Grok Bot env file (removed in slice 5), UI session hours, plugin dir,
  plugins file. Removed, no compatibility path: `EXECUTORS`, `HERDR_BIN`, `HERDR_SESSION`,
  `HERDR_POLL_MS`, `CLAUDE_BIN`, `CLAUDE_ARGS`, `CLAUDE_CWD`, `TRUST_WORKDIR`, `IDLE_QUESTION_MS`,
  `ANSWERER` (`fake`: the doubles are test seams now, `test/support/fake-questions.ts`),
  `ANSWER_MODEL_A`/`_B`, `LOCAL_LANES`, `SOURCES_FILE`, `GH_BIN`, `GITHUB_API` (the daemon's: now
  github-app `apiUrl`; `scripts/create-github-app.ts` still reads it). Renamed: `JEV_MODE` →
  `ROUTER_MODE`, `JEV_CHEAP_BOOST` → `ROUTER_CHEAP_BOOST` (glossary: "Jev mode" is not a word).
- **Leftover variables:** `loadConfig` puts every set `HOPPER_*` key it does not read into
  `config.leftoverEnv` unvalidated; `startApp` prints one `WARNING: set but no longer read …` line
  naming them all, on every boot, migration boot included.
- **Command-bearing marks added:** github-gh `bin`, `appFile`, `defaultCwd`, `repoPaths`; github-app
  `appFile`, `defaultCwd`, `repoPaths`, `apiUrl`. `apiUrl` is where the app's JWT and installation
  tokens are sent; `appFile` selects the private key and so the identity the source acts as — a UI
  session must change neither. `local` has none.
- **Dropped keys:** the migration deletes `progressCommentSeconds` from both blocks (no progress
  comment exists since the T009 rule, 2026-10-03; the options schemas are strict), covering what
  `migrate-sources-yaml.ts` did for it at install.
- **Unit file and install:** `systemd/hopper.service` sets only `HOPPER_HOST`, `_PORT`,
  `_PLUGINS_FILE`, `_WEBHOOKS_FILE` (a test checks none is a leftover). `install.sh` no longer writes
  or edits sources.yaml (`scripts/migrate-sources-yaml.ts` is gone); when plugins.yaml is absent and
  an old unit is installed, it restarts the daemon once on the new code **under the old unit** and
  waits for plugins.yaml, so the migration reads that unit's environment — then installs the new
  unit. A fresh install gets the built-in instances (gh off, app source waiting for
  create-github-app.sh, both needing `authors`), no longer a gh-auto starter.
- **Tests:** `startTestApp` writes plugins.yaml (`TEST_PLUGINS`: executor `test`, no job sources) and
  passes the fake question doubles and the fake usage source as seams; `AppSeams.github` /
  `.githubApp` swap the GitHub plugins' adapters (detection then `available`), like `.herdr`.
- **No store migration.** Instance names equal the old source and executor names; jobs, sync state
  and lanes are keyed as before. The owner's sources.yaml survives as `sources.yaml.migrated`.

#### Configuration (env), as of slice 5

| var | default |
|-----|---------|
| `HOPPER_HOST` | `127.0.0.1` |
| `HOPPER_PORT` | `4790` |
| `HOPPER_DB` | `~/.local/share/hopper/hopper.db` |
| `HOPPER_TICK_MS` | `2000` |
| `HOPPER_ROUTER_MODE` | `shadow` (initial router mode only; the stored setting wins once set) |
| `HOPPER_SOFT_LIMIT` / `HARD_LIMIT` | `0.7` / `0.95` |
| `HOPPER_ROUTER_CHEAP_BOOST` | `10` |
| `HOPPER_WEBHOOK_BASE_MS` | `1000` |
| `HOPPER_LANE_IDLE_GRACE_MS` | `5000` |
| `HOPPER_ANSWER_TIMEOUT_MS` | `180000` — the question service's per-stage ceiling |
| `HOPPER_RULES_FILE` | `~/.config/hopper/rules.md` |
| `HOPPER_HUMAN_RENOTIFY_MS` / `HUMAN_TIMEOUT_MS` | `900000` / `86400000` |
| `HOPPER_RESUME_BOOST` | `20` |
| `HOPPER_MAX_QUESTIONS` | `5` |
| `HOPPER_KEEP_PANES` | `false` |
| `HOPPER_WEBHOOKS_FILE` | `~/.config/hopper/webhooks.yaml` |
| `HOPPER_UI_SESSION_HOURS` | `12` |
| `HOPPER_PLUGIN_DIR` | `~/.config/hopper/plugins` |
| `HOPPER_PLUGINS_FILE` | `~/.config/hopper/plugins.yaml` |
| `HOPPER_AUTH_FILE` | `~/.config/hopper/auth.yaml` (issue #39, "Sign-in: none, password, local, OIDC and SAML") |
| `HOPPER_PUBLIC_URL` | unset (issue #39) |
| `HOPPER_UPDATE_CHECK_MS` | `900000` — self-update check interval; `0` only when asked ("Self-update") |
| `HOPPER_RESTART` | unset (detected) — `exit` or `respawn` after an update ("Self-update") |

### Settled in slice 5 (2026-10-03)

- **Role:** `ROLES` adds `notifier` (0..n, a restart role). Port `Notifier { name; start(events);
  stop() }` (`src/domain/ports.ts`); `events` is `NotifierEvents { subscribe(listener) → unsubscribe;
  job(id) }` — the event log's feed plus the job an event names (Grok Bot's payload carries the
  issue title and url). `/api/plugins` `notifiers` has the restart-role shape (`instances`,
  `pending`). `PluginHost.startNotifiers(events)` / `stopNotifiers()` are called by `main.ts`
  where the Grok Bot notifier used to start and stop (stop awaits in-flight posts).
- **Built-in `grokbot-routine`**, one option `envFile` (default `~/.config/hopper/grokbot-webhook.env`),
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
    `HOPPER_GROKBOT_WEBHOOK_FILE` if set (read this once more), else `grokbot-webhook.env`
    beside plugins.yaml. The variable alone counts as a migration.
  - plugins.yaml without `notifiers` (slice 4 installed first): **chosen: the built-in instance for
    an absent section**, not a section-level rewrite. It is the rule every section already follows
    since slice 4 ("an absent section means the built-in instances"), it writes nothing into
    the owner's file, and it cannot race an edit. The built-in `grok-bot` instance's `envFile` is
    `grokbot-webhook.env` beside plugins.yaml — never a hardcoded home path. Cost, accepted: a
    non-default `HOPPER_GROKBOT_WEBHOOK_FILE` beside an existing plugins.yaml is not carried
    over; the leftover-variable warning names it, and the fix is a `notifiers` section. The
    installed unit never set it. `notifiers: []` = no notifiers.
- **`HOPPER_GROKBOT_WEBHOOK_FILE` removed** (no compatibility path; leftover warning). `src/grokbot/`
  moved to `src/plugins/notifier/grokbot-routine/`.
- **No store migration.** Nothing was ever stored for Grok Bot.

### Settled in slice 6 (2026-10-03)

- **Examples:** `examples/plugins/<role>/<id>/index.ts`, one per role — router `proceed-all`,
  escalation level `canned-answer`, executor `echo-executor`, job source
  `static-items`, machine source `fixed-machine`, usage source `fixed-usage`, notifier `log-events`.
  Type-checked by `npm run typecheck` (tsconfig includes `examples/`) and by `plugin:check` (a test
  runs it over `examples/plugins` and asserts one per role in `ROLES`, so a new role needs an
  example). A test copies `echo-executor` into an ad-hoc daemon's plugin dir and runs a job on it.
  The SDK now also exports `SourceItem`, `SourceSignal`, `SourceReport` (a job source needs them).
- **`npm run plugin:check <dir>`** (`scripts/plugin-check.ts`): `<dir>` is one plugin or a tree of
  them. Type-check through a throwaway tsconfig in the temp dir (never written into `<dir>`), with
  `module: preserve` / `moduleResolution: bundler` — a plugin dir has no package.json, and under
  `nodenext` its `.ts` files would be CommonJS to tsc while Node runs them as ES modules. Then per
  plugin: `importPlugin` (the loader's), the built-in-id check, options parsed from `{}`, `detect`
  with the real kit. **Failures:** type errors, a module that is not a plugin, a taken id, options
  without defaults (the catalogue would show `needs-setup`), `detect` throwing. **Not failures:**
  `unavailable` / `needs-setup` (the plugin may not run on this machine). `create` is not called (it
  may start real work). Needs the dev dependencies: run it from a checkout, not the install (which
  is `npm ci --omit=dev`) — it says so when typescript is missing.
- **Plugin tsconfig:** `install.sh` runs `scripts/write-plugin-tsconfig.ts "$PLUGIN_DIR"
  "$DEST/src/plugins/sdk.ts"` (`PLUGIN_DIR` = `HOPPER_PLUGIN_DIR`; skipped
  when it is unset), mode 600, the dir created 700. **No-clobber rule, chosen:** the
  file starts with a hopper marker line and is rewritten on every install while that line is
  there (an install can move the SDK); without it the file is the owner's and is kept byte for
  byte, with a note. Deleting the line is how the owner takes it over. The install has no
  `@types/node`, so `node:` imports are untyped in an editor unless the author adds it.
- **Author guide:** `docs/plugins.md`.

### Settled in slice 7 (2026-10-03, issue #6)

Built alongside slices 4-6 and merged after them. The edit path is generic over roles:
`SECTIONS` in `src/plugins/edit.ts` maps every role (router, queue-sorter, escalation-level, executor,
job-source, machine-source, usage-source, notifier) to its plugins.yaml key and cardinality, and
the host's `instances()` lists what is configured. So a **lane** count (the machine instance's
`lanes`) and a **connector** (a job source or notifier instance) are editable with the same
per-instance form; restart roles show `changed — restart pending` after an edit (the lane count
applies live since issue #18, "Machines from the UI").

- **`POST /ui/api/plugins`**, body by `action`:
  `{ action: 'options', role, name, options, version }` · `{ action: 'select', role: router |
  queue-sorter, plugin, version }` · `{ action: 'move', role: escalation-level, name, to, version }`
  (issue #134) · `{ action: 'rescan' }`. Answers the new
  `GET /api/plugins` report. 400: body or options invalid (zod's issues); 404: no such instance or
  plugin; 409: stale `version`, an invalid or unparseable plugins.yaml (never edited from the UI —
  fix it by hand), a command-bearing value that differs, a plugin of another role or not
  `available` here.
- **`version`** is the sha-256 of plugins.yaml's bytes, or `missing` — not the mtime the design
  first named: two writes inside one mtime tick with equal size would compare equal.
  `GET /api/plugins` carries it as `config.version`, and `instances[]` (`{ role, instance }`):
  what plugins.yaml names now, or the built-in instance for a role with no section — the thing
  an edit acts on. For a detected router (no `router` section) it is the detected instance;
  editing or selecting it writes a `router` section, so selection becomes `file`.
- **One instance's part only.** An options edit replaces that instance's `options` node in place
  (`yaml` Document API); comments, other sections, and other entries' text stay byte for byte;
  long lines are never refolded (`lineWidth: 0`). A role with no section is written whole from
  what is configured, that one instance changed. With no file, the edit writes
  `version: 1` plus that section; the other roles stay the built-in instances (the boot always writes a plugins.yaml, so this is rare). Every write is validated
  against the plugins.yaml schema first, then written atomically (temp file, rename, mode 600),
  then reloaded before the answer: live roles answer with the new instance, restart roles show
  `changed — restart pending`.
- **Command-bearing:** keys with `commandBearing: true` in the plugin's JSON Schema. Both sides are
  parsed with the plugin's schema before comparing, so sending the current value or omitting a
  key that is at its default is accepted. The UI shows these values with a "plugins.yaml only"
  tag and always sends them back unchanged.
- **Select** fills the role with `{ name: <plugin id>, plugin }` and the plugin's defaults (only a
  plugin `available` with its defaults is offered, so the defaults parse). Selecting the
  configured plugin is a no-op (options are kept). A one-instance role is never empty (`plugin:
  null` is 400).
- **Rescan** re-reads the plugin dir and re-runs every detection. A new custom plugin appears; a
  changed module of one already loaded keeps its first code until restart (Node caches imports).
- **Add and remove** (issue #4): `{ action: 'add', role, plugin, name, version }` and
  `{ action: 'remove', role, name, version }`, for the **list roles** only (`escalation-level`, `executor`,
  `job-source`, `usage-source`, `notifier`; 400 for any other). Add appends `{ name, plugin }` (the
  plugin's defaults; written in the style of the entry before it) and is refused like select: 409
  for a name the role already has, a plugin of another role or not `available` here; 404 for an
  unknown plugin. Remove deletes that one entry, every other line byte for byte; 404 when not
  configured. A role with no section is written whole from the built-in instances, with the change.
  The last job source, usage source or notifier may go (`[]`: none — never the built-in ones);
  the last executor may not (400, the file schema's 1..n). An executor still named by a job source's
  `executor` (its default included), a routing rule or an attached machine's `executors` is refused
  (409, naming each) — change those first; a job that names a removed executor is held, as with any
  unregistered one ("Settled in slice 3"). All four are restart roles: the change shows `changed —
  restart pending`. **Disable is remove**: no `enabled` field; plugins.yaml is the record, and git
  or a backup keeps the old entry. An edit first reloads plugins.yaml when the watch has not yet,
  so it acts on the file the `version` names.
- **UI:** the Plugins view (`ui/src/views/plugins.tsx`; model `ui/src/model/plugins.ts`, tested
  from `test/ui/plugins.test.ts`): plugins.yaml path, source, errors and Rescan; per role a plugin
  selector (one-instance roles) or an Add form (list roles: plugin, name — empty: the plugin id),
  and one form per instance (a list role's with Remove, confirmed), generated from the options' JSON
  Schema (string, number, boolean, enum, string list, else JSON); restart roles show `changed —
  restart pending`. Unsaved edits survive redraws; the view refreshes every 15 s unless a form
  holds unsaved edits. (Built first as `src/ui/plugins.js`; ported when the UI rework landed.)

## Attached machines (issue #10, 2026-10-04)

Owner request: attach other machines to the hopper and run jobs on them, for example a laptop
reached over ssh that has herdr, as a target.

An **attached machine** is a target beside this machine. An ssh target runs jobs in its own herdr session, reached over ssh; a container target is reached over docker exec ("Container targets" below).
It is a machine beside `local`: the decider sees it in `DecisionInputs.machines` and assigns jobs
to it by the unchanged rule (online, runs the executor, most remaining room). Nothing else in the
decider changes.

**Configuration** — plugins.yaml, followed without a restart since issue #18 ("Machines from the UI").
An instance of the machine-source plugin `ssh` since issue #74 ("Attached machines are machine-source
instances"); the fields below are its options, its instance name the machine id:

```yaml
machines:
  - { name: local, plugin: local }
  - { name: laptop, plugin: ssh, options: { ssh: laptop, lanes: 2, herdrBin: /home/user/.local/bin/herdr } }
```

| field | default | |
|---|---|---|
| `name` | — | the instance name: the machine id; unique among `machines:` |
| `ssh` | — | ssh destination (`~/.ssh/config` alias or `user@host`); must not start with `-` |
| `lanes` | `1` | its `maxLanes`, ≥ 1 |
| `executors` | `[herdr-claude]` | executor instances that run there |
| `label` | `name` | |
| `session` | `hopper` | hopper's herdr session there; never `default` |
| `hostKey` | — | the **pinned host key**, `<type> <base64>`; absent → the hopper does not connect ("Target authentication") |
| `herdrBin` | `herdr` | **give the absolute path.** Each call is a fresh login shell there; on the laptop the shell env file is a symlink that every new pane's shell updates, and a call racing that update lost its PATH (`zsh:1: command not found: herdr`, exit 127, seen live) |

**Reaching it** (authentication: "Target authentication" below; the argv here predates it). `createHerdrCliClient({ ssh: { target, controlDir } })` runs the same herdr argv as
`ssh -F ~/.ssh/config -o BatchMode=yes -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPath=<dataDir>/ssh/%C
-o ControlPersist=60 -- <target> '<argv, POSIX single-quoted>'`. `-F` names the user's config only
(`/dev/null` when there is none): under the hopper unit (PrivateTmp, so a user namespace) the
root-owned files in `/etc/ssh` look foreign-owned and ssh refuses them ("Bad owner or permissions",
seen live 2026-10-04, issue #58), as the self-update mirror found before. The remote login shell must read
POSIX single quotes (sh, bash, zsh; not fish). One shared connection per target (the probe and every
job share it). ssh's own failure (exit 255) is `HerdrError` code `ssh`; herdr's JSON errors come back
as they do locally. A unix socket path is capped at 108 bytes: `<dataDir>/ssh/` plus 40 hex chars
must fit (`~/.local/share/hopper/ssh/…` does).

**Online.** `herdr --session <session> status server` over ssh says `status: running`. Probed in the
background at most every 30 s; `list()` never waits, so a machine that is off or asleep never stalls
a Decision (every Decision awaits every machine source). Offline until
the first probe answers. Transitions are logged once per reason (`hopper: attached machine
laptop online (ssh laptop)` / `… offline: <reason>`). Offline → the decider gives it nothing; a
waiting-answer job whose pane is there stays pinned (`resumeOn`) and waits.

**Executors are told the machine.** `ExecutionContext.machine` is the lane's `MachineSnapshot`
(`ssh` and `herdr { bin, session }` on an attached one); the runner looks it up per run. herdr-claude
drives that machine's herdr and records `ssh`, `herdrBin`, `session` in its pane state, so resume,
reattach and cleanup (which have only the job) reach the same herdr. Pane ids are per herdr server:
held panes are keyed by machine and pane. An executor that cannot run elsewhere is simply not listed
in the machine's `executors`.

**Working directories are the same paths there.** A job's `cwd` (payload, or the instance's `cwd`) is
resolved on this machine (`~` expanded here) and must exist on the attached one; the laptop has
`~/workbench/app-workflows` with its own checkouts. A missing cwd fails the job at `tab create`.

**Preparing a machine:** `bash scripts/attach-machine.sh <ssh-target> [lanes]` — checks herdr and
claude there, installs `systemd/hopper-herdr.service` there, `enable --now`s it, warns without
linger, confirms the session runs, and prints the plugins.yaml lines with the resolved `herdrBin`.

**Verification:** `HOPPER_REAL_SSH=<target> npm test -- test/integration/attached-real.test.ts`
runs a real Claude job there (throwaway session) through the composition root. Passed against
`laptop` 2026-10-04.

**Live since issue #18:** attached machines are followed live, so `/api/plugins` never
shows them pending; the Machines view adds, edits and removes machines ("Machines from the UI").
**In the machine-source role since issue #74**: each attached machine is an instance of `ssh`,
`docker` or `client` beside `local` in `machines:` ("Attached machines are machine-source instances").
Until then it sat beside the role, in its own `attachedMachines:` section.

## Container targets (issue #58, 2026-10-04)

Owner request: the hopper connects to and runs jobs on more than one machine — a laptop over ssh
(above), and a second machine run as a container **with no agent of any kind in it**, reached over a
protocol other than ssh, to show the hopper supports more than one connection. Owner decision: no
Claude and no other agentic AI in the container; it is a plain machine that only executes — the
hopper runs plain commands in it and gets their results. Its role is a **target** (never
"consumer").

A **container target** is an attached machine whose entry names a `docker` container in place of an
`ssh` destination. Its **connection** is `docker exec` through this machine's docker CLI, which speaks
the Docker Engine API over the docker socket. Nothing of the hopper is installed in the container,
and it runs no sshd and no herdr.

```yaml
executors:
  - { name: command, plugin: command }
machines:
  - { name: local, plugin: local, options: { lanes: 4, executors: [test, herdr-claude] } }
  - { name: box, plugin: docker, options: { docker: hopper-target, lanes: 1 } }   # executors default: [command]
routing:
  - { name: commands to the box, match: { label: on-box }, set: { machine: box, executor: command } }
```

| field | default | |
|---|---|---|
| `docker` | — | the container's name or id; must not start with `-` (plugin `docker`) |
| `executors` | `[command]` | `[herdr-claude]` for an ssh target |
| `session`, `herdrBin`, `hostKey` | — | refused (unknown options of `docker`): it has no herdr |

**Reached** only through the hopper's **docker socket** (`HOPPER_DOCKER_HOST`, "Target authentication"):
`docker --host <it> exec …`; without it a container target stays offline.

**Online** while `docker container inspect` says the container runs; a missing container is
offline, not an error. Same background probe as an ssh target (at most every 30 s, `list()` never
waits). A pinned job waits while its target is offline (`pinned machine box offline`).

**The command executor** (built-in plugin `command`, opt-in: not in the built-in instances) runs a
job's `body` on the job's machine through that machine's connection: `docker exec -- <container>
env K=V… sh -c <script>` on a container target, the same argv POSIX-quoted over ssh on an ssh
target, directly on this machine. The script is the body's first fenced code block, else the whole
body. The body is the issue's own text, without the issue context block: the job source puts it in
the payload as `body` beside `prompt`. The job's issue variables (`HOPPER_ISSUE_URL`, …) and
`HOPPER_JOB_ID` are set. The working directory is the connection's default (the container's
workdir; the ssh login's home): a job's `cwd` names a path on this machine. Exit 0 → finished with
`{ machine, exitCode, stdout, stderr }` (each stream's last 16000 characters); anything else → failed
with the exit code and the output's tail. `timeoutMs` (default 600000) and a cancel kill the client
process; a `docker exec` already started in the container may outlive it. Not idempotent, no
questions, nothing to reattach: a restart fails a running command job, never re-runs it.

**Where commands may run.** The command executor runs anything an allowlisted issue author writes,
like herdr-claude with `--dangerously-skip-permissions`. To keep command jobs on the container,
this machine's `local` instance takes an `executors` option that narrows what runs here (absent:
every registered executor); with `command` left out, an unpinned command job can only go to a target
that lists it. herdr-claude refuses a container target outright (`herdr-claude does not run on
container target …`): with no `ssh` it would otherwise drive this machine's herdr.

**Preparing it:** `bash scripts/container-target.sh <container> [lanes]` — alpine, `--network none`,
read-only root, every capability dropped, `no-new-privileges`, `/tmp` a tmpfs, `--restart
unless-stopped`; the main process is `sleep infinity`. Re-running keeps a running container. Prints
the plugins.yaml lines. A machine edit can change a container target's lanes, executors and label;
adding one from the UI is not built (the add form attaches ssh targets).

**Verification:** `test/integration/container-target.test.ts` — a real container, the real probe, a
GitHub issue routed there runs and finishes with the container's output; `test/adapters/command-executor.test.ts`
— the executor over docker, ssh and here.

## Target authentication (issue #59, 2026-10-04)

Owner request: the hopper proves itself securely to every target it connects to; security first, no
shortcuts. SSH: key-based authentication only, no passwords. Docker: access control on the socket.
HTTP: tokens. Owner answer on HTTP: machines run an installed hopper client, are registered with the
hopper, and connect back to it over a reverse tunnel ("Client targets" below).

| target | the hopper proves itself by | the target proves itself by | refused |
|---|---|---|---|
| ssh target | the **hopper's ssh key**, alone | its **pinned host key** | passwords, keyboard-interactive, GSSAPI, host-based, the user's agent and other keys, an unpinned or changed host key, jump hosts, forwarding |
| container target | holding a **docker socket** only its user may open, which lets through only its targets | — (this machine's docker) | the root daemon's socket, a group- or world-openable socket, a TCP daemon, any `DOCKER_*` variable |
| client target | an HMAC of the **client token** on every request | an HMAC of the token on every answer; its tunnel key | an unsigned, stale (30 s), replayed or altered request; an answer it did not sign |

**ssh** (`src/executors/ssh.ts`; every ssh call: herdr over ssh, the probe, the command executor, adding
a machine). The destination is resolved once with `ssh -G -F <the user's config>` (host, user, port;
a `ProxyJump` or `ProxyCommand` there is refused); the connection reads no config (`-F /dev/null`) and
carries on its command line `src/client/ssh-options.ts`: `PreferredAuthentications=publickey`,
`PasswordAuthentication=no`, `KbdInteractiveAuthentication=no`, `GSSAPIAuthentication=no`,
`HostbasedAuthentication=no`, `IdentitiesOnly=yes`, `IdentityAgent=none`, `StrictHostKeyChecking=yes`,
`GlobalKnownHostsFile=/dev/null`, `UpdateHostKeys=no`, `CheckHostIP=no`, `VerifyHostKeyDNS=no`, no
agent, X11 or port forwarding, `BatchMode=yes`; then `-i <the hopper's key>`,
`UserKnownHostsFile=<workdir>/ssh/known_hosts`, `HostKeyAlias=<target>`. The key is the mounted secret
file `HOPPER_SSH_KEY_FILE` names (a variable is refused: ssh reads keys from files only; others
must not be able to read it). The known_hosts file holds one line per ssh target, written from each
machine's `hostKey` whenever plugins.yaml changes; a machine without one, or two machines pinning
different keys for one target, is never connected to (logged once). A target name is a plain name
(`[A-Za-z0-9_.-]`, optionally `user@`). On the target the key is installed with `restrict` (no pty, no
forwarding): `HOPPER_SSH_KEY_FILE=<key> bash scripts/attach-machine.sh <target>` adds it once and
prints the entry with its `hostKey` — the key the user's own `~/.ssh/known_hosts` holds for the
target, never one learned from a connection. Adding a machine from the UI pins the same way
(`resolveSshTarget`): a target the user has never connected to by hand is refused. The target's own
sshd may still accept passwords from others; the hopper never offers one (proven against a real sshd
that does: `test/integration/ssh-auth-real.test.ts`).

**docker** (`src/executors/docker.ts`). Docker's socket has no authentication: whoever opens it is root
on this machine, and the root daemon's socket opens to the whole docker group. So the hopper uses only
`HOPPER_DOCKER_HOST=unix://<path>`, checked before every call: a socket owned by its user, mode
without group or other bits, in a directory owned by its user that others may not write. There is no
default. Every call is `docker --host <it> …` with no `DOCKER_*` variable in its environment. The
daemon's unit makes the root socket inaccessible (`InaccessiblePaths=-/run/docker.sock
-/var/run/docker.sock`). In practice the socket is the **docker socket proxy**: `bash
scripts/docker-proxy.sh <container>...` runs `wollomatic/socket-proxy` (pinned by digest; no network,
read-only, no capabilities, restarted with docker) on `~/.local/state/hopper/docker/docker.sock`
(mode 600), allowing `HEAD /_ping`, `GET /_ping`, `GET /v1.N/containers/<target>/json`,
`POST /v1.N/containers/<target>/exec`, `POST /v1.N/exec/<id>/start`, `GET /v1.N/exec/<id>/json` —
everything else is 403. Re-run it with every container target when one is added. **Residual risk:**
the proxy checks paths, not bodies, so an exec it lets through could ask for `Privileged` or another
user in that container; only the hopper's own code writes those requests.

**client** ("Client targets"): HMAC-SHA256 over method, path, timestamp, nonce and the body's hash,
keyed with the client token; the client accepts it within 30 s and once, and signs its answer over the
request's nonce, status and body. The token itself never crosses the wire. node:crypto (HMAC,
`timingSafeEqual`), not a library: the client installs as plain files with no `node_modules`, and the
construction is a few lines over node's own primitives.

**Configuration** (daemon.env, beside the other secrets): `HOPPER_SSH_KEY_FILE`,
`HOPPER_DOCKER_HOST`, and each client target's token (`<tokenEnv>` or `<tokenEnv>_FILE`).

## Client targets (issue #59, 2026-10-04)

A **client target** is an attached machine that runs the **hopper client** and dials this machine;
the hopper never connects to it directly.

```yaml
machines:
  - { name: studio, plugin: client, options: { tokenEnv: CLIENT_TOKEN_STUDIO, lanes: 1 } }   # executors default: [herdr-claude]
```

| field | | |
|---|---|---|
| `tokenEnv` | — | the variable holding the client token in the daemon's runtime (or `<it>_FILE`); `[A-Z_][A-Z0-9_]*` (plugin `client`) |
| `name` | — | letters, digits, `_`, `-`: it names the tunnel's socket (else the instance cannot run) |
| `session`, `herdrBin`, `hostKey` | — | refused (unknown options of `client`): the client names its herdr itself, and its tunnel pins the keys |

**The tunnel.** The client (`src/client/tunnel.ts`) runs `ssh -T` to this machine with the hardened
options, its own key (made on the client; the private half never leaves it) and this machine's pinned
host key (read from `/etc/ssh/ssh_host_ed25519_key.pub` here by the installer). The key's line in this
user's authorized_keys is `restrict,command="<node> <app>/src/client/relay.ts
<workdir>/clients/<name>.sock" <key> hopper-client:<name>`: no shell, no forwarding of any kind —
the key can do nothing but open its own socket. The **relay** writes a marker line (the client skips
whatever the login shell printed before it), listens on that socket (mode 600, a stale socket
replaced), takes the daemon's one connection and pipes it to the session. The client serves HTTP/2 on
the session's stdin and stdout. When either end goes, the relay exits and the client dials again
(1 s, 2 s, 5 s, 10 s, then every 30 s; back to 1 s after a minute up).

**The calls.** `POST /herdr {args, timeoutMs}` → `{code, stdout, stderr}`: the client runs `<its
herdr> --session <its session> <args>` with no shell; `--session` in the args is refused, so is
anything but a signed `POST /herdr` (401, 404, 400, 413 over 1 MB). The daemon keeps one HTTP/2
session per socket (`src/executors/client.ts`); `createHerdrCliClient({ client })` maps the answer as
the CLI's exit codes map (2 → usage, JSON on stderr → herdr's error). herdr-claude runs there like on an
ssh target and records `client: { machine, tokenEnv }` in its pane state, so resume, reattach and
cleanup reach the same client. The command executor refuses a client target (it serves herdr only).

**Online** while `status server` through the tunnel says `status: running`, answered and signed by
the client; offline when there is no tunnel, the token is missing, or the answer does not prove
itself.

**Installing one** (on this machine, as the daemon's user): `bash scripts/attach-client.sh <name>
<ssh-target> <user@this-host> [lanes]` — over the user's ssh: checks node ≥ 24 and herdr there,
installs the hopper's client release (the client files of `$HOPPER_APP_DIR/src/client`, "Client
releases") to `~/.local/lib/hopper-client/`,
the token, the pinned host key and `client.env` to `~/.config/hopper-client/` (mode 700; files
600), the units `hopper-client` and `hopper-client-herdr` (its own herdr session,
`hopper-client` unless `HOPPER_CLIENT_SESSION`), and starts them; here: mints the token to
`~/.config/hopper/clients/<name>.token` (600) and adds the key's line. Prints the daemon.env line
(`<tokenEnv>_FILE=…`, then restart the daemon) and the plugins.yaml entry. Re-running keeps the token
and the key.

**Residual risk.** The client's key logs in as the daemon's user, restricted to the relay; the relay is
the only thing it can run. The daemon trusts nothing from a client but the herdr answers it signed.

## Client releases (issue #70, 2026-10-05)

The hopper client is released from the hopper and loaded onto its client targets by the hopper: no
client target runs a client the hopper did not release.

- **The release** (`src/client/release.ts`) is the client's files — `CLIENT_FILES`: `main.ts`,
  `release.ts`, `server.ts`, `signature.ts`, `ssh-options.ts`, `tunnel.ts`; never `relay.ts`, which runs
  here — and an id, the first 16 hex of a SHA-256 over every name and content. Same files, same id. The
  hopper's release is the client files of the install it runs from (`<app>/src/client`), read at boot:
  `scripts/install.sh` and a self-update ("Self-update") release a new client whenever its files change.
- **The calls**, signed like `POST /herdr`: `POST /release {}` → `{release}`, the id of the release the
  client process runs (read from its install dir at start); `POST /load {release: {id, files}}` → the
  client checks the release whole (exactly `CLIENT_FILES`, all text, the id its files') before writing a
  byte, writes it to `<install>.next`, swaps it in (the one before kept as `<install>.prev`), answers
  `{release}`, and 1 s after that answer has left (time for it to cross the tunnel) exits 75; its unit
  (`Restart=always`) starts the new files. A load of the release
  already installed writes nothing.
- **Keeping it current** (`src/machines/client-release.ts`): each probe of a client target (every 30 s)
  asks `POST /release` after `status server`; when it is not the hopper's id, the hopper loads its
  release — never while a job runs on that machine (a running job's herdr calls must not meet a
  restarting client; it loads after). Each outcome is one log line per machine: `runs the hopper's
  release`, `loaded release <id> (was <id>)`, `loading it once no job runs there`, a failed load, or a
  client older than releases (it answers no release: still online; `scripts/attach-client.sh` installs it
  again, once).
- **`/api/machines`**: a client target, once probed online, carries `client: {tokenEnv, release,
  current}` — the release its client runs and whether it is the hopper's; `release` absent for a client
  older than releases.
- **Residual risk.** A load runs new code on the client target. It is only ever believed signed with the
  client token, which already lets the hopper run herdr — and so Claude jobs — there: a load gives the
  token no power it did not have. The body's hash is in the signature, so the files arrive as sent.

## Phase 6 — owner direction, not yet built (2026-10-03)

Four items from the owner. None is designed to completion; each records the request, the code it
touches, the open questions, and its tie to the plugin architecture (North star). Nothing here
is a commitment to a shape.

### 6a. Self-repair

Owner request: the app repairs and reinstalls itself in place.

Meaning: if an install breaks, or a restart kills work, the app detects it and repairs itself.
Today `scripts/install.sh` copies the tree to `~/.local/lib/hopper` (`DEST`) and runs
`systemctl --user restart hopper`. A restart fails running non-idempotent jobs
(`recover()` in `src/engine/recovery.ts`: `interrupted by daemon restart`) and a broken copy
leaves the unit crash-looping with nobody to notice. Another worker is making running jobs
survive restart; self-repair covers what that does not.

Touches: `scripts/install.sh`, `src/main.ts` (startup), `src/engine/recovery.ts`,
`GET /api/health`, the systemd unit files, `src/events/` (a repair event).

Open questions:
- What counts as "broken": unit failed or flapping, health check red, dist/source mismatch, missing dependency, schema ahead of code?
- Who repairs: a second watchdog unit (the daemon cannot repair itself while down), or `ExecStartPre`, or `OnFailure=`?
- Reinstall from where: the clone, a pinned git ref, a retained last-good copy in `~/.local/lib/hopper.prev`?
- Roll back to last-good, or roll forward? What stops a repair loop?
- How is a repair surfaced: event, UI banner, GitHub comment (never on a job issue; see no-comment rule)?
- A repair must never touch `~/.local/share/hopper` (persisted state).

Plugin tie: the repair is a role candidate (a `repairer` slot with detection and action), but
has one caller today; build it plain first, extract on a second real caller.

### 6b. Webhook subscription in the UI

**Settled and built in issue #18** — "Webhook subscriptions in the UI" at the end of this file.
The open questions below are answered there; the plugin tie is not taken (a subscription is not a
notifier instance: glossary *Notifier*).

Owner request: webhook subscriptions are visible in the UI and can be configured there.

Meaning: the UI shows each subscription (name, url, events, active, last delivery state) and
lets the owner edit it. Today `webhooks.yaml` is the only source (`src/webhooks/config.ts`,
reconciled by `name` into the store; dispatch in `src/webhooks/dispatcher.ts`; read-only
`src/http/webhooks.ts`). Repo law: no route creates or changes a webhook; the only mutations are
`POST /ui/api/*` behind a UI session. The edit therefore goes through a new `POST /ui/api/webhooks`
(session, exact Origin, same-origin, JSON), and the law line "webhooks only from `webhooks.yaml`"
changes in the same commit.

Touches: `src/webhooks/config.ts`, `src/http/ui/` (mutation route), `ui/src/views/webhooks.tsx`,
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

Owner request: the hopper's own herdr session should be visible in the UI and attachable in a single click.

Meaning: the UI shows the herdr session (herdr-claude option `session`, default `hopper`; unit
`hopper-herdr`) with its state, and offers attach. Attach is `herdr session attach hopper`,
a terminal action; the page is a browser on a loopback-only app.

Touches: `src/executors/herdr/` (session name, status via `client.ts`), `src/http/state.ts`
(expose session name and liveness), `ui/src/` (a view), `src/http/host-guard.ts` (no change expected).

Options (not decided):
1. Copyable command: show `herdr session attach hopper` with a copy button. Zero new surface; two clicks including paste.
2. Terminal URL handler: a `terminal:`/custom-scheme link registered by the OS to open a terminal running the command. One click; per-machine setup, and a link that runs a command is an execution surface.
3. Loopback-only helper: `POST /ui/api/herdr/attach` spawns a terminal emulator on the host. One click; the daemon launches a GUI process, which breaks "the hopper pulls".
4. Embedded terminal in the page (web terminal over the herdr socket). One click, no host terminal; largest surface and a new dependency.

Open questions: which terminal does the owner use; is a host-side spawn acceptable under the
loopback law; read-only view (screen mirror) as a first step?

Plugin tie: the executor plugin (slice 3) reports its own session and attach command; the UI
renders whatever the active executors declare, so another backend with another multiplexer
needs no UI change.

### 6d. Backends are configuration

Owner request: herdr may drive OMP, Claude, or any other agent; which tools a job uses is configuration.

Meaning: which agent runs a job is configuration, not code. `herdr agent start --kind` accepts
pi, claude, codex, gemini, cursor, devin, agy, cline, omp, mastracode, opencode, copilot, kimi,
kiro, droid, amp, grok, hermes, kilo, qodercli, qwen, maki (`herdr agent start --help`).
Today `src/executors/herdr/cli-client.ts` hardcodes `--kind claude`; `screen.ts` parses the
Claude Code TUI (turn anchor, gutter, `HOPPER_*` markers) and `protocolFooter` assumes
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

## UI rework — shadcn/ui + d3 (issue #14, 2026-10-03)

Owner direction (2026-10-03): rebuild the UI with shadcn/ui and d3: elegant, mature, realtime,
responsive and fast. Builds on the at-a-glance board (issue #5).

- **Build.** `ui/` is a Vite project (root `package.json`, `npm run build:ui`, base `/ui/`). The
  daemon reads `ui/dist` once at startup (`src/http/static.ts`): `/` → `index.html` (`no-cache`),
  `/ui/assets/<hashed file>` → `public, max-age=31536000, immutable`. Only files listed at startup
  are served, so no request path reaches the filesystem. No bundle → `/` is 503 naming
  `npm run build:ui`; the API is unaffected. `scripts/install.sh` builds before it copies.
- **Libraries, and why each.** React + shadcn/ui (Radix) for components, Tailwind v4 for styling,
  d3 for scales/shapes/arcs only — React renders every SVG node, axes included, so d3 never owns
  DOM. zustand holds the one store. sonner for toasts. Hand-rolled only the static file map
  (shorter than `@fastify/static`'s config).
- **One job store** (issue #45). The store holds each job once, by id (`jobs`), filled only from
  `/api/queue` answers (on load, and on the refresh every stream event triggers). Every job view
  — the KPI cards, the lanes, waiting, on-a-question and ended lists, the attention panel, the
  ended-per-hour chart, the lane timeline — derives from it through `jobBoard`
  (`ui/src/model/board.ts`), whose `GROUP` is the one map from status to *job group*. A card is
  the length of the list it names; `test/ui/overview-counts.test.ts` renders the overview and
  checks each card against its list, before and after a stream event. Lane spans come from the
  event log, but the job store wins: a span of a job no longer running ends with the job, and a
  running job with no start in the log gets its span from `startedAt`. The nav's questions badge
  counts `awaitsOwner` (`ui/src/model/questions.ts`), the same test the Questions view marks seen by.
- **Realtime.** One SSE connection; each domain event updates the log and chart history at once
  and debounces a `/api/queue` + `/api/machines` refresh (150 ms). One shared 1 s clock drives
  every ticking label. `ui/src/model/event-types.ts` is a `Record<EventType, true>`: a new event
  type that the UI does not subscribe to fails the UI typecheck.
- **Views** (hash-routed): Overview (KPIs with sparklines, lane timeline, attention, lanes /
  waiting / ended, ended-per-hour chart, usage gauges, live activity), Questions, Decisions,
  Events, Sources, Machines, Plugins (#13's panel, ported: "Settled in slice 7"), Webhooks. Charts read `/api/events?types=…&limit=5000`
  (`HISTORY_TYPES`): lane spans are derived client-side, no new API; ended-per-hour counts the job store's ended jobs.
- **Mutations unchanged**: cancel (now behind a confirm dialog), approve, answer, router mode,
  question close, plugins (options, select, rescan), logout — same `/ui/api/*` routes and session header.
- **Theme.** Dark by default, light by toggle, remembered in `localStorage` (`jh_theme`).
- **Overview layout** (issue #73). The Overview's panels are laid out on one three-column grid by the
  viewer's overview layout (`ui/src/model/overview-layout.ts`, pure): each overview panel shown or
  hidden, its place in the order, its width in thirds of the row, and the settings a panel has (lane
  timeline window, ended-per-hour hours 6/12/24 — the job store holds 24 h of ended jobs — and the
  number of live activity events). Customize (a sheet on the Overview) changes it; every change applies
  at once. Kept per browser in `localStorage` (`jh_overview`, `ui/src/hooks/use-overview-layout.ts`),
  like the theme: a viewer preference, so no route, no role and nothing in the database. Owner decision:
  per browser, not per user or per hopper. A stored layout is read leniently — a field it cannot use
  takes its default, an unknown panel goes, a panel added since comes back at the end, shown — so a new
  panel needs no migration of what browsers stored. Reset removes the key. Tested through the rendered
  app: `test/ui/overview-customize.test.ts`.
- **List boxes are bounded** (issue #84). An overview panel fills its grid cell, so the panels of one
  row line up. A list box (attention, lanes, waiting, ended, live activity) holds its list in a body of
  one height bound (`max-h-96`, at every screen width) and scrolls past it, so one long list does not
  stretch its row and leave its neighbours ragged. `Panel` `list` in `ui/src/components/panel.tsx`.
  Tested through the rendered app: `test/ui/overview-list-boxes.test.ts`.
- **Dismissed notices** (issue #83). Each Attention item and the update notice has a Dismiss button
  (X); toasts have a close button. A dismissed notice is kept per browser like the overview layout
  (`localStorage` `jh_dismissed`, `ui/src/model/dismissed.ts` pure, `ui/src/hooks/use-dismissed.ts`):
  a viewer preference, so no route, no role, nothing in the database, and it changes nothing at the
  daemon — dismissing a question's Attention item leaves the question open. The notice key names one
  occurrence, so a new question, failure, source error text or update target shows again; once the
  daemon reports a router, source or update condition cleared, its dismissal is forgotten, so the next
  occurrence shows too. Question and failed-job keys keep the newest 200. Attention's header offers
  *N dismissed · show* to bring its items back; a dismissed update notice still leaves the dot on the
  header version. Tested through the rendered app: `test/ui/attention-dismiss.test.ts`.
- **Rearranging the overview** (issue #86). Arrange on the Overview covers each shown panel; a panel
  dragged onto another takes its place (`placePanel`: in front of it from after, behind it from
  before), and Move earlier / Move later step it past its shown neighbours, skipping hidden ones —
  the way without a pointer. Done ends it; outside Arrange no panel drags, so charts and text keep
  their pointer. Customize rows drag the same way. Both use the browser's own drag and drop
  (`ui/src/hooks/use-drag-to-place.ts`), no library: the platform does it, and a library's pointer
  sensors need layout the rendered-app tests (happy-dom) do not have. Same layout, same key: no
  migration. Tested in `test/ui/overview-customize.test.ts` and `test/ui/overview-layout.test.ts`.

## Reaching the UI across the LAN (issue #16, 2026-10-03)

Owner request: reach the UI across the LAN. The owner opens the UI, answers and closes questions from
other machines on the LAN. This ends the loopback-only rule; the Host guard, the UI session and
"the hopper pulls" stand.

**Configuration** — this machine's, in `~/.config/hopper/daemon.env` (the unit's optional
`EnvironmentFile`), never in the unit:

```sh
HOPPER_LAN_NAMES=server,192.0.2.29
HOPPER_LAN_PEERS=192.0.2.0/24,100.64.0.0/10
```

| var | |
|---|---|
| `HOPPER_LAN_NAMES` | Host names or IPv4 addresses this daemon answers to, comma-separated, no port, never loopback. The first is the one in question links (`answerUrl`). |
| `HOPPER_LAN_PEERS` | CIDR ranges a LAN request may come from. Set both or neither. |

With LAN names set the daemon binds `::` (every interface); without, `127.0.0.1` as before.
`App.url` stays `http://127.0.0.1:<port>`.

**Who is asking** (`src/http/reach.ts`, `classifyRequest`, pure):

| peer | Host | result |
|---|---|---|
| loopback | `127.0.0.1:<port>` / `localhost:<port>` | local — as before: reads open |
| loopback or in `LAN_PEERS` | `<LAN name>:<port>` | LAN |
| in `LAN_PEERS` | loopback name with the port | LAN — since issue #119: a port a container publishes on its host's loopback arrives so ("Docker Compose"; under rootless Podman the same) |
| anything else | any | 403 — a peer on another interface (VPN `tun0`, docker bridges) is refused before routing |
| any | any other Host | 421 — DNS rebinding, as before |

**A LAN request reads `/api/` only with a UI session** (401 `{ error }` otherwise): the
`x-hopper-session` header, or — for `GET /api/events/stream` only, since `EventSource` sends no
headers — the `session` query parameter. `/`, `/ui/assets/*`, `POST /ui/login` and
`GET /ui/api/session` stay open, so a logged-out device can load the page and log in. Loopback reads
stay open: a local process can read the store file anyway.

**Mutations** accept `Origin: http://<LAN name>:<port>` beside the loopback origins; every other
check in "UI session and mutations" 5 stands.

**Logging a device in.** `open-ui.sh` works only on this machine. Two other ways, both through
the same one-time login code (`POST /ui/login`; using it rotates it):
1. **Device link** — a logged-in browser's header button calls `POST /ui/api/device-link` and shows
   `http://<LAN name>:<port>/#login=<code>` per LAN name, each also as a QR code for a phone's camera
   (issue #95, `qrcode.react`). The code rides in the fragment, which the browser never sends; the
   page strips it from the address bar and history, then posts it. The QR follows the code: while the
   dialog is open it posts `{ keep: <code> }` every 2 s; the daemon answers the same links while that
   code is live (`loginCodes.live`, which spends nothing), else mints a fresh code, and the dialog
   redraws. Closing the dialog stops it; a shown code still expires after 10 minutes.
2. **Paste a login code** into the logged-out banner (from `ui-login-code` on this machine).

Sessions are already in the store (migration 6), so a daemon restart does not log a device out; a
session still expires after `HOPPER_UI_SESSION_HOURS` (12).

**Residual risk, stated.** Plain HTTP: a host on the LAN that can sniff traffic can take a session
token or a device link in flight. Accepted for a home LAN; the peer list keeps the VPN and container
networks out. A device link is as strong as the login code file and works once.

## UI manages everything (issue #18, 2026-10-03)

Owner review (2026-10-03), after the reworked UI went live: the layout is kept; the UI cannot yet add
machines, change webhook subscriptions, show the accounts in use and their usage, or set the router,
queue sorter, question gates, routing rules or lane-specific instructions. Scope decision: lane rules
are out; usage throttles lanes; the rest is in. So no lane-specific instructions and no rule that
targets a lane. Every control below works at phone width (390 px): the owner uses the UI from a
phone across the LAN.

### Question gates (issue #18)

Owner request: the question gates can be set in the UI.

The **question gates** are the chain an open question goes through: the escalation levels,
lowest first → risk rules → owner (issue #134; before it, answerer → assessor). One panel in the
Questions view, below the open questions (collapsed by default under 640 px), shows the chain with
each level's instance and state, and edits what is configuration:

- **Escalation levels** — added (on top, under the name typed, else the plugin id), removed,
  moved earlier or later, and each level's non-command options (model, timeoutMs, effort, …), through
  `POST /ui/api/plugins` `add` / `remove` / `move` / `options`. A level's state comes from
  `GET /api/plugins` `escalationLevels[]`: active plugin, detection, and the reason one cannot run
  (it escalates every question). The levels are live: an edit applies to the next question,
  never `restart pending`. The form is shared with the Plugins and Routing views:
  `ui/src/components/plugin-form.tsx` (`InstanceForm { role, inst }`, `AddInstance { role }`,
  `PluginSelector { role }`, `sendPluginsEdit`, `pluginEditsUnsaved`); each form holds its own
  unsaved edits.
- **Rules file** — `GET /api/question-gates` → `{ rulesFile: { path, text, version, missing },
  riskRules }`; `POST /ui/api/rules-file { text, version }` (UI-session guarded) replaces it whole:
  `version` is the sha-256 of the file's bytes (or `missing`), stale → 409; more than 64 KiB
  (`RULES_FILE_MAX_BYTES`, UTF-8 bytes) → 400; written atomically (temp file beside it, rename),
  keeping the file's mode, 600 for a new one. Answers the new `rulesFile`. The question service
  reads the file on every ask (`requestFor`, `src/questions/service.ts`), so the next question's
  escalation levels get the edit without a restart. The UI keeps an unsaved edit in
  `localStorage` (`jh_rules_draft`: path, text, the version it began from), so it survives a reload;
  a draft over an older version is shown stale and Save is refused until Discard.
- **Risk rules** — code (`src/questions/risk.ts`), listed read-only with one line each
  (`RISK_RULES`); no setting weakens them.

`GET /api/question-gates` is a read: open on loopback, session-only across the LAN. Residual risk:
every local user can read the rules text (as every GET), and a session holder can rewrite the rules,
which steer every escalation level; the levels' fail-closed contract and the risk rules stand.

### Webhook subscriptions in the UI (issue #18)

Owner request: webhook subscriptions can be changed in the UI. Settles 6b.

- **Source of truth** (superseded by issue #78, "Webhook subscriptions in the database": the
  store's rows are the only source, and an edit carries no `version`). `webhooks.yaml` stays the
  only source of subscriptions; the UI session edits it. Not the store (the file would become a seed nobody trusts), not the notifier editor of
  slice 7 (a subscription has a store row and deliveries; a notifier has neither).
- **`POST /ui/api/webhooks`** (session-guarded, "UI session and mutations"), body by `action`,
  each with the file's `version`:
  `{ action: 'add', name, url, events, secretEnv, active?, version }` ·
  `{ action: 'edit', name, url?, events?, active?, version }` · `{ action: 'remove', name, version }`.
  Answers the new `GET /api/webhooks` view.
  400: body shape (a `secret`, `secretFile`, an edit's `secretEnv` or a new name in the body
  included), an add's `secretEnv` outside `WEBHOOK_SECRET_*`, or content invalid — the content is
  checked with webhooks.yaml's own schema, so the messages are the file's (`webhooks.N.url: …`,
  `must be an event type or "*"`); 404: no such name; 409: stale `version`, `add` of a name already
  there, an unparseable or invalid webhooks.yaml (never edited from the UI — fix it by hand).
- **`name`** is the reconcile key and never changes from the UI; renaming is remove + add.
- **Secrets (issue #56, "Secrets").** The hopper makes, keeps and hands out no secret. An entry names
  the variable the runtime gives its secret in (`secretEnv`); the operator sets the secret there (a
  variable, or a mounted file `<secretEnv>_FILE`) and gives it to the subscriber, and rotates it
  there — read at each delivery, so a rotated file applies at once; a changed variable at the next
  start. A UI session may name only a `WEBHOOK_SECRET_*` variable, so it cannot point a subscription
  at another credential the runtime holds (a delivery's HMAC under it); the CLI names any. An
  entry's `secretEnv` is not edited from the UI (remove + add, or the CLI). `GET /api/webhooks`
  carries each subscription's `secretEnv` and, when the runtime gives none, `secretProblem`
  (`WEBHOOK_SECRET_X is not set`) — never a secret.
- **The write.** Version = sha-256 of the file's bytes, or `missing` (then an add writes
  `version: 1` and the one entry). The change is spliced into the text at the entry's source
  ranges (`yaml` Document API), so comments, spacing and every other entry stay byte for byte; the
  result is re-parsed and must mean exactly what the Document edit means, else the Document is
  written instead (comments kept, spacing normalised) — the case for a flow-style or empty
  `webhooks` list. Validated against the file schema, written atomically (temp, rename, mode 600),
  then the watcher's `reload()` runs before the answer, so the store and the dispatcher already
  use the new entry (the 5 s mtime check is not waited for).
- **Residual risk.** A UI session holder can point a subscription at any http(s) URL and receive
  events (prompts, issue context) there. Same holder as "UI session and mutations"; no command can
  be run through a subscription.
- **UI.** The Webhooks view (`ui/src/views/webhooks.tsx`; model `ui/src/model/webhooks.ts`, tested
  from `test/ui/webhooks.test.ts`): a card per subscription — name, active switch, url, events,
  last delivery — with Edit (url, events picker over every event type and `*`, which stands alone,
  active) and Remove, behind a confirm; each card names its secret's variable and says when the
  runtime does not give it. An Add subscription form, whose secret variable follows the name
  (`WEBHOOK_SECRET_<NAME>`, `secretEnvFor`) until edited. A refused edit
  re-reads `GET /api/webhooks`, so a stale version is one retry. Vendored `ui/src/components/ui/switch.tsx`.

### Usage and accounts (issue #18)

Owner request: the UI shows the accounts in use and their usage, and usage throttles lanes.

**Built-in usage source `claude-plan`** (`src/plugins/usage-source/claude-plan/`). Claude
subscription usage comes from `claude -p /usage --output-format json --no-session-persistence`: a
local slash command, zero turns, zero tokens; Claude Code refreshes its own OAuth, so hopper
holds no credential. Prior art: `a status-bar script`.
- Options: `bin` (command-bearing, default `claude`), `intervalSeconds` (default 600, min 120).
  Detection: `which bin` only — never a call to claude.
- Runs in the background: once at create, then every `intervalSeconds`, each call killed after 45 s,
  in `<scratchDir>/probe` (mode 0700, ours alone); the project dir claude keeps for that cwd under
  `$CLAUDE_CONFIG_DIR` or `~/.claude/projects/` is removed after every run. `poll` answers from the
  last good read and never waits: every Decision polls every usage source.
- Readings: one per **usage window**, `used` = percent, `limit` 100, unit `%`, `resetsAt` (ISO; the
  panel prints no year: the one nearest now), `at` = when read. `session` and `week` (all models)
  throttle through decider steps 1-2 (soft 0.7 scales down, hard 0.95 stops). A window of one model
  (`week (Fable)`) or a shape not known is an **informational reading** (`informational: true`):
  shown, never throttling — decider step 1 skips it (it limits one model, not every job).
- A window past its `resetsAt` is left out until the next read. No read yet, a failed read
  (`usage unavailable: …`, `claude -p /usage failed: …`) or readings older than 3 intervals
  (`stale: last read …`) → no readings and the reason in `state().problem`. **Fails open**: with no
  readings, lanes are capped by machines only — the same as no usage source. Accepted: claude down
  must not stop the hopper, and the reason is on the Usage view.
- `claude auth status --json` (same run, same probe dir) gives the **account**: email, plan
  (`subscriptionType`), organization (`orgName`), sign-in method. Ids and anything else are dropped.

**Port.** `UsageSource` gains optional `state(): UsageSourceState` (`refreshedAt`, `problem`,
`account`) and `stop()` (the host calls it at shutdown). `UsageReading` gains optional `window` and
`informational`. Types: `src/domain/usage.ts`, re-exported by `types.ts`.

**Built-in instances (decided).** An absent `usageSources` section means
`[{ name: claude, plugin: claude-plan }]`, and the plugins-file migration writes it (`bin` =
the old `HOPPER_CLAUDE_BIN`). Why: the hopper runs Claude jobs, so Claude usage is the budget
that matters on a fresh install; where claude is not installed the instance is unavailable and
dropped with its reason. `usageSources: []` (the owner's file today) still means none: the
installer adds `- { name: claude, plugin: claude-plan }`. A restart role, as before.

**Read API** (read-only, Host guard and LAN session rule as every `/api/` read):
- `GET /api/usage` → `UsageReport`: `{ readings, sources: [{ name, refreshedAt?, problem?, account? }],
  limits: { soft, hard }, machines: [{ machineId, label, online, maxLanes, usedFrac, cap, band }] }`.
  `machines` is the **lane effect**: the decider's own `machineUsage` and `laneCap` over the current
  readings (one definition; the UI computes nothing).
- `GET /api/accounts` → `{ accounts: PartAccount[] }`, `PartAccount` = `{ role: usage-source |
  job-source, instance, service, identity?, detail, problem? }`. Each part describes its own
  account: a usage source through `state().account`, a job source as `detail.account` in its
  status — so a custom plugin's appears the same way. GitHub: the gh source names the gh user once
  it has asked (`whoami`; not asked while owners or repos are configured), and its pause reason; the
  app source names its bot (app file or first sync), the app slug and its installation repos.
  Never a token: accounts carry facts only, and nothing else is read.
  A separate route, not part of `/api/usage`: an account is not a budget (GitHub's have no usage).

**UI.** A **Usage** view (`ui/src/views/usage.tsx`, model `ui/src/model/usage.ts`, tested from
`test/ui/usage.test.ts`): Accounts, Lane effect (limits, per machine used %, cap of max lanes,
band), and per usage source its state line and one gauge per window with "resets in" and a "does
not throttle" tag on informational ones. The Overview's usage gauges and the Machines view read
the same readings; with more than one usage source the Overview's Usage panel shows one account's
readings at a time — a tab per usage source, the account's identity above its gauges, the choice
kept in the overview layout (`usageSource`, issue #85) (`/api/usage`, polled every 30-60 s and refreshed with every event: a usage
source reads without emitting events).

**Tests never run the real claude.** `test/support/isolate.ts` puts a guard `claude` first on PATH
(answers `--version`, refuses the rest); `TEST_PLUGINS` has `usageSources: []`; claude-plan tests
name `test/plugins/fake-claude-plan.mjs` as `bin`.

### Machines from the UI (issue #18)

**Amended by issue #74** ("Attached machines are machine-source instances" below): the read
carries `machines` (every machine-source instance) instead of `machine` and `attached`;
`POST /ui/api/machines` only attaches an ssh target; edit and remove are plugins edits. The rest
of this section is as it landed.

Owner request: machines can be added in the UI. The Machines view adds, edits and removes attached machines, and
edits this machine's lane count. Every change is written to plugins.yaml and applies without a
restart.

**Read** — `GET /api/machines/config` → `MachinesConfig` (`src/domain/machines.ts`): `path`,
`version` (sha-256 of plugins.yaml, as `/api/plugins` `config.version`), `error?`, `machine` (the
machine source's instance; its `lanes` option is the lane count), `attached` (`attachedMachines:` as
it applies now, defaults filled in), `executors` (the configured executor instance names) and `ssh:
{ targets, notes }` — the **detected ssh targets**.

**Detected ssh targets** (`src/machines/ssh-config.ts`): the `Host` aliases of `~/.ssh/config`, in
file order. A pattern with `*`, `?` or `!` is not a target. `Include` is followed as ssh does
(relative to `~/.ssh`, `~` expanded, globs through `fs.globSync`, 16 levels); what cannot be read is a
note, never an error. Hand-written: the `ssh-config` package does not follow `Include`, the part that
needs care.

**Write** — `POST /ui/api/machines` (UI session, as every mutation), body by `action`:

| body | effect |
|---|---|
| `{ action: 'add', name, ssh, lanes, executors?, label?, version }` | one new entry |
| `{ action: 'edit', name, lanes?, executors?, label? (null: drop), version }` | that entry's lanes, executors, label |
| `{ action: 'remove', name, version }` | that entry gone |

Answers the new `MachinesConfig`. 400: body invalid (strict: `herdrBin`, `session` and, on edit,
`ssh` are refused), an ssh target not detected, `local` or the machine source's name, lanes < 1, an
executor that is not a configured instance. 404: no such attached machine. 409: stale `version`; an
invalid plugins.yaml (fix it by hand); a name already attached; herdr not resolvable there (the
reason; machine not added); a removal while a lane there is busy or draining, or a job waits for an
answer in a pane there (`resumeOn`) — the error names the jobs.

- **The ssh target is never typed.** The add form offers only detected ssh targets, and the route
  refuses any other value: an ssh destination is command-bearing-adjacent (`-oProxyCommand=…`, a
  host that runs whatever it likes). Adding a Host alias stays a `~/.ssh/config` edit.
- **`herdrBin` is never taken from the UI.** On add the daemon resolves it over ssh, with the same
  `BatchMode`/`ControlPath` argv as every herdr call (`resolveHerdrBinOverSsh`): `command -v herdr`
  in a login shell there (`"$SHELL" -lc`, the last line, must be absolute), else `~/.local/bin/herdr`
  if executable. Failure → 409 with the reason. `session` is left out (the default `hopper`). The
  probe takes seconds, so the file's version is checked again before the write.
- **One entry only.** The edit splices that entry's text into the file at its source range (`yaml`
  node ranges), so every other byte stays: other sections, other entries, comments. An added entry
  takes the style of the entries before it (flow `{ … }` or block); an empty `[]` or a flow list
  becomes a block list; removing the last entry leaves `attachedMachines: []`. The result is checked
  against the plugins.yaml schema, written atomically, mode 600, then reloaded before the answer.
- **Live apply.** The host re-reads `attachedMachines:` on every good reload (`attachedMachines()`;
  an invalid file keeps the last good list). `createAttachedMachines` reads that list on every
  `list()`: a new machine appears (offline until its first probe), a removed one disappears (logged),
  and lanes, executors and label apply at once without losing what the probe knows. Another ssh
  target, herdr binary or session is another machine, probed afresh.
- **Lanes of a machine that is gone.** The decider closes the idle lanes of a machine no source
  lists and drains its busy ones (`planGoneLanes`); nothing starts there. Removal is refused while a
  job needs the machine, so this cleans up idle lanes.
- **This machine's lane count** is the machine source's `lanes` option, edited through
  `POST /ui/api/plugins` `options` (no new route). The machine source now applies an options change
  live; another instance name or plugin still shows `changed — restart pending`, since lanes are
  stored under the machine id.
- **UI**: `ui/src/views/machines.tsx` (cards: online/offline, lanes, executors, ssh target, herdr
  path and session read-only; Edit, Remove behind a confirm dialog; Add machine) and
  `machine-forms.tsx`; model `ui/src/model/machines.ts`, tested from `test/ui/machines.test.ts`. Phone
  width first: fields stack, controls are at least 36 px tall.

Residual risk: a session holder can attach any machine already in `~/.ssh/config` and point jobs
at it; that needs the owner's ssh config to name it and the machine to run herdr. Every local user can
read the detected ssh targets (`GET /api/machines/config`, like every loopback read).

### Attached machines are machine-source instances (issue #74, 2026-10-05)

Owner request: "Plugins can be configured in the UI"; owner's choice of the gap to close: fold the
attached machines into the machine-source role. Before, they were the one part beside the plugin
architecture (`attachedMachines:`, its own schema, its own edit route) — against the north star.

- **plugins.yaml `machines:` is a list** of machine-source instances, 0..n, unique names (a name is
  the machine id: lanes and jobs are stored under it). Absent: the built-in `local` alone.
  `attachedMachines:` is gone; the file schema refuses it.
- **Three built-in machine-source plugins, named by their connection** (glossary "Connection"):
  `ssh` (options `ssh`, `lanes`, `executors` default `[herdr-claude]`, `label`, `session` default
  `hopper`, `herdrBin` default `herdr`, `hostKey`), `docker` (`docker`, `lanes`, `executors`
  default `[command]`, `label`) and `client` (`tokenEnv`, `lanes`, `executors` default
  `[herdr-claude]`, `label`). `lanes` defaults to 1. Each schema is strict, so a field of another
  connection is refused. **Command-bearing**: `ssh`, `session`, `herdrBin`, `hostKey`, `docker`,
  `tokenEnv` — what reaches the machine is never changed from a UI session ("UI and mutation").
  A `client` instance whose name cannot name its tunnel's socket cannot run, with the reason.
  `src/plugins/machine-source/<id>/`; the shared options in `machine-source/attached.ts`;
  `machine-source/targets.ts` `targetOf(spec)` turns an instance into its `AttachedMachine`.
- **How a machine is reached stays the host's.** The machine-source context gains
  `target(machine): MachineSource` (`MachineSourceContext` in `sdk.ts`); a plugin hands its
  `AttachedMachine` to it. `main.ts` supplies it: `createTargetPool` (`src/machines/attached.ts`)
  with the probes (herdr over ssh with the hopper's key, docker through the hopper's socket, the
  client through its tunnel, which also loads the client release). The pool keeps one source per
  machine identity (name + connection fields), so an options change of lanes, executors or label
  rebuilds the instance without losing what the probe knows. Without a `target` (tests) a machine
  is never probed, so offline. A custom machine-source plugin may use `target` too.
- **Live, never pending.** The machine sources follow plugins.yaml on every good reload
  (`applyMachineSpecs`): an unchanged instance is kept, a new or changed one built, a removed one
  dropped (logged). `/api/plugins` `machines` is `{ instances }`, without `pending`. Renaming the
  `local` instance applies live too: its lanes are then those of a new machine id, as when an
  attached machine is renamed. An invalid plugins.yaml keeps the last good machines.
- **Pinned host keys** follow `host.targets()` (every instance `targetOf` accepts), rewritten
  before each machine listing.
- **The UI.** The Plugins view lists every machine under "Machine sources" with its options form
  (lanes, executors, label editable; the command-bearing ones read-only), Remove, and Add (only
  `local` is available there: `ssh`, `docker` and `client` need options without defaults, so they
  show `needs-setup`). The Machines view sends its Edit and Remove as `POST /ui/api/plugins`
  (`options`, `remove`, role `machine-source`), and Edit's body is the instance's whole options
  with lanes, executors and label as typed. Attaching over ssh stays `POST /ui/api/machines`, now
  `{ name, ssh, lanes, executors?, label?, version }` (no `action`): the detected-ssh-target check
  and resolving `herdrBin` and the host key need the daemon; it appends an `ssh` instance with the
  Document API (comments kept), the built-in `local` first when `machines:` was absent. A docker
  or client target is still attached with its script and `hopper config edit plugins.yaml`.
- **Removing a machine** (`remove`, role `machine-source`) is refused (409, naming the jobs) while a
  lane there is busy or draining or a job waits in a pane there, as the old machine edit was. An
  executor named by a machine's `executors` cannot be removed ("machine <name>").
- **Migration 15** (`src/store/migrations.ts`) rewrites the stored plugins.yaml: `machines:` becomes
  the list — the old instance, or the built-in `local` (`lanes: 4`) when there was none — then each
  `attachedMachines:` entry as an instance of the plugin its `ssh`, `docker` or `client` field
  names, the other fields its options (`client.tokenEnv` → `tokenEnv`); comments kept. A document
  that does not parse is left alone. The attach scripts print the new entry.
- Dropped: the byte-splicing machine edit (`attached-edit.ts` now only appends), `combineMachineSources`,
  `createAttachedMachines`, `host.attachedMachines()`, the "attached machine has the machine
  source's name" rule (uniqueness covers it).

### Router, queue sorter and routing rules (issue #18)

Owner request: the router, queue sorter and routing rules can be set in the UI; lane rules are out of
scope. So no rule targets a lane.

**Router.** The Routing view lists every router plugin with its detection. One that cannot run is
shown with its reason or its setup command and is never offered (on the hopper host `gate-router` is
unavailable while the Jev checkout is missing, so the reason is on screen). Selecting a router uses
`POST /ui/api/plugins` `select`; shadow/active uses `POST /ui/api/router-mode`; the configured
instance's options use the shared options form (`ui/src/components/plugin-form.tsx`, also used
by the Plugins view and the question gates).

**Queue sorter.** A new live role, `queue-sorter`, with exactly one instance, like the router.
Port: `QueueSorter { name; sort(entries: { job, effectivePriority }[]) → JobId[] }`. It is
synchronous and called once per Decision. Configured in plugins.yaml `queueSorter:`, selectable in
the UI. Built-in plugins: `priority` (the default, and the built-in instance when the section is
absent: effective priority desc, then `createdAt` asc, then id, which is the decider's own rule, so
nothing changes without the section), `oldest-first`, and `newest-first`.
- **The decider stays pure.** The engine calls the sorter while it gathers inputs
  (`src/engine/queue-order.ts`) and passes `DecisionInputs.queueOrder { sorter, jobIds }`. Step 6
  orders admissible jobs by that order. Jobs it leaves out come after it, by the old rule. With no
  order (Decisions stored before this), the old rule applies. The order never admits or holds a
  job. A reason line says `queue order by <instance>`.
- **Effective priority stays the decider's notion.** `effectivePriority(job, mode, policy)` is
  exported from `src/decider/assign.ts`. The engine computes it for the sorter's input, and
  `/api/queue` `waiting` uses the same order.
- **Fallback.** These cases fall back to `priority` for that call: a sorter that cannot run
  (unknown plugin, invalid options, not available, create threw), a sort that throws, or a result
  that is not distinct ids of the given jobs. The fallback is logged once per reason. `/api/plugins`
  `queueSorter` gives `{ instance, detection, active, fallback, reason? }`. A sort fallback clears
  on the next good sort.
- Authors: `examples/plugins/queue-sorter/word-first/`, `docs/plugins.md`.

**Routing rules.** plugins.yaml `routing:` holds an ordered list. When the section is absent there
are no rules.

```yaml
routing:
  - name: urgent sandbox
    match: { repo: "owner/*", label: urgent }   # any of: source, repo, label, author, title
    set: { priority: 90, machine: laptop }               # any of: machine, executor, priority
```

- `match` fields are case-insensitive, and every field given must match. `source` is the
  job-source instance name. In `repo`, `*` matches any run of characters, the slash included.
  `label` means the item has that label. `title` is a substring match. An empty `match` matches
  every item. `set` needs at least one field: `machine` (a configured machine id, which becomes the
  `spec.machineId` pin), `executor` (a configured executor instance), or `priority` (0..100). The
  schema is strict, so a `lane` anywhere is refused.
- **The first matching rule wins.** Rules are applied at intake (`SourceHost.ingest`,
  `src/engine/source-host.ts`), when a source item becomes a job. The item's source, repo, labels,
  author and title come from `SourceItem`. The job records `spec.routedBy { rule, set }` (additive
  in `job.queued`, still v1), and the UI shows it on the job. A source re-sort does not change a
  priority that a rule set.
- **New jobs only.** A rule change does not touch jobs already created. The UI copy says so.
- **Targets.** If a rule names a machine or executor that is not configured, a save returns 400.
  If the target disappears later, intake skips the rule with a warning and tries the next one.
  Intake never fails on a rule. `GET /api/routing` lists those rules under `skipped`.
- **API.** `GET /api/routing` returns `{ path, version, rules, error?, targets: { machines,
  executors }, skipped }`. `version` is plugins.yaml's sha-256, the same as `/api/plugins`.
  `POST /ui/api/routing { rules, version }` takes the whole list and is session-guarded. It is
  validated by the plugins.yaml schema and the target check. It writes only the `routing` node
  (yaml Document API; comments and other sections stay byte for byte), atomically, with mode 600,
  then reloads before it answers. 400: invalid rule or unknown target. 409: stale version, or
  plugins.yaml invalid. Pure matching: `src/routing/`.

**UI.** A "Routing" nav item with three panels: Router (current advice and fallback reason, mode
buttons, picker, options form), Queue sorter (picker with each plugin's description, options form),
and Routing rules (ordered list; each rule is a stacked form with match and set fields; add, move
up/down, delete; one Save for the whole list). The machine select uses `/api/machines` plus the
routing targets; the executor select uses the configured executors. Forms stack at 390 px width;
there is no horizontal page scroll.

## Sign-in: none, password, local, OIDC and SAML (issues #39, #53, 2026-10-04)

Owner request: the hopper deployable by anyone, plugged into a personal or enterprise identity
setup — any OIDC provider (Google, Microsoft Entra ID, Okta, Auth0, Keycloak, …), GitHub, and SAML
SSO — configured by settings, not code; the simple local sign-in kept; roles, sessions and logout the
same across providers. Operator guide, per provider: `docs/sign-in.md`.

**Not a plugin.** "UI session" is an invariant of the HTTP edge ("Phase 5", *Not plugins*), and
sign-in is part of it: a swappable part here would be a swappable lock. The capability still arrives
as configuration of built-in parts — the north star's "or as configuration of one". The three
provider types are adapters behind one port (`src/auth/provider.ts`), so a fourth is a file and a
schema branch.

**Libraries, not hand-rolled protocol code.** OIDC and GitHub's OAuth 2.0: `openid-client` (v6;
discovery, PKCE, state, nonce, ID token validation, userinfo). SAML: `@node-saml/node-saml` (v5;
signature, audience, InResponseTo, clock-skew validation, SP metadata). Tests drive real protocol
exchanges against loopback IdPs: `oauth2-mock-server`, a GitHub fake, a SAML IdP signing with an
openssl throwaway key through `xml-crypto` (`test/support/idp.ts`).

### Configuration — `auth.yaml`

`HOPPER_AUTH_FILE` (default `~/.config/hopper/auth.yaml`), mode 600. Absent → local sign-in
only (unchanged behaviour). Read **at start only**: an invalid file throws before the store opens,
naming the field — sign-in fails closed. Schema in `src/auth/config.ts`; reference in
`docs/sign-in.md`. Client secrets inline, in a file (`clientSecretFile`) or in an environment
variable (`clientSecretEnv`).

**Dependency on issue #40 (config in the store, secrets from env), stated.** #40 runs in parallel and
moves the config documents (plugins, webhooks, rules) into the store and every secret into env. This
work lands first and assumes: `auth.yaml` stays a start-time file until #40 folds it into the stored
config documents the same way (an admin-only document; a change still applies at the next start, or
#40 makes the sign-in service follow the stored version); `clientSecretEnv` is already the env path
#40 asks for; migration 7 (`ALTER TABLE ui_sessions ADD COLUMN … NOT NULL DEFAULT …`) is plain SQL
both SQLite and Postgres run; #40's store port keeps `UiSessionRepository.all` and `setRole`. The
dependency runs one way: #40 builds on this, not the reverse. Issuer and
endpoint URLs must be https, except to loopback (a local test or dev IdP). OIDC discovery runs on the
first sign-in, not at boot: an unreachable issuer must not stop the daemon.

### Roles

`viewer` < `operator` < `admin` (`src/domain/sign-in.ts`). Every mutation names its least role:

| UI role | mutations |
|---|---|
| `viewer` | `POST /ui/api/logout` |
| `operator` | + jobs `cancel`, `approve`; questions `answer`, `close`, `dismiss`, `seen` |
| `admin` | + `router-mode`, `plugins`, `rules-file`, `webhooks`, `machines`, `routing`, `device-link`, `update` |

A live session whose role is short gets 403 `{ error, needs }` — the UI keeps the session and
toasts; any other 403 still means "log in again". The login code always gives `admin`. A provider's
`roles` (`src/auth/roles.ts`, pure): `admin` / `operator` / `viewer` each match on subjects,
usernames, emails, email domains or groups; the highest match wins; else `defaultRole`; else **no
session**. Only an email the provider vouches for is an Identity's `email`: OIDC needs
`email_verified: true` unless `trustUnverifiedEmail`; GitHub's primary verified email; SAML's
asserted one.

### The flow (no cookies)

Cookies ignore ports ("UI session and mutations"), and a SAML response is a cross-site POST that a
`SameSite=Lax` cookie would not survive anyway. So the browser proves it began the sign-in with
`localStorage`, as the session token already does:

1. The UI keeps a fresh **binding** (32 random bytes, base64url) in `localStorage` `jh_sign_in` and
   opens `GET /ui/auth/<name>/start?binding=…` **on the sign-in origin** (else 409: the binding would
   not come back). The daemon keeps a flow — provider, SHA-256 of the binding, the provider's secrets
   (PKCE verifier, nonce, state) — under a random flow id for 10 minutes, and redirects to the provider with the flow id as `state` / `RelayState`.
2. The provider returns to `/ui/auth/<name>/callback` (GET for OIDC and GitHub, POST for SAML). The
   flow is taken (once), the response validated by the library, the Identity built and its role
   decided. No role → 403 page. Else a one-time **ticket** (2 minutes) and a page whose script posts
   `{ ticket, binding }` to `POST /ui/auth/complete` (exact sign-in Origin), stores the returned
   token as `jh_session`, and goes to `/`.
3. The ticket gives a session only with the binding that began the flow: a callback link handed to
   another browser — login CSRF — signs nobody in.

Flows and tickets are in memory: a restart mid-sign-in means signing in again. Starting needs no
session, so at most 10 000 flows are pending; past that the oldest is evicted (never a refusal: a
flood of starts must not lock real users out, it can only make one start again). Rate limiting
`/ui/auth/` is the reverse proxy's job (`docs/sign-in.md`). SAML is SP-initiated
only (`validateInResponseTo: always`); assertions must be signed (`requireSignedResponse` adds the
whole response); `disableRequestedAuthnContext` and no NameID format, so the IdP's MFA and NameID
choices pass. `GET /ui/auth/<name>/metadata` serves the SP metadata.

### Sessions and logout

One session kind for every provider: migration 7 adds `role` and `identity` (JSON) to
`ui_sessions`; older rows become `admin` / provider `local` (they were all made from the login code).
`GET /ui/api/session` → `{ authenticated, expiresAt?, user?: { role, provider, name }, signIn: {
local, origin, providers: [{ name, label, type }] } }`. Logout drops the row, for every provider; it
does not end the provider's own session (no RP-initiated logout or SAML SLO: a hopper session is the
thing being ended, and the same on every provider). At every start the stored sessions are
reconciled with `auth.yaml`: a removed provider (or local sign-in turned off) or an account no rule
grants a role any more loses its session; a changed rule changes the stored role. Audit: one journal
line per sign-in, refusal and logout (no domain event: webhook subscribers would receive identities).

### No sign-in and password sign-in (issue #53)

Owner requirement: as a self-hosted service the hopper supports no auth, simple auth, OIDC and SAML,
each through an established library. Both new kinds are built in beside `local`, not identity
providers (no redirect, no flow, no ticket); `none` and `password` are reserved provider names.

- **No sign-in** — `auth.yaml` `none: { role }`, absent: off. `POST /ui/auth/none` → `{ token,
  expiresAt, user }`, identity `{ provider: none, subject: anonymous, name: "no sign-in" }`. The
  session still exists because the mutation guard needs it: the session header is the CSRF defence
  and the role check. The UI takes the session by itself when logged out (`wantsNoSignIn`). A
  startup warning names the role. Composes with everything else (anonymous `viewer`, sign in to act).
- **Password sign-in** — `auth.yaml` `password.users: [{ username, passwordHash, role }]`. The hash
  is argon2id through the `argon2` package (`src/auth/password.ts`), made by `hopper
  password-hash` (stdin, or a no-echo prompt asked twice, through `read`); anything not starting
  `$argon2id$` is refused at load. `POST /ui/auth/password { username, password }` → the same
  answer as above; identity `{ provider: password, subject: username, username }`. Usernames compare
  case-insensitively and are unique. An unknown username is verified against a fixed hash of a
  random password, so it costs a wrong password's time; every failure is one 403, logged.
- **Origin.** Both need the exact Origin of a UI page — `uiOrigins` (loopback, LAN names, public
  URL), the set mutations accept — not only the sign-in origin: nothing comes back from a provider,
  so a LAN page can sign in where it stands.
- **Stored sessions** follow `auth.yaml` at start like provider sessions: `roleOf` gives `none`'s
  role (null when off) and the account's current role (null when removed).
- **Rate limit.** Every route that needs no session to start one — `POST /ui/login`, `/ui/auth/*`
  — is registered in one Fastify child context behind `@fastify/rate-limit`: 20 requests a minute
  per client address (`SIGN_IN_RATE`, in memory), then 429. Behind a reverse proxy every client is
  the proxy's address, so the limit is shared there (`trustProxy` stays off: a forwarded header
  would let a client pick its own key); a public deploy limits per client at the proxy.

**Residual risk, stated.** `none` with `operator` or `admin` hands those powers to whoever reaches
the port or the proxy; it is only as safe as what stands in front. Password sign-in has no lockout
beyond the rate limit and no password policy: the operator chooses the password and hashes it.

### Local sign-in off

`local: { enabled: false }`: no `ui-login-code` is written (a stale one is deleted), `POST /ui/login`
is 403, `POST /ui/api/device-link` is 409, login-code sessions end at the next start.

### A public URL

`HOPPER_PUBLIC_URL` (origin only, never loopback): the UI behind a reverse proxy. Its host (with
the port only when it is not the scheme's default) passes the Host guard as a **public request** —
like a LAN request, `/api/` only with a UI session — from loopback or a LAN peer; its origin may post
UI mutations; it is the sign-in origin. The daemon binds every interface only when
`HOPPER_LAN_PEERS` is set (now allowed with a public URL and no LAN names); a proxy on the same
machine needs none. Without it the sign-in origin is `http://localhost:<port>`.

**Residual risk, stated.** As before, every local user of the host can read the GET API straight on
`127.0.0.1:<port>` without a session; deploy on a host only the operator and the proxy use. TLS is
the proxy's job; without it a session token crosses the network in clear. A session outlives a
change at the provider (user disabled, group removed) until it expires or the daemon restarts with
`auth.yaml` changed. GitHub teams are read from the first page (100). The event stream carries the
session token in its query (`EventSource` sends no headers), so a proxy's access log holds tokens
unless it skips that path (`docs/sign-in.md`). A `usernames` rule is only as stable as the provider's
usernames: GitHub logins can be renamed and re-registered, so the guide grants by `subjects`.

## Self-update (issue #44, 2026-10-04)

The hopper knows when a newer version exists, says what changed, and applies it without losing a
job, a lane or a question: from the UI, or on its own with auto-update. Code: `src/update/`
(`updater.ts` the loop, `git.ts` the mirror, `install.ts` install.json and the swap, `build.ts` the
build, `restart.ts` the restart, `blockers.ts`); routes `GET /api/update`, `POST /ui/api/update`.

**The install knows where it came from.** `install.json` in the install (beside `src/`):
`{ repo, branch, commit, installedAt }`. `scripts/install.sh` writes it from the clone's `origin`
and `HEAD`; the branch is `main` unless `HOPPER_UPDATE_BRANCH` names another. An update writes
the new one. No install.json (a checkout run with `npm start`, a clone without `origin`) → state
`unavailable` with the reason; nothing else changes.

**Detecting.** A bare mirror at `<data dir>/update/repo.git`, fetched from install.json's `repo` on
every check — the git CLI, never prompting (`GIT_TERMINAL_PROMPT=0`, ssh `BatchMode=yes`, and
only the user's ssh config: `-F ~/.ssh/config`, since the unit's `PrivateTmp` puts the daemon in a
user namespace where root-owned `/etc/ssh` files show as owned by nobody and ssh refuses them), so any
git URL the daemon's user can fetch works: GitHub by ssh or https, another host, a local path. A
check runs 10 s after start, then every `HOPPER_UPDATE_CHECK_MS` (default 900000; 0: only when
asked), and from the UI's Check now. The **update channel** decides the target: `main` → the head
of the tracked branch; `release` → the newest `v<major>.<minor>.<patch>` tag. An update is
**available** when the installed commit does not contain the target (an install ahead of it, e.g.
from a feature branch, is `current`). **What's new** (issue #104): the bullets of `WHATS-NEW.md`
at the target that `WHATS-NEW.md` at the installed commit lacks, newest first (`whatsNew`; all of
them when the installed commit has no such file) — plain words for people who use the hopper,
written by hand in the change that makes them true (AGENTS.md "What's new"); `src/update/whats-new.ts`.
Commit subjects, hashes and issue numbers are never shown: a merge list is the change's plumbing,
not what changed for its users. The newest release is reported on either channel (`release.newer`).
`update.available` is appended once per target, with `changes`: how many commits it adds (the log
line too; never the UI).

**Applying, in flight.** `POST /ui/api/update { action: "apply" }` answers at once; then:

1. The target's tree (`git archive`) is unpacked to `<data dir>/update/source`.
2. The **next install** `<install>.next` is built by the target's own `scripts/install.sh` in
   **build-only mode** (`HOPPER_INSTALL_INTO=<dir>` + `_REPO`, `_BRANCH`, `_COMMIT`): UI bundle,
   production dependencies, install.json — no service, unit or config touched. Log:
   `<data dir>/update/build.log`. The running daemon is not touched: jobs keep running.
3. Proof it loads: a child `node` imports the next install's `src/main.ts`. A module that fails to
   load fails here.
4. Wait while there is a **restart blocker**: a running job whose executor is non-idempotent and
   cannot reattach, which restart recovery would fail. herdr-claude jobs reattach and idempotent
   jobs re-run, so neither blocks. The status says which jobs it waits for.
5. Swap: `<install>` → `<install>.prev` (the previous `.prev` removed), `<install>.next` →
   `<install>`; `<data dir>/update/pending.json` names from, to and ref.
6. Restart (below).

A failure in steps 1-3 or the swap → `update.failed`, the install unchanged, state `error` with the
reason until the next check.

**Restarting.** Under a supervisor — systemd (`INVOCATION_ID` set) or a container's PID 1 — the
daemon stops cleanly (the same `app.stop()` as SIGTERM) and exits 75. The unit has
`SuccessExitStatus=75` and `RestartForceExitStatus=75`; an older unit's `Restart=on-failure`
restarts a 75 too, so the first update needs no unit change. A container restarts it by its restart
policy. Unsupervised, it stops, starts its successor detached, and exits. `HOPPER_RESTART=exit|
respawn` forces either. Under systemd the units the new install ships (`systemd/`, now copied into
the install) are written over installed ones that differ, then `systemctl --user daemon-reload`;
`hopper-herdr` is never restarted (that would kill every pane).

**What survives the restart** — restart recovery, unchanged ("Recovery at startup"): herdr panes
live in `hopper-herdr`, not the daemon, so running herdr-claude jobs are reattached on their
lanes (`job.reattached`); idempotent jobs are requeued; `waiting_answer` jobs keep their question;
an open question in the answer or assess stage restarts there, one at the human stage keeps its
timers; UI sessions are in the database; schema migrations run at boot as on any start.

**The boot after** reads pending.json: install.json on `to` → `update.applied`; otherwise (rolled back
by hand) → `update.failed`. The UI reloads itself when `GET /api/update` names another installed
commit than the page was loaded with — the new UI bundle.

**Settings** in the store's `settings` table (`updateChannel`, `autoUpdate`; key/value, no
migration): `POST /ui/api/update { action: "settings", channel?, autoUpdate? }`. Auto-update applies
an available update as soon as a check finds it, and at once when switched on with one available.

**UI.** A notice above the views while an update is available, applying or failed — headline
("Update available", or the release), "What's new" (the bullets), Update now. The header's
version (with the installed commit) opens the Updates panel: installed, newest, release, last check,
Check now, Update now, auto-update, channel (`commits` / `releases`).

**Any deployment.** The updater needs: install.json, git and network access to the repository,
npm (the build), write access to the install's parent directory (the swap), and a supervisor or the
respawn. A container must keep its install on a volume, or the update lasts only until the
container is recreated from its image; its recipe writes install.json (build args for repo, branch,
commit). Assumption about issue #40 (a deploy recipe and a database, in parallel): it keeps an
install directory with `src/` and install.json, and keeps `scripts/install.sh` build-only mode
working — #40 depends on this section, not the other way round.

**Not built.** A CI step that writes What's new: the repository has no CI, and a model in one would
be a credential to keep and rotate for text the change's author already knows; the line is written in
the change itself, and `test/update/whats-new.test.ts` refuses a line carrying an issue number, a
hash, a commit prefix or a file name. Automatic rollback: a next install that loads but crashes after start leaves the
supervisor restarting it; recovery by hand is swapping `<install>.prev` back and restarting (the boot
records `update.failed`). Signature checks on the fetched code: the repository the owner installed
from is trusted as the install itself was.

## Docker Compose (issue #119, 2026-10-05)

Owner request: install the hopper as a Docker Compose setup — one file that brings up what is needed,
with no host install path.

`compose.yaml` at the root, served by the install page beside `install.sh`. Three services: `secrets`
(once per start; the database password is made on the first one and kept in a volume, each file
readable only by its one reader), `postgres` (no host port), `hopper` (built from the public repository's
`main`, or `HOPPER_SOURCE`). Settings and secrets come from an optional `.env` beside it. Since issue
#125 the hopper is the published image, the `secrets` service is folded into `postgres`, and Podman is
the recommended runtime ("The published image, with Podman" below). Operating detail: `docs/deploy.md`
"In containers, with Podman".

**Jobs run in the hopper's container.** Until now the image had no herdr and ran jobs only on
attached machines; a compose install with no other machine could run nothing. The image now carries
herdr (herdr.dev's installer, which checks the release's SHA-256), and its entrypoint
(`scripts/container-start.sh`) starts hopper's herdr session and starts it again when it stops,
before it runs the daemon. The built-in `local` machine with `herdr-claude` then works unchanged. The
image seeds Claude Code's first-run state (onboarding done; the `--dangerously-skip-permissions`
prompt skipped) into `/home/node`, the `home` volume; the workspace trust dialog is answered by
`trustWorkdir` as on a host. git reaches GitHub through `gh auth git-credential`.

**A loopback Host from a LAN peer is a LAN request.** Docker publishes the UI port on the host's
loopback and forwards it from the compose network: the browser sends `Host: 127.0.0.1:<port>` and the
daemon sees a peer in the network's range. It was refused 421 (the LAN table above); it is now a LAN
request — a UI session for `/api/`, the exact Origin for mutations — never a local one. DNS
rebinding is unaffected: another Host is 421 as before. The compose file publishes the daemon's own
port (`HOPPER_PORT`, both sides) so the Host names it, sets `HOPPER_LAN_PEERS` to the private
ranges and `HOPPER_LAN_NAMES` to `hopper`, the service name.

**The earlier container profile is gone** (`deploy/compose.yaml --profile container`, no
compatibility): `deploy/compose.yaml` is the host install's Postgres alone, project `job-hopper`;
the compose install is project `hopper`, so their volumes never meet.

**Verification:** `test/scripts/compose.test.ts` asserts the rendered file (`docker compose config`,
from an empty directory, as downloaded). Live: the stack built from a checkout on a spare port, came up
healthy; the `local` machine was online with `herdr-claude`; a login code signed in through the
published port; Claude Code started in a pane of the container's herdr session at its prompt; the
stack came back after `down`/`up` with its data and password.

## The published image, with Podman (issue #125, 2026-10-05)

Owner request: publish a public container image people can pull and run, so the hopper is not
installed on the host; running from it is the recommended path, other installs stay but are
secondary; install and run docs focus on Podman.

**The image.** `.github/workflows/image.yml` builds the `Dockerfile` on every push to `main` (and by
hand) and pushes `ghcr.io/henningfutrell/hopper`: `latest` follows `main`, `sha-<commit>` pins one
build; `linux/amd64` and `linux/arm64` (QEMU; herdr ships both). It logs in with the workflow's own
`GITHUB_TOKEN` (`packages: write`): no registry credential exists to keep or rotate. The package is
public, so a pull needs no sign-in. Nothing in the image is specific to one install: everything the
hopper keeps is in its database, its secrets come from the runtime ("Deployable", "Secrets").

**compose.yaml pulls it.** The `hopper` service is `image: ${HOPPER_IMAGE:-ghcr.io/henningfutrell/hopper:latest}`
— the full name, so Podman never asks which registry a short name means. No build: the first start is
a download. `HOPPER_SOURCE` is gone (no compatibility); an image built from a checkout is
`HOPPER_IMAGE=localhost/hopper`. Upgrade: `podman compose pull && podman compose up -d`. Self-update
still does not apply to a container.

**No one-shot service.** podman-compose maps `depends_on` to Podman's `--requires`, which refuses to
start a container whose dependency has exited, so the `secrets` service (run once, then exited) stopped
the stack: `container state improper`. The `postgres` service now makes the password and the database
URL in the `secrets` volume itself, as root, before it execs Postgres's own entrypoint; the hopper waits
for a healthy Postgres and mounts the volume read-only. Same files, same owners and modes, same volume
names: an existing stack starts on its data unchanged.

**Podman first.** `podman compose` runs whichever compose provider is installed: `docker-compose`
(through Podman's API socket, `podman.socket`) or `podman-compose`. The docs install `podman-compose`;
the page's troubleshooting names the socket for the other. Rootless Podman has no daemon to restart
containers after a reboot: `podman-restart.service` (user unit) and lingering do it. Docker keeps
working with the same file (`docker compose`). The install page leads with this path; the host install
(`install.sh`) is its own secondary section; Windows runs the same Podman steps in WSL.

**Not built.** A `podman kube play` or Quadlet file beside compose.yaml: a second description of the
same stack to keep in step, for no user that compose does not already serve.

**Verification:** `test/scripts/compose.test.ts` (the rendered file pulls the image, no build, no
one-shot service; the workflow publishes the tag compose pulls, both architectures, with the workflow's
token) and `test/scripts/install-page.test.ts` (Podman first; podman-restart; WSL). Live: the image
built with Podman; the stack under rootless Podman with podman-compose and again with docker-compose
through the socket, on a spare port: Postgres healthy, the hopper up, a login code signed in through the
published port, the `local` machine online with `herdr-claude`; down/up kept the data and password.

## Rename from job-hopper (issue #112, 2026-10-05)

The product was job-hopper; it is hopper everywhere: package and CLI `hopper`, install
`~/.local/lib/hopper`, config `~/.config/hopper/`, work dir `%C/hopper`, units `hopper.service`,
`hopper-herdr.service`, `hopper-client.service`, herdr sessions `hopper` and `hopper-client`, process
variables `HOPPER_*`, the job protocol words `HOPPER_QUESTION` / `HOPPER_DONE` / `HOPPER_FAILED`, the
headers `x-hopper-*`. No alias of an old name is kept. Persisted state is migrated, never abandoned; the
code that reads the old names is `src/update/rename.ts` (the hopper's host), `renameClient` in
`src/client/main.ts` (a client target), store migration 12 (plugins.yaml), and the lines marked so in
`scripts/install.sh`, `scripts/get.sh`, `scripts/attach-client.sh` and `scripts/attach-machine.sh`.

**What moves on the hopper's host.** The config dir; `daemon.env` (every `JOB_HOPPER_*` key renamed, every
value naming the old config or work dir pointed at the new one: token files, key files); the work dir
(pinned host keys, client sockets, the update mirror and its pending file); in `~/.ssh/authorized_keys`
the client targets' lines (`job-hopper-client:<name>`), whose forced command runs the relay from the
install dir and opens its socket in the work dir; the CLI link; the units (old ones disabled, stopped and
removed); the install dir (removed once the new daemon answers `/api/health`). A dir whose new place
already exists is left beside it and reported, never merged. The database is not touched: its URL is
the user's, unchanged.

**The herdr session moves only when no job holds a pane in it.** Stopping `job-hopper-herdr` closes every
pane in session `job-hopper`, and a job started with the old protocol words would answer in words the new
daemon does not parse. A pane job: `claimed`, `running` or `waiting_answer`, with its executor state in
session `job-hopper` on this machine (not ssh, not a client target).

- **install.sh** builds the new install, then `rename.ts install`: stops `job-hopper.service` (so no job
  starts while it looks), reads the pane jobs from the database the old `daemon.env` names, and with
  any, starts the old daemon again and exits 1 naming them; with none, moves the state. install.sh then
  installs and starts the new units as on any upgrade, and `rename.ts cleanup` removes the old install
  dir once the new daemon answers.
- **Self-update** of a job-hopper install: its old updater runs the new `install.sh` in build-only mode
  under `JOB_HOPPER_INSTALL_*` (read for that alone), swaps the new code into `~/.local/lib/job-hopper`,
  and its unit starts it with the old variables. That boot (`renameBoot`, before anything starts)
  opens the database: with no pane job, it starts `rename.ts handover` as a transient unit of its own
  (`systemd-run --user`; the handover stops the unit the boot runs in) and waits to be stopped. The
  handover copies the install to `~/.local/lib/hopper`, moves the state, installs and starts the new
  units, and removes the old install dir once the new daemon answers. With a pane job, the boot puts
  `<install>.prev` back, records `update.failed` with the jobs it waits for (the pending file removed,
  so the old boot does not report it again), and exits 75: the old daemon runs on, and its updater
  offers the update again at the next check — taken once the panes are gone (auto-update), or from
  the UI.
- **A deploy with neither** (a container, `npm start`): the daemon refuses to start while `JOB_HOPPER_*`
  names its database and no `HOPPER_*` does, and names the variables to rename.

**plugins.yaml** (store migration 12): an ssh-attached machine that named no `session` is given
`session: job-hopper` — the session its own unit there still runs — until it is attached again
(`attach-machine.sh` says how to drop the line and the old unit); a herdr-claude instance that named
`session: job-hopper` named the local unit's session, now `hopper`, the default: the option goes.

**Client targets.** A client attached before the rename runs as `job-hopper-client`. The hopper loads its
client release there as on any release change — only when no job runs there — and that boot
(`renameClient`) moves its config dir, `client.env` (keys, paths, and its session `job-hopper-client` →
`hopper-client`), the pinned host key's name in its `known_hosts`, its install and its units, then swaps
the units over in a transient unit of its own. The client release keeps its file list (a client checks a
release has exactly its files), so the migration lives in `main.ts`, and the relay's first line stays
`JOB-HOPPER-RELAY/1`: a client that has not loaded the new release must still reach the hopper to load it.

**Kept on purpose.** The comment marker `<!-- job-hopper v1` (old comments on GitHub issues are not
ours to rewrite); the bundled Postgres's volume `job-hopper_postgres` (`deploy/compose.yaml` names it:
under the new project name compose would start an empty database beside the data); the relay marker
above; the `jh_*` browser storage keys and the `jh-<job>` herdr agent names, which do not carry the
product name and which a rename would cost the viewer's layout, notices and drafts.

**Out of the migration.** Out-of-tree plugins import `hopper/plugin` now; their own sources that import
`job-hopper/plugin` are the owner's to change (types only, so nothing fails at runtime). The tsconfig
install.sh wrote for them is rewritten (`scripts/write-plugin-tsconfig.ts` knows its old first line).
Webhook receivers read `x-hopper-*` headers now. The docker socket proxy keeps its container and socket
path until `scripts/docker-proxy.sh` is run again: `daemon.env` keeps naming the running one.

## Deployable: a database, config documents, secrets from the environment (issue #40, 2026-10-04)

Owner direction: the hopper must not lean on the computer it runs on — config in local files, state
in a local SQLite file, login codes and secrets on disk, paths in a home directory. Everything the
daemon keeps is now in one database; its secrets come from its runtime ("Secrets", issue #56);
nothing in the code names a path on one machine. Operator path: `docs/deploy.md`.

### Database

`HOPPER_DATABASE_URL` (or the mounted file `HOPPER_DATABASE_URL_FILE` names: it carries a
password, "Secrets"), required (no default: a database is never assumed): `postgres://…`, the
only store (issue #53 — a local SQLite file is no different from a local JSON file; it keeps the
hopper on one machine). The hopper is given a database; it never creates its own file. TLS to a
managed Postgres: the driver's `sslmode` in the URL. `HOPPER_DB` is gone. The URL may name a schema with
hopper's own `?schema=<name>` (created when absent; stripped before the driver sees the URL).

**The Store port stays synchronous.** The engine relies on it: store reads happen after the awaits,
synchronously with decide and apply (`src/engine/decision-step.ts`), so no read-modify-write is ever
interleaved. Postgres is reached through one worker thread (`synckit`, `src/store/postgres-worker.ts`)
the calling thread blocks on; the worker holds one `pg` client per open store, so a transaction's
statements share one connection. A call fails after
30 s rather than hanging the daemon; a dropped connection fails the call it broke and the next call
outside a transaction connects again. Cost: every query blocks the event loop for one round trip —
sub-millisecond to a database on the same host or LAN, but put Postgres near the hopper (a 20 ms
link × ~50 queries a tick is a second of stall). An async Store was rejected: ~230 call sites, and a
new class of interleaving bug between the tick and the UI's mutations.

SQL (`src/store/db.ts`): `?` placeholders, numbered `$n` before sending; `RETURNING` for generated
keys; `ON CONFLICT … DO UPDATE` for upserts. A BIGINT seq comes back as a number. The schema version
is the `schema_version` table: a new store is created at `BASE` (version 6 — versions 1-6 were the
SQLite history, gone with it), and every later migration is appended to `MIGRATIONS` (7 session role
and identity, 8 config documents, 9 login codes, …). A Postgres sequence is not transactional, so a
rolled-back append can leave a gap in `seq`: seq only rises.

**Tests and local development** run against Postgres too: `npm test` starts a throwaway container
through `testcontainers` (vitest globalSetup, `test/support/postgres.ts`), each test in its own
schema; `HOPPER_TEST_POSTGRES_URL` points the suite at an existing database instead. A local
hopper uses `deploy/compose.yaml`'s Postgres (optional: any Postgres it is given will do).

### Config documents

`plugins.yaml`, `rules.md` and `auth.yaml` are **config documents** (a fourth, for webhooks, went
in issue #78: "Webhook subscriptions in the database"): named texts in
the store (`config_documents`, port `ConfigDocuments`), each replaced whole against its `version` —
the sha-256 of its text, or `missing`. The YAML stays the format, comments and all; every UI edit
already splices into the text against the version it read, and now writes it back the same way
(`documents.write(name, text, version)` refuses a moved document). Watchers poll the version every
5 s instead of an mtime. `HOPPER_PLUGINS_FILE`, `_WEBHOOKS_FILE`, `_RULES_FILE`, `_AUTH_FILE` are
gone (leftover variables). The first boot against an empty store writes plugins.yaml from the
built-in instances (`ensurePluginsDocument`); the sources.yaml and env → plugins.yaml migrations are
removed. `install.sh` writes the starter rules.md through the CLI when there is none. The rules wire
names follow: `GET /api/question-gates` `rules` (`RulesView`, `document: "rules.md"`),
`POST /ui/api/rules`; reports name their document (`config.document`, `source: "document"`) instead
of a path. **What the UI deliberately never edits** — command-bearing options — the operator sets
with the CLI (below). Custom plugins are code, not config: `HOPPER_PLUGIN_DIR`, now with no
default (unset: none).

### Secrets

**Every secret comes from the runtime (owner direction, issue #56).** The hopper's runtime can never
be guaranteed, so it is given every secret as an environment variable or a mounted secret file, and
any secret source can feed it: a container's or orchestrator's secrets, a secrets manager, a service
manager's credentials. A secret named `NAME` is the variable `NAME`, or the file the variable
`NAME_FILE` names (`src/secrets/runtime.ts`, `runtimeSecrets`) — the `_FILE` convention container
images use. Both set: refused, naming both (never a silent choice). The file is read at each use, its
one trailing newline dropped, so a mounted secret the runtime rotates applies at once; an unreadable
one is refused, naming the variable. The hopper does not store a secret itself — not in the database,
not in its own files.

Parts ask through `PluginContext.env(name)` / `DetectionKit.env(name)` (both `runtimeSecrets`;
`AppSeams.env` in tests). The variable is named by a command-bearing option, so a UI session cannot
redirect a credential:

| part | option (default) | was |
|------|------------------|-----|
| database | `HOPPER_DATABASE_URL` (it carries the password; also `_FILE`) | — |
| github-app source | `privateKeyEnv` (`GITHUB_APP_PRIVATE_KEY`; a PEM, real newlines or `\n` escapes) + `appId`, `slug` options | `appFile` → github-app.json + .pem |
| github-gh source | `appKeyEnv` (`GITHUB_APP_PRIVATE_KEY`; null: never pause): `enabled: auto` pauses while it is set | `appFile` readable |
| grokbot-routine notifier | `urlEnv`, `keyEnv` (`GROKBOT_WEBHOOK_URL`, `GROKBOT_WEBHOOK_KEY`) | `envFile` |
| gate-router | `TYPESAFE_API_KEY` (Jev, through TypeSafe) | `typesafeKeyFile` |
| webhook subscription | `secretEnv`, always (from the UI: `WEBHOOK_SECRET_*` only) | inline `secret` (sealed), `secretFile` |
| identity provider (auth.yaml) | `clientSecretEnv` only; a SAML `idpCert` is public and inline | `clientSecret`, `clientSecretFile`, `idpCertFile` |

The App's bot is `<slug>[bot]`, its page `https://github.com/apps/<slug>`. `create-github-app.sh`
writes the key (and webhook secret) as lines of an env file (`--secrets-file`, default the host
unit's `daemon.env`) and prints the `appId` and `slug` to set. The gh and claude CLIs sign in from their own variables (`GH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`) where their login state is not on the machine; they read those
themselves, so no `_FILE` form for them.

**What the hopper keeps is no secret** (issue #56 replaces issue #53's sealing):

| kept | how |
|------|-----|
| a webhook subscription | its `secretEnv`, a variable's name — in the `webhooks` table (`secret_env`, migration 11, which dropped the sealed `secret` column; the only place since migration 14, issue #78) |
| UI session tokens, login codes | SHA-256 only (32 random bytes: no dictionary to try) — the hopper's own short-lived state; a hash is not a usable credential |
| password sign-in passwords | argon2id hashes in `auth.yaml` ("Sign-in") — a verifier the operator writes, not a credential |

`HOPPER_SECRET_KEY`, the secret box (`src/secrets/box.ts`) and the UI's rotate-secret are gone:
with no secret to keep there is nothing to seal. A leftover `HOPPER_SECRET_KEY` is a leftover
variable (boot warning; delete the line). A webhooks-document entry with an inline `secret` — sealed or
clear, from before — was refused at load, and is left out by migration 14 (issue #78) for the same
reason: the rows stay as the daemon last ran them. The one
install there was had no subscription when this landed.

**systemd credentials.** `LoadCredential=<name>:<path>` (or `LoadCredentialEncrypted=`) in a drop-in
for `hopper.service`, with `Environment=<NAME>_FILE=%d/<name>`: the secret never sits in
`daemon.env`.

**Residual risk, stated.** Whoever holds the hopper's runtime holds its secrets, and a job on the
hopper host runs as the daemon's user (it can read `daemon.env` or a readable mounted file). The
database and its backups hold no secret; the database URL is the one credential that opens it.

### Login codes

The daemon writes no login code file. `hopper login-code` mints a one-time code into the
database (`login_codes`: its SHA-256 and an expiry, 10 minutes); `POST /ui/login` takes it once. A
device link mints its own (one code for all its links). `scripts/open-ui.sh` runs the CLI — the
database from `HOPPER_DATABASE_URL`, else that line of `HOPPER_ENV_FILE` (default the unit's
`daemon.env`) — and writes its auto-posting page under `$XDG_RUNTIME_DIR/hopper/` (0700/0600).

### Work dir

`HOPPER_WORK_DIR` (default `<system temp dir>/hopper`) holds scratch only: claude's working
directory for escalation level calls, each plugin's scratch dir, ssh control sockets, Jev's own
`gate-router-runs.jsonl` debug log (grok-bot-jev's run log, not the hopper's state), self-update's mirror and next
install. Losing it loses nothing the hopper needs; the host unit points it at the user's cache dir
(`%C/hopper`) so the update mirror survives restarts. Defaults that named one machine's layout are
gone: `jevSrc` has no default, and a job's working directory defaults to `~` (herdr-claude `cwd`,
the GitHub sources' `defaultCwd`).

### Operator CLI

`src/cli.ts`, installed as `hopper` (`~/.local/bin/hopper` by install.sh,
`/usr/local/bin/hopper` in the image). It opens the daemon's database (`HOPPER_DATABASE_URL`),
so whoever runs it holds the database's credentials — the daemon's own trust, more than any UI
session's. Not an HTTP route, so the rule that every mutation goes through `POST /ui/api/*` is
about the daemon's surface; the CLI is beside it, like editing a file was.

- `config get|version <document>`; `config set <document> --if-version <version>` (stdin);
  `config edit <document>` ($EDITOR, written back against the version read). A document that would
  not load (plugins/webhooks/auth schema, rules size) is refused; a moved one is refused.
- `login-code [--link <base url>]`.
- `password-hash`; `help` (also `--help`, `-h`): every command, exit 0. No command or an unknown
  one prints the same text on stderr, exit 2.

Residual risk, unchanged in kind: a job on the hopper host runs as the daemon's user and can read
the env file and so the database URL, as it could read the 0600 yaml files before.

### Migrating a local install — done, and removed (issue #53)

`migrate-local` moved the one SQLite install there was (rows with their seq, config files as
documents, secrets to env lines) into Postgres, once, on 2026-10-04; the live database has run on
Postgres since. With SQLite gone it had nothing left to read, so it went too (`src/migrate/`, the
CLI command, install.sh's old-config guard). An install still on SQLite moves with a release that
has it (`git log -- src/migrate/local.ts`).

### Deploy recipes

- **This host** (`scripts/install.sh`, systemd `--user`): `daemon.env` (the unit's EnvironmentFile,
  now required) holds `HOPPER_DATABASE_URL` (or `HOPPER_DATABASE_URL_FILE`) and the secrets,
  or names their mounted files; install.sh refuses to finish without
  the database and says how to set it. Postgres from `deploy/compose.yaml` (`up -d postgres`,
  published on loopback), or any Postgres the host can reach.
- **A container** (`Dockerfile`, `deploy/compose.yaml` profile `container`): node 26, git, ssh,
  python3 + PyYAML, gh, the claude CLI; the UI built in a first stage. No herdr in the image: jobs run
  on attached machines over ssh (their keys and `~/.ssh/config` mounted, or the machine source
  configured for none). Self-update does not apply (no install.json; an image is updated by
  rebuilding it). Since issue #119 the image carries herdr and runs jobs itself, and the container
  deploy is `compose.yaml` at the root ("Docker Compose"; since issue #125 the published image,
"The published image, with Podman").

### Settled (issue #40)

- **No object store.** Once config, login codes and secrets left the disk, nothing file-like
  remained that is the hopper's: every document is small text in the database. Jev's debug log and
  self-update's mirror are scratch in the work dir. A blob store would be a service to run for no
  data.
- **Process settings stay environment variables** (`HOPPER_*`: port, LAN, tick, limits, the
  database itself). They configure the process, not a part; a deploy sets them where it sets secrets.

## Deployable for others: help, instructions, the API reference (issue #68, 2026-10-05)

Owner direction: someone who is not the owner can run the hopper and use it from what it ships.

- **`README.md`**: what it is, what it needs, the three ways to run it (this host, a container, a
  checkout in the foreground), first sign-in, how to give it jobs, where everything else is.
- **`hopper help`** (`--help`, `-h`): every operator command, what it needs, where to read on.
- **`node src/main.ts --help`** (`-h`): every `HOPPER_*` setting with its default and what it
  does, built from the config schema (`SETTINGS`, `daemonHelp` in `src/config.ts`; the help text is
  keyed by the schema, so a new setting does not typecheck without its line). Needs no database.
- **The API reference**: `src/http/openapi.ts` builds an OpenAPI 3.1 document of every route under
  `/api/` and `/ui/` (not `/ui/assets/`, not `/`). Query parameters and request bodies are the zod
  schemas the routes parse with (`z.toJSONSchema`, input side), so they cannot drift; summaries, the
  least UI role of each mutation, and what each answers are written there. `src/http/api-reference.ts`
  serves it with Scalar (`@scalar/fastify-api-reference`): `/docs/` the page, `/docs/openapi.json` and
  `/docs/openapi.yaml` the document, `/docs/js/scalar.js` the bundle from the package. The page loads
  nothing from anywhere else: no CDN, no default fonts, telemetry off, Scalar's agent and MCP off, no
  request proxy, no client button. The UI's top bar links it.
- **Drift fails the start.** `apiReferenceRoutes` records every route as it is added (`onRoute`) and,
  on ready, compares them with the document (`referenceDrift`); a route served but not documented,
  or documented but not served, stops the daemon with both named. Every integration test starts a
  daemon, so a new route without its entry fails the suite, not a deploy.
- **Readable without a session.** `/docs/` is outside `/api/`, so a LAN or public request reads it
  as it reads the UI's page; the Host guard still applies. It holds the route list and request
  shapes, which the source already shows; no state, no secret. Trying a route from the page needs
  what the route needs: nothing on loopback for a read, the `x-hopper-session` token beyond it and
  for every `POST /ui/api/*` (with the page's own Origin, which is a UI origin).
- **Responses are described, not schematised**, except the error shape and the event envelope
  (`ENVELOPE_SCHEMA`): the wire types are TypeScript (`src/domain/types.ts`), and a second hand-kept
  schema of each would drift. A generator from the types was rejected: a build step and a dependency
  for a reference one person reads.


## Connecting GitHub: the gh CLI by default, an App of one's own (issue #108, 2026-10-05)

Owner direction: a self-hoster leaves the install knowing which GitHub path they are on and how to
set it up, and is never steered toward a shared App private key.

- **The gh CLI is the default.** A fresh store's plugins.yaml has the `github` instance (github-gh)
  on `enabled: auto` (`builtinInstances`): it runs as the owner through `gh auth login`, and pauses
  while `GITHUB_APP_PRIVATE_KEY` is set. Until #108 the built-in was `enabled: false`, so a new hopper
  had no working path until the owner created an App. An existing plugins.yaml is never rewritten
  ("Settled in slice 4"); a hopper set up before keeps what it has.
- **Each owner creates their own GitHub App** with `scripts/create-github-app.sh` (the manifest
  flow): one App, one key, one hopper. hopper ships no App and no key. A shared key would let every
  holder act on every repository the App is installed on, and nothing in the hopper could tell them
  apart.
- **`install.sh` names the path** at the end of an install: the App when its key is in `daemon.env`,
  the gh CLI when it is signed in, else the next step for both.
- **Not built, named only** (README "Connect GitHub"): GitHub sign-in from the UI (OAuth, or a
  fine-grained personal access token pasted in), and a hosted relay App forwarding to many hoppers.
  Either would put a credential, or another party, where the hopper now has neither; neither is the
  path for a self-hosted hopper.

## Plugin store (issue #75, 2026-10-05)

Owner direction: there is a store to install plugins from. Code: `src/plugins/plugin-store.ts`
(the service), `src/plugins/plugin-store-catalogue.ts` (the catalogue, pure), `src/plugins/plugin-store-git.ts`
(the git CLI); routes `GET /api/plugin-store`, `POST /ui/api/plugin-store`; the UI's Plugins view.

**What a plugin store is.** A git repository, named by the process setting `HOPPER_PLUGIN_STORE`
(anything `git fetch` takes: ssh or https URL, a local path; no default — unset, there is no plugin
store). Its default branch's root holds the **store catalogue** `plugin-store.yaml`:

```yaml
version: 1
plugins:
  - { id: echo-executor, role: executor, describe: Finishes every job at once with its prompt as the result, path: examples/plugins/executor/echo-executor }
```

`id` matches the custom-plugin id rule; `role` is a role; `path` is a relative directory inside the
repository (no `..`, not absolute); ids are unique; unknown keys are refused. This repository is a
plugin store: its `plugin-store.yaml` lists `examples/plugins/`.

**Why the store is a process setting and not a UI choice.** Installing a plugin runs its code in
the daemon (the import runs the module). A UI session is readable by jobs running with
`--dangerously-skip-permissions` ("UI session and mutations"), which is why command-bearing options
are never UI-editable. The same rule applies here: the UI chooses only among what the operator's
plugin store lists; which repository that is, the operator sets where the UI cannot. It is the trust
self-update already makes: the repository the operator named is trusted as the install itself is.
No signature check.

**Reading.** A bare mirror at `<work dir>/plugin-store/repo.git`; each read fetches the store's
`HEAD` (its default branch) with the update mirror's git environment (never prompts, ssh batch
mode). Read at start in the background (a slow or unreachable store never delays the boot), and on
`refresh`. A catalogue that cannot be fetched or parsed → state `error` with the reason; the last
good catalogue stays listed. No plugin store → state `unavailable`.

**Where store installs are kept (issue #93).** Nothing durable lives on the machine: an ephemeral
container has no config directory to keep. A store install is a row of the database (`settings` key
`pluginInstalls`: `{ id, role, describe, commit, tree, installedAt }`, `PluginInstall`); its code is
unpacked into `<work dir>/plugin-store/installed/<id>`, scratch, which the plugin host loads after the
plugin dir. **Restore:** at start, before the plugin host loads plugins, every store install whose
directory is missing (a fresh work dir) is unpacked again from the store by its `tree` id, so
plugins.yaml finds it at the first load; the store is fetched only then (a boot with every install in
place, or none, never waits for it). One that cannot be restored is logged and left out; it stays in
the database. The plugin dir is the operator's and never written. A store install an earlier version
left in the plugin dir (a directory holding `.plugin-store.json`) is moved into the database and the
work dir at the first start, its directory removed.

**Installing** (`{ action: 'install', id }`; also how a store install is updated to the store's head):

1. Refused — 404 an id the catalogue does not list; 409 a built-in id, or a directory of that id in
   the plugin dir (the operator's own, never replaced).
2. The plugin's directory at the store's head (`git archive <commit>:<path>`) is unpacked into
   `<work dir>/plugin-store/installed/.install-<id>` (the loader skips dot directories).
3. Proof it loads: it must have `index.ts` or `index.js`, import with the custom-plugin loader, and
   declare the catalogue's `id` and `role`. Else 409 with the reason; the staging directory is removed
   and nothing changes.
4. The old directory (an update) is removed, the new one renamed into place, and the store install
   (`{ id, role, describe, commit, tree, installedAt }`, `tree` the directory's git tree id) written to
   the database.
5. Rescan (the plugin host): a new plugin is in `/api/plugins` at once. An updated one keeps its
   old code until the daemon restarts (Node caches the import): `restartPending: true`.
6. `plugin.installed` `{ id, role, commit }`.

A store install is **current** while its `tree` equals the catalogue directory's tree at the
store's head — a store commit that does not touch the plugin does not offer an update.

**Removing** (`{ action: 'remove', id }`): only a store install (404 otherwise). Refused (409) while
plugins.yaml names it in any instance, or it is the router in use (a detected router) — change those
first, as for an executor ("Settled in slice 7"). Then the database row and the directory go, rescan,
`plugin.removed` `{ id }`.

**Not built.** Installing dependencies: a store plugin imports `node:` builtins and its own files,
or ships its `node_modules` in its directory (the plugin contract already says so) — no `npm install`
runs. Several plugin stores. Pinning a store to a branch or tag other than its default branch.

**Report** `GET /api/plugin-store` (`PluginStoreReport`): `state` (`unavailable` + `reason`,
`ready`, `error` + `error`), the store's `repo`, `commit` and `checkedAt`, and per plugin the
catalogue entry with `installed` (`{ commit, installedAt, current }`) and `restartPending`. A store
install the catalogue no longer lists is still listed (`listed: false`), so it can be removed.
`POST /ui/api/plugin-store` (admin): `{ action: 'refresh' }`, `{ action: 'install', id }`,
`{ action: 'remove', id }`; answers the new report. Edits run one at a time.

**UI.** The Plugins view's **Plugin store** card: the store, its commit and last read, Refresh; per
plugin its role, description, and Install, Update (not current) or Remove (confirmed); `restart
pending` where it applies. Installing does not configure: the plugin then shows under its role,
selected or added as any custom plugin.

## Webhook subscriptions in the database (issue #78, 2026-10-05)

Owner request: webhook setup does not say or use `webhooks.yaml`; every webhook setting is stored
in the database.

- **The `webhooks` table is the source of truth**, and the only place a subscription is kept. No
  config document holds them: `CONFIG_DOCUMENTS` is `plugins.yaml`, `rules.md`, `auth.yaml`, and
  `hopper config` knows no other. The watcher (`src/webhooks/config.ts`, a re-read every 5 s)
  and the YAML splice editor are gone: nothing to watch, nothing to reconcile.
- **`POST /ui/api/webhooks`** writes one row: `add` inserts (409 when the name is there — the insert
  is `ON CONFLICT (name) DO NOTHING`, so two sessions adding one name cannot both win), `edit`
  changes only the fields sent (url, events, active), `remove` deletes the row and fails its
  pending and retrying deliveries. No `version`: each edit names one subscription by `name` and is
  one statement; a concurrent edit of the same subscription is last-write-wins, which one admin
  can live with. The content check is the editor's own zod schema (`src/webhooks/edit.ts`); 400
  names the field (`url: …`, `events.0: must be an event type or "*"`).
- **`GET /api/webhooks`** is `{ subscriptions }`: the `config` status (document, loadedAt, error,
  warnings, version) described a document, and there is none.
- **Store port.** `WebhookRepository.add` (undefined when the name is taken) and `update` (only the
  fields given) replace `upsertByName`, which existed to reconcile a document.
- **Migration 14** (a function: the document is YAML) moves an existing `webhooks.yaml` document
  into the table and deletes it. The table had been the document's projection, so a running hopper
  already held its rows; the migration covers a document edited while the daemon was down, and the
  rows migration 11 left with no `secret_env`. A document that loads (its rules as of migration 11:
  version 1, every entry with name, url, events, secretEnv, no inline `secret`, names unique)
  becomes the rows — by name, so a kept row keeps its id and deliveries; a row it does not name is
  deleted, its open deliveries failed. A document that would not have loaded never reached the
  table, so the rows stay as the daemon last ran them. Either way the document goes.
- **A subscription naming a variable outside `WEBHOOK_SECRET_*`** (possible before, from the
  document by hand) stays as it is: an edit never changes `secretEnv`. A new one names a
  `WEBHOOK_SECRET_*` variable; renaming the variable is remove + add.

