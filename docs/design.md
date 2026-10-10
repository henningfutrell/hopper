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
                      │   machines · lanes · usage · waiting · running · advice
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
| `src/domain/` | types (`types.ts`, re-exporting the ones split out to stay readable: `usage.ts` usage readings, usage report, accounts, usage pacing; `decider-policy.ts` the decider's policy; `usage-history.ts` usage samples and the usage graph; `machines.ts` attached machines and their edit; `webhooks.ts` the webhooks edit; `question-gates.ts`; `routing.ts` routing rules; `plugins.ts`; `users.ts` users; `queue-gate.ts` the queue gate; `locked.ts` the locked entry; `machine-pick.ts` the machine a part that runs claude and names none uses, and how Settings shows a level whose machine cannot run it, pure — issues #442, #482; `review.ts` review sections — proposals and research reports, one model: statuses, versions, the trail, decisions, settings, each section declared by its `ReviewSectionType`, their parts read from the text (pure), issues #537, #543; `questions.ts` a question, its trail and the machine that raised it; `phase.ts` phase shifts — a job's phase (work, research, proposal), fork and switch, the settings, suggestions and what a job is told (pure), issue #548; `sections.ts` the section types — Questions, Proposals, Research, Logins, Failures — in nav order, issue #543; `sources.ts` a job source's status; `yolo-mode.ts` yolo mode — whether a job may merge its own pull request, per repository (pure), issue #579; `pull-requests.ts` after done — a done job's verdict (done, partly done, not) and what following its pull request found, issue #579; `pull-request-list.ts` the Pull requests list — each PR waiting job's pull request per job repository, with its yolo mode, and where merging waits (pure), issue #637; `item-snapshots.ts` item snapshots — an item's approved text, its hash, a text change (pure), issue #662; `source-item.ts` a source item and the source as the host takes it), ports (`ports.ts`, re-exporting the store's from `store.ts`, with the settings repositories from `settings-store.ts`, and the escalation levels' and the review's from `escalation-ports.ts`) | anything else in `src/` |
| `src/decider/` | `decide(inputs, decisionId): Decision` — pure, no I/O, no clock | everything but `domain/` |
| `src/store/` | the database seam (`db.ts`: Postgres through `postgres-worker.ts`), schema, migrations (the instance's `migrations.ts` with migration 15 in `migration-attached-machines.ts`, 17 in `migration-users.ts`, 20 in `migration-accounts.ts`, 21 (owner → the default admin account, issue #220) in `migration-admin.ts`, 22 (no password user realm, issue #237) in `migration-no-password-realm.ts`, the users' tenant track `tenant-migrations.ts`), the instance store (`index.ts`: users, identity links, UI sessions, login codes, the sign-in config — `sign-in-config.ts` —, instance settings) and each user store (`user-store.ts`: repositories, event log, config records — `config.ts`); `migration-config.ts` moved the config documents to config records (issue #198); `migration-level-names.ts` (tenant 5) names escalation levels as levels (issue #209); `migration-jobs-dir.ts` (tenant 11) moves a work tree stored as `~` to the jobs directory (issue #314); `migration-connected-accounts.ts` (tenant 8) adds the connected account and its job source, `connected-accounts.ts` its repository, `migration-device-realms.ts` (23) the github realm through the hopper's app (issue #214), `migration-no-bootstrap.ts` (24) no bootstrap user (issue #238); 25 the join codes (issue #308); 26 the update channels (issue #423); `migration-session-lifetime.ts` (27) sessions that renew (issue #439) and `migration-client-key.ts` (tenant 12) the client targets that held a token variable; `migration-no-gh-source.ts` (tenant 14) takes out the gh CLI job source (issue #359); tenant 15 the usage history's `usage_samples`, `usage-history.ts` its repository and the usage graph's SQL (issue #385); `migration-name-the-machine.ts` (tenant 17) names the one machine that can run claude in a level or usage source that names none (issue #442); `migration-machine-work-trees.ts` (tenant 18) moves the paths that named no machine onto machines and routing rules (issue #361); tenant 21 the `logins` table, `logins.ts` its repository (issue #476); tenant 22 the `failures` and `problems` tables, `failures.ts` their repositories (issue #509); 29 the access tables, `access.ts` their repository (issue #559); tenant 32 the job stream's `job_stream` and `watches` (`migration-job-stream.ts`), `job-stream.ts` their repository (issue #613); tenant 34 the artifacts' `artifacts` and `artifact_shares` (`migration-artifacts.ts`), `artifacts.ts` their repository (issue #624); `fold-user.ts` one user schema's rows into another's, for `UserRepository.fold` (issue #265); `kept-secrets.ts` what every user's schema keeps sealed under the master key (issue #659) | engine, http, decider |
| `src/users/` | users (issue #158): one user's runtime (`runtime.ts`, every part of theirs composed over their user store), the runtimes of every user (`runtimes.ts`: start, add, stop, instance events fanned out), a user's environment (`env.ts`: secret prefix, CLI config dirs, user work dir), a user's Jev and TypeSafe API key (`typesafe-key.ts`, issue #657), a user's system secrets at start and the move of the old copies (`system-secrets.ts`, issue #658), the instance's system secrets and the sign-in config over them (`instance-secrets.ts`), identity → user (`identities.ts`: link or provision), the leftover default admin account folded into the first GitHub admin's user at start (`leftover-admin.ts`, issue #265), a user's job sources split for the sync loop at start and on each change (`job-sources.ts`, issue #356), the doubles a runtime takes at its seams in tests (`seams.ts`), a user's link key and their client targets reached down their links (`link.ts`, issue #308), a user's side of the GitHub proxy (`github-proxy.ts`, issue #563), a user's job stream with the types each part registers, and the user's artifacts that emit on it (`job-stream.ts`, issues #613, #624), a user's executors as the plugins config has them now (`executors.ts`) | http, decider |
| `src/webhooks/` | signing, dispatcher, retry/backoff, a subscription's signing secret — a system secret in the user's vault (issue #658), or the runtime variable of one from before (`secrets.ts`, issue #451) —, the UI edit of the subscriptions and their secrets (`edit.ts`, rows in the store) | engine, http, decider |
| `src/plugins/` | the plugin SDK (`sdk.ts`, imported by authors as `hopper/plugin`), built-in list (`builtin.ts`), custom loader, detection kit, the plugins config (`plugins-config.ts`) + watch, the host's contract (`host-types.ts`), the role slots (`router-slot.ts` with the shared `instantiate`, `queue-sorter-slot.ts`, `level-slot.ts`, `executor-slot.ts`, `source-slots.ts` for job, machine and usage sources and vault backends, `notifier-slot.ts`), attaching an ssh target as an `ssh` machine instance (`attached-edit.ts`; `attached-slot.ts` wires it into the host), the plugins-file migration and the built-in instances (`migrate.ts`), the locked-down `claude -p` runner the claude plugins share (`claude-print.ts`), `expand-home.ts`; built-in plugins under `<role>/<id>/` (`router/jev-router/` holds the Jev shim; `escalation-level/claude-cli/` holds its prompt, `escalation-level/anthropic-api/` asks the Claude API with the same prompt; `executor/herdr-claude/`, `executor/cursor-agent/`, `executor/command/` and `executor/test/` wrap the adapters in `src/executors/`; `job-source/github-app/` and `job-source/github-account/` build the GitHub sources of `src/sources/`; `machine-source/local/` wraps `src/machines/`; `machine-source/ssh/`, `machine-source/docker/`, `machine-source/client/` are the attached machines, reached through the context's `target` (issue #74); `usage-source/claude-plan/` reads Claude subscription usage and the Claude account from the claude CLI (parser); `usage-source/command-usage/` reads any agent framework's usage and account from a command that prints them as JSON; `usage-source/polled.ts` the background refresh both share, `usage-source/run.ts` their command runner; `notifier/grokbot-routine/` is the Grok Bot routine webhook — the routine from the runtime, the notifier, its payloads; `vault-backend/hashicorp-vault/`, `vault-backend/1password/`, `vault-backend/bitwarden/` the vault backends (issue #585), `vault-backend/credential.ts` their token from the runtime; `queue-sorter/priority/`, `queue-sorter/oldest-first/`, `queue-sorter/newest-first/` the built-in queue sorters); the routing rules as configured, their report and UI edit (`routing-config.ts`); the plugin store (`plugin-store.ts` the service, `plugin-store-catalogue.ts` its catalogue, `plugin-store-git.ts` its git mirror — "Plugin store") | engine, http, store, decider, questions |
| `src/executors/` | `Executor` adapters (`test`, `herdr/`, `command.ts` — a job's body run on its machine through its connection, `print-agent.ts` — an agent CLI in print mode there, Cursor's agent (issue #142), codex, opencode and omp (issue #307), each CLI's call and reading in `print-agents.ts`) and the registry; reached through the executor plugins. The connections and their target authentication ("Target authentication"): `ssh.ts` (key-only ssh to pinned host keys), `ssh-key.ts` (the hopper's own ssh key, kept in the user's store, issue #293), `docker.ts` (the docker socket check, the proxy's allowlist), `client.ts` (a client target's tunnel, signed calls); `env.ts` the scrubbed child environment | engine, http, store, plugins |
| `src/client/` | the hopper client ("Client targets", "Joining a machine"), installed on a client target as plain files: `server.ts` (signed `POST /herdr`, `/release`, `/load`, `/claude`, `/level`, `/reap`, `/survey`, `/credential`, `/work-tree`, `/discover` over HTTP/2 on its link), `discover.ts` (the discovery script and the curated AWS actions and kubectl checks it asks, issue #542), `credential.ts` (a running job's credential file, issue #441), `level.ts` (an escalation level's locked-down claude run, its argv and its call; shared with `src/plugins/claude-print.ts`, issue #482), `work-tree.ts` (making a machine's work tree, shared with this machine's source, issue #361), `resources.ts` (the machine's CPU, memory and swap meter, shared with this machine's source, issue #560), `dial.ts` (its dial-in to the hopper's URL), `join.ts` (joining with a join line), `link.ts` (the link keys and the client token they give; shared with the hopper), `release.ts` (the client release: its files, its manifest and id, checking and installing one — "Client releases"), `main.ts`; `signature.ts` (the token's HMAC, shared with `src/executors/client.ts`) | everything in `src/` outside `src/client/` |
| `src/machines/` | `MachineSource` adapters: `local` (reached through the `local` machine-source plugin), attached machines (`createAttachedMachines`, following the plugins config; ssh probe and the check that herdr is found there by name (`REMOTE_PATH`, issue #311) through the herdr CLI client's ssh argv; the container probe, `docker container inspect`), the detected ssh targets (`ssh-config.ts`) and which of them is this machine (`this-machine.ts`, issue #275), a machine's disk (`disk.ts`) and its CPU, memory and swap (`resources.ts`: the ssh probe's reading and a client's answer checked, issue #560), the resource recorder (`history.ts`, issue #560, over the `MachineHistoryRepository` port), keeping each client target on the hopper's client release (`client-release.ts`) and the bridge for a client with a fixed file list (`client-bridge.ts`, issue #545), the links of the machines dialled in (`links.ts`) and their join codes (`join-code.ts`, issue #308), `combineMachineSources` | engine, http, store, plugins |
| `src/usage/` | `UsageSource` adapters: `fake` — a test double at the seam (`AppSeams.fakeUsage`), never composed in production (the production usage source is the `claude-plan` plugin); the usage history's recorder (`history.ts`, issue #385), over the `UsageHistoryRepository` port | engine, http, store, plugins |
| `src/logins/` | logins (issue #476, "Logins"): the logins a job or run waits on (`service.ts`: report, check, complete, fail, cancel, new code, the sweep, the view), the login kinds (`kinds.ts`), each CLI's device-code prompt and hiding its code (`recognise.ts`, pure), a print-mode run's output watched for one (`run-output.ts`). Its URL and code are kept in memory only. Executors and plugins use `recognise.ts` and `run-output.ts`, never the service: they report through the `RunLogins` port | engine, http, store, plugins, executors, decider, questions |
| `src/review/` | the review of every review section — Proposals, Research (issues #537, #543, "Sections"): `ReviewService`, one per section from its type (`service.ts`: the structural pre-check (`pre-check.ts`, pure) → the reviewer levels, lowest first → a person; a person's decision, one the section declares; the sweep and recovery), the reviewer reply it accepts (`reply.ts`), each section's settings (`settings.ts`). The reviewers are escalation levels (their `review`, `src/plugins/`); items through the `ReviewItemRepository` port, a table per kind; the job's side (waiting, ending, moving on to the next section it asks for, re-queued with what to do next) is the engine's (`src/engine/reviews.ts`) | engine, http, store, plugins, executors, decider |
| `src/failures/` | the failure assessor (issue #509, "Failure assessment"): the signature (`signature.ts`, pure), the known causes (`causes.ts`, pure), the judgement of one failed job (`assess.ts`, pure), a timed-out job's rules (`timed-out.ts`, pure), what the assessor reads of a job's chain (`chain.ts`), its pull request lookup and Continue (`timeouts.ts`, issue #630), the machine it ran on and its evidence (`evidence.ts`, pure), the profile (`profile.ts`, pure), the service — assessing on `job.failed`, the pending runs again through the sync loop's Run again, the checks, the prune (`service.ts`) —, the check before any run again that finishes a job whose work is done at its source in its place, and a done-check miss's look again before it is assessed (`done-at-source.ts`, issue #637), the done-check backfill (`backfill.ts`, issue #637), the hand-offs to a person (issue #516: when one opens, `handoff.ts`, pure; opening, closing and a person's resolution, `handoffs.ts`; what a job that follows one is told, `brief.ts`, pure — issue #551; the work check, asking the source what an open hand-off's work shows, `work-check.ts`, and its card, `card.ts`, pure — issue #621) and what the Failures view reads, with each action's refusal (`view.ts`). Its records, problems and hand-offs through the `FailureRepository`, `ProblemRepository` and `HandoffRepository` ports | engine, http, store, plugins, executors, decider, questions |
| `src/minor-decisions/` | decider calls through Jev first (issue #550, "Decider calls"): Jev at its seam (`jev.ts`, `jev_pick.py`: one TypeSafe Choice through `typesafe_sdk`), the service — each point's settings, the pick and whether it is applied, the comparison with what was decided after it, the override, the view (`service.ts`) —, a question's listed options (`options.ts`), what makes a decision consequential (`guard.ts`, over the question risk rules), the view from the events (`view.ts`), the user's TypeSafe API key — checked, kept in the vault's system scope, imported once from the variable (`typesafe-key.ts`, issue #657); all but `jev.ts`, `service.ts` and `typesafe-key.ts` pure. Its ports (`JevChooser`, `JevFirst`) are in `src/domain/minor-decisions.ts`; the question pipeline (`src/questions/jev-first.ts`) and the failure assessor (`src/failures/jev.ts`) ask it | engine, http, store, plugins, executors, decider |
| `src/tldr/` | the TL;DR (issue #569, "TL;DR"): its rules — the text a card's TL;DR is written from, which cards get one, the prompt, the answer made plain text, the agent's summary as the fallback, which stored one a card shows (`text.ts`, pure but for the hash) —, the sweep that writes them (`service.ts`), its model: Claude Haiku through the `claude` CLI and the sweep with it (`haiku.ts`, composed by the user runtime alone) | engine, http, executors, decider; plugins but in `haiku.ts` |
| `src/reliability/` | lane reliability (issue #535, "High priority everywhere"): runs read from the event log and each lane's figures over a window (`measure.ts`), the lane fault (`fault.ts`, over the failure assessor's known causes), choosing the priority lanes with hysteresis (`rank.ts`); all pure | everything but `domain/` and `failures/causes.ts` |
| `src/blast-radius/` | blast radius (issue #542, "Blast radius and actor machines"): a discovery's output read into its facts (`read.ts`), each machine's reach and level rated by the rules, what a discovery changed, and why the gate keeps a machine (`rate.ts`); a template's rating from its operation profiles and vault secrets (`template.ts`, issue #584, "A template's blast radius"); all pure | everything but `domain/` and `client/discover.ts` |
| `src/authz/` | access (issue #559, "Access: OpenFGA decides each mint"): the decision before every mint, the push of the model and approvals to OpenFGA, the view (`service.ts`); the access model and what an edit must keep (`model.ts`, @openfga/syntax-transformer); the objects and tuples, the relationship path (`objects.ts`, pure); requesters — whether one may ask, the permission matrix's rows (`requesters.ts`, pure, issue #581); OpenFGA at the `AuthorizationServer` port (`openfga.ts`, @openfga/sdk). Its rows through the `AccessRepository` port; a job's status and who is live through the composition root | engine, http, store, plugins, executors, decider |
| `src/job-rules/` | the job rules (issue #172): the config record `job-rules`, the default job rules, the fixed lines of the footer (work tree, protocol), their read, view and edit — no I/O but the config records port | everything but `domain/` |
| `src/routing/` | routing rules: the plugins config's `routing` schema and the pure matching applied at intake (`routeItem`) — no I/O (issue #18) | everything but `domain/` |
| `src/engine/` | the loop: gather → decide → apply (the queue sorter asked while gathering, `queue-order.ts`; the queue gate — auto-accept before each Decision, accept, reject, the user order — `queue-gate.ts`); job lifecycle; parking (`park.ts`) and auto-park on each tick (`auto-park.ts`, issue #650); routing at intake (`source-host.ts`); restart recovery; a job's credential files on its machine, kept current at each renewal (`credentials.ts`, issue #441); the check before a nudge (`nudge-check.ts`, issue #627); item snapshots at intake — record, compare, hold, keep the original, accept the new text (`item-snapshots.ts`, issue #662) | http |
| `src/auth/` | sign-in through realms (issues #39, #185): the sign-in config's load (`config.ts`) and edits (`edit.ts`), the sign-in config at start — named secrets taken in, the environment applied (`start.ts`, issue #216; no bootstrap login, issue #238) — and the `HOPPER_SIGN_IN_*` variables (`environment.ts`), the realms' secrets in the instance's vault (`sealed-secrets.ts`, issue #658), the role rules (`roles.ts`, pure), the realm ports (`realm.ts`: redirect realm, form realm, gateway realm) and their adapters `ldap.ts` (ldapts), `oidc.ts` (openid-client), `github.ts` (openid-client + the GitHub REST API), `saml.ts` (@node-saml/node-saml), `gateway.ts` (jose + openid-client), the sign-in service — form realms in order, gateway realms in order, the API door's token check (issue #255), flows, tickets, bindings, no sign-in, a changed sign-in config applied at once (`index.ts`) | engine, http, store, plugins, decider, questions |
| `src/connected-accounts/` | signing in with GitHub and working through it (issue #214, "Sign in with GitHub, and work through that connection"): the hopper's app (`hopper-app.ts`), the device flow (`device-flow.ts`, @octokit/oauth-methods), the web flow (`web-flow.ts`, openid-client; issue #258), who a token belongs to (`identity.ts`), a user's connected account (`service.ts`), its renewal (`renewal.ts`, `renewer.ts`), its tokens at rest (`at-rest.ts`; issue #441, "Keeping the connection") and the revocation of a grant it replaces or drops (`revocation.ts`; issue #514, "One grant per connection") | engine, http, store, plugins, decider |
| `src/github-proxy/` | GitHub through the hopper (issue #563, "GitHub through the hopper"): a job's proxy token (`token.ts`, derived from the user's link key), the request it takes and who may ask what (`policy.ts`, pure), the rate limits (`limits.ts`), the GitHub calls (`api.ts`, `@octokit/request`), `hopper-gh` (`script.ts`), the broker (`broker.ts`); a user's side of it is `src/users/github-proxy.ts`, its route `src/http/job-github.ts` | engine, http, store, plugins, decider |
| `src/skills/` | skills (issue #582, "Skills: what the hopper can set up for a box"): the baked-in skills, the catalog, a link's text and a skill's credential (`catalog.ts`, pure; issue #583), `hopper-skill` (`script.ts`), the broker (`broker.ts`), a request a job waits on — its watch opened, asked again when the vault changes or the job subscribes (`waits.ts`, issue #613); a job's token through `src/github-proxy/token.ts`, Access's decision and a box's template through its route, `src/http/job-skill.ts` | engine, http, store, plugins, executors, decider |
| `src/artifacts/` | artifacts (issue #624, "Artifacts"): one user's artifacts — put, share, revoke, remove, the limits, the masking of GitHub tokens, the retention sweep (`service.ts`); the content policy per kind and the signed content URL (`content.ts`); the bundled diagram and chart libraries and their route (`libs.ts`, issue #675); where a link points (`links.ts`, issue #673, pure); `hopper-artifact` and the `artifacts` skill's text (`script.ts`); the job stream types and the artifact events put on a job's stream (`stream.ts`). Its rows through the `ArtifactRepository` port (tenant migration 34, `src/store/artifacts.ts`); its routes `src/http/artifacts.ts`, `src/http/job-artifacts.ts`, `src/http/ui/artifacts.ts` | engine, http, store, plugins, executors, decider |
| `src/job-stream/` | the job stream (issue #613, "The job stream"): the stream types each part registers with its phase (`types.ts`), the wire form — whole or a result pointer, one builder — and the SSE frame (`wire.ts`), one user's stream: emit, open a watch, the sweep that ends a watch at its deadline or its job's end (`stream.ts`). Its rows through the `JobStreamRepository` port; its route `src/http/job-stream.ts` | engine, http, store, plugins, executors, decider, skills |
| `src/secrets/` | the runtime's secrets (`runtime.ts`): a secret by name, from the variable or the mounted file `<name>_FILE` names ("Secrets"); the token box (`token-box.ts`, issue #441) that sealed a connected account's tokens under `HOPPER_MASTER_KEY` before issue #658, now read only to move them into the vault; the sealer (`sealer.ts`, issue #451) that seals every other secret the hopper owns under it ("Sealed in the database"); the master key from the launch, its fingerprint check, and the old token key moved (`master-key.ts`, issue #659, "The master key"); the secret mask (`mask.ts`) and the log mask every log line goes through (`log-mask.ts`, issue #685) | everything |
| `src/vault/` | the vault (issue #558, "The vault"): its secrets and templates (`service.ts`), its key provider chosen — the master key or a KMS (`keys.ts`, `kms.ts`, issue #586) —, where it runs: in the hopper or in a container of its own (`index.ts`, `vault.ts`, `remote.ts`, `server.ts`, `main.ts`, `wire.ts`); whose ask a box's ask is (`box.ts`); minting through Access and the minting adapters, STS and the Kubernetes API (`mint.ts`, `minter.ts`, issue #580); the system scope, the hopper's own secrets: its one way in (`system.ts`, issues #657, #658), a job's ask for one refused (`system-read.ts`) and its view and audit trail (`system-view.ts`). Its rows through the `VaultRepository` port; the attached machines and the job's token through the composition root | engine, http, plugins, decider, executors |
| `src/sandboxes/` | sandbox boxes the hopper starts (issue #603, "Sandbox boxes the hopper launches"): the launch, the keeping in step with the machines and the cleanup problems (`service.ts`); rootless Podman at the `SandboxEngine` port (`podman.ts`, its libpod API over node:http). The machines, the join codes and the users through the composition root | engine, http, store, plugins, decider, executors |
| `src/update/` | self-update ("Self-update"): install.json, the git mirror of the update repository, the build of the next install (install.sh build-only mode), the swap, the restart (exit or respawn), restart blockers; the move of a job-hopper install to the new names (`rename.ts`, "Rename from job-hopper") | engine, http, plugins, decider |
| `src/http/` | Fastify routes, SSE, static UI; whose request it is — the session's user, or a loopback read's (`tenants.ts`) — and the users list (`users.ts`) and the instance totals (`instance.ts`); the usage graph's reads (`usage-history.ts`, issue #385); whether a session is an instance admin (`instance-admin.ts`, issue #240); the master key's status and its banner's read (`master-key.ts`, issue #659); the hopper's admin's own mutations, self-update and the master key (`ui/instance.ts`); the UI session, its role check and the sign-in routes (`ui/`); the API reference (`openapi.ts` the document, `openapi-operation.ts` its operation type, `api-reference.ts` Scalar at `/docs/`); the plugin store's read side (`plugin-store.ts`); machines joining and dialling in (`client-link.ts`, issue #308); Add machine's join code and the sandbox box the hopper starts (`ui/machine-join.ts`, issues #308, #603); the failures read (`failures.ts`) and its actions (`ui/failures.ts`, issue #509), access's read (`access.ts`) and its actions (`ui/access.ts`, issue #559), the UI route groups registered with the role guards (`ui/route-groups.ts`) | executors, plugins (reads them through the `PluginsView` and `PluginStoreView` ports) |
| `ui/` | the UI: Vite + React + shadcn/ui + Tailwind + d3, built to `ui/dist` (gitignored) — browser only. `ui/src/model/` is pure (tested from `test/ui/`); `ui/src/components/ui/` is vendored shadcn | all of `src/` at runtime; **type-only** imports from `src/domain/types.ts` (the wire contract has one definition) |
| `scripts/agent-box/` | the agent box's image (issue #295, "Agent boxes"; under `scripts/` because the install and the image carry `scripts/`, not `deploy/`): `Dockerfile` (one agent CLI per build, sshd, the herdr binary put beside it by `scripts/agent-boxes.sh`) `entrypoint.sh` (sshd, then the box's herdr session) and `pickup.ts` (the box side of the pickup protocol, `hopper-pickup`, issue #319: node's own modules only, the box runs it with no install); `scripts/agent-boxes.ts` is the script's plugins-config filter, `scripts/box-pickups.ts` the pickup protocol's reader | everything in `src/` |
| `scripts/box/` | the sandbox box's image (issue #308, "Joining a machine"; built from the repo root, it carries `src/client`): `Dockerfile` (one agent CLI, herdr, the client) and `entrypoint.sh` (herdr's session, then the client, again after each release load); `scripts/client-install.sh` is the install a computer's line runs, served at `/client/install` | everything in `src/` but the client files it copies |
| `site/` | the GitHub Pages site (issue #382), built by `npm run build:site` (`site/vite.config.ts`) into `site/dist` and published by `.github/workflows/pages.yml`: `index.html`, the front page — the signed-out landing page's backdrop and story (`ui/src/app/story.ts`), the one-line install, a feature tour (`site/tour.ts`) with the screenshots in `docs/screenshots/` — and `install.html`, the install page; styled by `site/site.css`, which imports `ui/src/index.css` whole, so the site and the UI share one look; served beside them, `scripts/get.sh` as `install.sh`, `compose.yaml` and the logo; nothing loaded from another site | everything of `src/`; of `ui/` only `index.css` and `app/story.ts`; it links to the docs on GitHub |
| `scripts/screenshots/` | the screenshots in `docs/screenshots/` (issue #353), made by `npm run screenshots`: `demo.ts` starts a busy demo hopper — the real composition root through `test/support/app.ts`, over the test doubles (fake GitHub with a connected account, scripted test executor, machines whose probe answers online, fake escalation levels) with made-up data — `doubles.ts` seals it off (throwaway HOME, the hostname replaced, `ssh`, `claude` and `herdr` refusing, fetch loopback-only) and speeds its clock up while it builds an hour of history, and `capture.ts` photographs the UI with Playwright and writes WebP | nothing of a real machine, network or account; it never runs in the daemon |
| `examples/plugins/` | one minimal runnable custom plugin per role, for authors (`docs/plugins.md`); imports only `hopper/plugin` types and `node:` builtins | everything in `src/` at runtime |
| `src/main.ts` | composition root: config → instance store → sign-in config (`prepareSignIn`: the environment applied) → plugin store → updater → server → one user runtime per user (`src/users/`) | — |
| `src/startup-log.ts` | the daemon's startup lines (listening, parts, sign-in) | — |
| `src/cli.ts` | the operator CLI `hopper`: config records as JSON, login codes, users, `help` — against the daemon's database | engine, executors |
| `src/cli-operator.ts` | the operator CLI's operator actions (issue #374): `job`, `queue`, `question`, each the UI's `POST /ui/api/*` on the running daemon under a UI session minted for the one call; what one action is (`cli-operator-call.ts`) and `artifact` (`cli-operator-artifact.ts`, issue #673) beside it; `typesafe-key` and `master-key status` (`cli-operator-keys.ts`, issues #657, #685) | engine, executors, store |

## The decider

`decide(inputs: DecisionInputs, decisionId: string): Decision`. Deterministic: same inputs,
same Decision. Algorithm, in order:

1. **Usage fraction per machine.** `usedFrac(m)` = max of `used/limit` over the readings of
   `m` (`readingsOf`): those whose `machineId` is `m` when any of them throttles — that machine's
   own account (issue #139) — else those whose `machineId` is `m` or absent. Readings with `limit <= 0` are ignored and noted in
   `reasons`. **Informational readings** (`informational: true` — a window that limits one
   model only, issue #18) are skipped. So is a reading whose `resetsAt` is at or before `inputs.at`
   (its window reset since it was read), and a week window in its **burn window** ("Usage pacing").
   No readings → `0`. Since issue #140 steps 1-2 run per executor, over the
   readings that limit its jobs ("Usage per executor").
2. **Lane cap per machine** (`policy.softLimit`, `policy.hardLimit`: the usage limits, "Usage limits" (issue #522)):
   - offline → `0`
   - `usedFrac < soft` → `maxLanes`
   - `usedFrac >= hard` → `0` (stop: close idle lanes, drain busy ones, start nothing)
   - between → `floor(maxLanes * (hard - usedFrac) / (hard - soft))` (linear scale-down)
3. **Router verdict per waiting job** (from `job.advice`), always applied (issue #211):
   - no advice yet → hold `awaiting router advice` (nothing starts before the router has
     spoken)
   - `approved` → proceed, whatever the advice (a human override ends every router hold)
   - `ask_human` → hold `router ask_human: awaiting approval`
   - `stop_retry` → hold `router stop_retry: …`
   - `reuse_cache` → hold `router reuse_cache: …`
   - `chat_only`, `run_deterministic` → proceed, priority `+ policy.routerCheapBoost`
   - anything else → proceed
   A `Divergence` is recorded for every job where the router verdict (start/hold or order)
   differs from the native one.
4. **Apply the verdict.** Admission and effective priority use the router verdict. There is no
   router mode: issue #211 removed `shadow` (advice recorded, never applied); what was `active`
   is the only behaviour.
5. **Native holds.** A job not yet accepted at the queue gate (`accepted: false`) → hold
   `awaiting acceptance`, before anything else is judged ("Queue gate"). No online machine runs the job's executor → hold. Pinned machine
   unknown or offline → hold. An ended job of the same item (`source.key`) whose cleanup is running or
   deferred (`DecisionInputs.cleanupDue`, "Deferred cleanup") → hold `job <id> of this item may still run: its
   cleanup waits for its machine (<error>)`, or `… is being cleaned up` while the first try runs.
6. **Order.** Admissible jobs by effective priority desc, then `createdAt` asc, then `id`.
7. **Assign.** For each job in order: candidate machines = online, run its executor, match
   its pin, `busy(m) + assigned(m) < cap(m)`; a job not pinned to `m` also needs
   `unpinned(m) < cap(m) - reservedLanes(m)` ("Reserved lanes", issue #372). Pick the one with the most
   **placement pressure** when reset-aware placement is on ("Usage pacing"), then the most remaining
   room for that job, then the lowest machine id. No candidate, and the job's priority at or above the
   **critical priority**: it may take one lane past its caps ("Usage pacing"). Use an existing idle, non-draining lane if one is unassigned, else
   `laneId: null` (a lane this Decision opens). No candidate → a **wait**, not a hold (issue
   #381): the job stays `queued` with a reason naming the lane cap that binds on the eligible
   machine with the highest cap for its executor — the executor's when it leaves less room than
   the machine's (or ties and is lower), else the machine's — with its number and lanes in use
   (`waiting for a lane: machine m's lane cap is N[ (usage soft limit, used P%)], all K in use` /
   `… executor e's lane cap on m is N …` / `… usage hard limit stops executor e on m (used P%)` /
   `… machine m keeps R of its N lanes for jobs pinned to it, the other K are in use`).
8. **Lane plan per machine.** `occupied` = lanes `busy` or `draining`. `target =
   min(cap + overCap, occupied + assigned)`, `overCap` the lane a critical job took over the cap in
   this Decision (0 or 1); from the next Decision on it is past the cap, so it drains when its job ends. `open` = number of this machine's starts with
   `laneId: null` — **invariant**, the engine opens lanes only for those starts.
   Idle lanes not assigned: kept while `occupied + assigned + kept < cap` and the lane has
   been idle less than `policy.laneIdleGraceMs` (from `idleSince` and `inputs.at`);
   otherwise closed. Always closed at cap 0. Drains `max(0, occupied - target -
   alreadyDraining)` **busy** lanes, newest first. `current` counts idle + busy + draining.
   Every plan carries a one-line `reason`.
9. **Reasons.** Plain sentences in the order reached. The Decision carries `inputs`
   verbatim.

**A no-op decision is not recorded.** The engine discards a Decision with no lane change,
no start, no hold whose reason differs from the job's current `holdReason`, and no wait on a job
not already `queued` with that `waitReason`. Otherwise
an idle tick every 2 s would bury the decision log. Every recorded Decision emits
`decision.made` with `{ decisionId, trigger, starts, holds, lanes, divergences, waits? }` (v3;
`waits` additive, issue #381).

### Usage pacing (issue #373)

Several accounts that each reset at their own time, each to be used close to 100% a week without
running dry early. Three parts, each its own setting, all in `DeciderPolicy.pacing`; the decider
stays pure — every time it compares is `inputs.at`.

- **Burn window** (`HOPPER_BURN_WINDOW_HOURS`, default 18; 0: off). The hard limit keeps a reserve
  (5% at 0.95) that is right for most of the week, but the reset throws it away. Within the burn
  window of a week window's `resetsAt`, that window does not throttle unless it is spent
  (`used >= limit`): steps 1-2 skip it (`burnPhase`, `src/decider/usage.ts`), and the Decision's
  reasons name it (`m: usage window week of s is in its burn window …: not throttling`). Session
  windows still apply. The usage report (`GET /api/usage`) reads the same clock, so a burning window
  shows as not throttling.
- **Reset-aware placement** (`HOPPER_RESET_AWARE_PLACEMENT`, default `true`). Step 7 picks the
  machine with the most placement pressure: headroom of the binding (most used) week window — to the
  hard limit, to 100% while it burns — per hour left before its reset. An account that resets in 11
  hours with 80% left goes before one that resets in 4 days. Ties, and machines with no week window
  that names its reset (pressure 0), fall back to most room, then id. The start reason gives the
  pressure. Trade-off: unpinned jobs may fill the machine with the most pressure, and a job pinned to
  it waits for a lane there; reserved lanes ("Reserved lanes", issue #372) keep lanes for it.
- **Critical priority** (`HOPPER_CRITICAL_PRIORITY`, default 100; 0: off). The hopper never
  preempts. A job at or above it that fits on no machine may take a lane past its caps — the
  machine's lane cap, its executor's, or the reserved lanes — on an eligible machine (online, its executor, its pin) at neither the machine's nor the executor's hard
  limit, and not past its cap already — at most one lane over it per machine. The start reason says
  `critical priority: one lane over the cap N` (or, inside the machine's cap, `… past the executor's
  lane cap or the reserved lanes`); step 8 counts a lane over the cap in `target`. From the next
  Decision on the machine is past its cap: no other job starts there, and step 8 drains a busy lane
  (the newest), which closes when its job ends.

Decisions stored before issue #373 carry no `pacing`: all three are off for them.

## The engine

- **Triggers:** interval tick (`HOPPER_TICK_MS`, default 2000) plus the events
  `job.queued`, `job.prioritized`, `job.reprioritized`, `job.respecified`, `job.approved`, `job.finished`,
  `job.failed`, `job.cancelled`, `question.asked`, `question.answered`,
  `question.expired`, and the queue gate's `job.accepted`, `job.rejected`, `queue.ordered`, `queue.gate_changed` (`TRIGGERS`, `src/engine/index.ts`). Decisions are serialized; triggers
  arriving mid-decision coalesce into one follow-up, which keeps the first waiting trigger's name
  (so `decision.trigger` names *a* cause, not necessarily the last). Event listeners schedule
  triggers with `setImmediate`; they never run a decision synchronously inside `append`. The tick
  is a safety net: every state change that frees a lane or adds work wakes a Decision itself.
- **A lane is held only by a running job** (issue #181). Before each Decision the engine frees every
  lane not idle whose job is not claimed or running on it — a draining one closes, any other goes
  idle (`freeStrandedLanes`, `src/engine/decision-step.ts`). A job that ended without its outcome
  freeing the lane (cancelled while no runner held it, a runner that stopped before recording)
  never leaves the lane shown running, or counted occupied, for good.
- **Parallel by default.** One Decision claims every admissible waiting job that has room: N free
  lanes and N admissible jobs → N claims in that Decision, N executors started at once (the
  runner never awaits one job before starting the next). A source sync ingests every new item in
  one pass, so they reach the same Decision; the source's claim report (label) runs off
  the decision path and never gates a start. A question frees its lane in the transaction that
  pauses the job; `question.asked` wakes the Decision that hands the lane to the next waiting job,
  while the answer pipeline runs. The only things that keep an admissible job waiting:
  - the **lane cap** — `maxLanes` per machine (the machine instance's `lanes` option, default 4), scaled down
    past the usage soft limit, 0 at the hard limit (a wait, `waiting for a lane: …`, not a hold);
  - the **router**: no advice yet, or advice that holds (`ask_human`, `stop_retry`,
    `reuse_cache`) — the router speaks first; an approval ends a router hold;
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
  reason changed. Waits: set `status: queued`, `waitReason` (clearing `holdReason`), no event —
  a job held for lanes before issue #381 returns to `queued` on the first Decision after it.
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
configured. Its advice is always applied: there is no router mode (issue #211).

- `gate-router`: spawns `<python> src/plugins/router/gate-router/gate_shim.py` with JSON on stdin, in
  its own process group (a timeout kills the group, so no `claude` outlives it) and with the Claude Code
  markers scrubbed from the environment. The shim puts the grok-bot-jev checkout (`jevPath`) on
  `sys.path`, loads Jev's **own** `config.yaml` (its kill switch is honoured), overrides only `mode`
  (hopper's) and `logging.path` (hopper's data dir), sets `PYTHONDONTWRITEBYTECODE=1`, calls
  `route_task(state)`, prints the result. Nothing is written under the checkout. `router.py` imports
  `typesafe_sdk` at module load (via `src.jev_client`); when that package is absent the shim installs
  a stub whose `Choice`/`Noul`/`Score` only record their instructions and criteria.
- **Jev gates: TypeSafe where it is set up, a Claude model for the rest** (owner decision, 2026-10-03,
  issue #19: keep Jev and TypeSafe; TypeSafe is better at some things; the Claude model through the
  existing Claude login, no new paid key). Jev's router runs unchanged; the shim replaces only the
  `system_one` it imported. The gates `JEV_GATES` (`shim.ts`: `intent`, `reuse_cache`, `stop_retry`:
  crisp classifications of the job state, where TypeSafe's calibrated probabilities feed Jev's
  thresholds) go to TypeSafe through Jev's own `jev_client.system_one` — when the user's TypeSafe API key
  is set (issue #657: on the Jev page, kept in the vault's system scope; read on **every** call) and
  `python` imports `typesafe_sdk`. Fixed, not a
  setting (issue #217): which gate goes where is the router's judgement, not something a person setting
  up the hopper knows. The key reaches only the shim's environment, where Jev's own `secrets.py` reads
  it. Every other gate (`needs_subagent`, `complexity`: judgement of how much work a goal implies), and
  every gate TypeSafe fails on, goes to the Claude model: one locked-down `claude -p --model <model>`
  run of the `claude` on PATH (`claudeArgv`, `claude-print.ts`; the same `claude` whose models the
  `model` select lists), prompt on stdin, output bound to a schema of TypeSafe's answer shapes, cwd =
  the data dir. The shim checks every gate is answered and every choice is a label Jev offered. Advice
  details gain `gatesBy` (gate → `jev` | `claude`) and, when Jev was wanted but could not answer,
  `jevError` (no key is not an error: Jev is simply off).
- Settings (issue #217: each a concept someone setting up the hopper knows): `jevPath` (where
  grok-bot-jev is checked out; no default), `python` (`python3`, the Python that runs Jev), `model`
  (`haiku`, the Claude model), `timeoutSeconds` (60: one Haiku run over all five gates took about 20 s
  on the hopper host, the CLI start included). `jevPath` and `python` are command-bearing. Tenant
  migration 6 moved the stored `grokBotJevSrc`, `claudeModel` and `timeoutMs` to these names and
  dropped the leftovers `claudeBin` and `jevGates`. `detect` needs `python`,
  `<jevPath>/src/router.py` and `claude` on PATH; its detail says whether Jev is on.
- Advice from a real router run has `source: "gate-router"`; `details.gatesAsked` mirrors the
  router's own `jev_used`. Any failure (the Claude model failing or leaving a gate unanswered,
  timeout, bad JSON) → advice `{ action: proceed_full, source: fallback, details: { gatesAsked: false },
  reason: "gate router unavailable: …" }` — the router's own documented safe fallback.
- Job → Jev state: `goal` ← `spec.goal`, `kind` ← `spec.kind`, plus `spec.meta` keys
  `cached_artifact`, `cached_note`, `prior_error`, `same_error_count`, `sources_found`,
  `constraints`.
- **Facts first, no model** (issue #628, `facts.ts`): before it spawns the shim, the gate router checks
  verdicts the job's own facts fix. In order: a non-empty `meta.cached_artifact` → `reuse_cache`; a
  non-empty `meta.prior_error` with `meta.same_error_count` ≥ `STOP_RETRY_SAME_ERRORS` (1) → `stop_retry`;
  none of the `META_KEYS` above in `spec.meta` (every GitHub issue job today: the gates would judge the goal
  alone) → `proceed_full`. Each is advice with `source: "gate-router"` and `details: { gatesAsked: false,
  decidedBy: "facts", rule }` (`rule`: `cached_artifact` | `same_error_count` | `no_meta_keys`), given at
  once, so the job waits no `timeoutSeconds` on "awaiting router advice". Any other job goes to the gates:
  Jev keeps `intent`.
- `fake` router (test double): deterministic, no network, mirrors grok-bot-jev's precedence from job
  metadata: bypass marker → `proceed_full` (gatesAsked false); `meta.cached_artifact` →
  `reuse_cache`; `meta.prior_error` and `same_error_count >= 1` → `stop_retry`; kind
  `lookup` → `run_deterministic`; `chat` → `chat_only`; `account` → `ask_human`;
  `meta.needs_subagent` → `allow_subagent`; `research`/`browser` → `research_capped`; else
  `proceed_full`.
- **No mode.** The router's advice is always applied (issue #211). Jev is told `mode: active`
  by the shim, since the hopper honours its advice.

## HTTP API

> **Superseded in part by Phase 3:** every `POST`/`PUT`/`DELETE` route in this table is
> removed (404); jobs come from job sources, mutations go through `/ui/api/*` behind a UI
> session. The `GET` routes stand. See "Phase 3 — the hopper pulls".

Loopback (`127.0.0.1`), plus the LAN names when set — "Reaching the UI across the LAN". JSON everywhere; errors are
`{ error: string }` with 400/404/409.

| method | path | body / query | returns |
|--------|------|--------------|---------|
| GET | `/api/health` | | `{ ok, version, router, fallback, executors, uptimeS }` (phase 5; no `routerMode` since issue #211) |
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
Domain events: `id: <seq>`, `event: <type>`, `data: <DomainEvent JSON>`. New usage samples (`usage.recorded`,
issue #502) and new machine samples (`machine.recorded`, issue #560), `data: { added }`, no `id`. Delivery updates
(not domain events, never persisted or webhooked, so a delivery cannot trigger a delivery):
`event: delivery.updated`, `data: <WebhookDelivery JSON>`, no `id`. Comment heartbeat
`: ping` every 15 s. A running job's own stream is another, `GET /job/stream` ("The job stream", issue #613).

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
deliveries survive a restart. The secret is the subscription's stored signing secret, opened at each
delivery, so a replaced or rotated one signs from the next ("Webhook signing secrets", issue #451); for a
subscription from before with none stored, the runtime variable its `secretEnv` names (or the mounted file
`<secretEnv>_FILE` names). None, or one that cannot be opened: nothing is sent, and the delivery retries
saying why.

## Construction contract

One factory per module. `src/main.ts` and the integration tests wire these; nothing else
constructs adapters.

```text
src/store/index.ts      openStore(o: { path: string; clock: Clock; idGen?: IdGen }): Store
src/webhooks/index.ts   createWebhookDispatcher(o: { store: Store; clock: Clock; baseMs: number;
                          timeoutMs?: number; maxAttempts?: number; sweepMs?: number }): WebhookDispatcher
src/plugins/index.ts    createPluginHost(o: { pluginDir; pluginsFile; dataDir; clock; logger;
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
| `job.respecified` | `{ from, to }` — issue #375, a waiting job that has not started takes the config as it is now |
| `job.cleanup_deferred` | `{ error }` — issue #371, its cleanup could not reach its machine; tried again every tick ("Deferred cleanup") |
| `job.cleaned_up` | `{ deferredAt, by? }` — issue #371, a deferred cleanup went through, or the user marked it closed (`by: "user"`) |
| `lane.opened` | `{}` |
| `lane.closed` | `{ reason }` — the lane plan's reason, `drained`, or `daemon restart` |
| `decision.made` | v3 `{ decisionId, trigger, starts, holds, lanes, divergences, waits? }` |
| `router.mode_changed` | retired (issue #211): nothing emits it; stored ones still read |

The usage-change trigger is named `usage.changed`; it is a trigger, not an event.

## Settled in the founding session (2026-10-02)

- **Jev is not a usage source.** It classifies one request; it knows no machines, lanes or
  budgets. It is the per-job admission and prioritization layer; budgets come from a
  `UsageSource`.
- **Jev advice is recorded for every job.** In shadow mode (removed by issue #211: a job now
  waits for its advice) a job could start, or finish, before Jev answered; the advice still lands on the job and in `job.prioritized`
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
| `HOPPER_JEV_MODE` | `shadow` (initial router mode only; the stored setting wins once set). *Removed with the router mode, issue #211.* |
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
| `src/questions/` | the question pipeline: `QuestionService` (the fixed answers (`fixed-answers.ts`, issue #629), Jev first (`jev-first.ts`), the escalation levels, lowest first → risk rules on an answer → auto-answer, issue #632 → accepted or human; timers, recovery; a person's correction of an auto-answer), risk rules, rules-file loader, the fake double at the `EscalationLevel` seam. The levels themselves are plugins (`src/plugins/`, issue #134) | engine internals, http, executors, plugins |

## herdr-claude executor

Job: `executor: "herdr-claude"`, payload
`{ prompt: string (required, non-empty), cwd?: string (absolute or ~; default config
HOPPER_CLAUDE_CWD), model?: string, expectedMs?: number, timeoutMs?: number }`.

**herdr session.** hopper owns the named session of the herdr-claude instance's `session` option
(default `hopper`), run headless by its own unit `hopper-herdr.service`
(`herdr --session hopper server`). Every herdr call is `herdr --session <s> …`, JSON on
stdout, errors JSON on stderr with exit 1. Never the default session — herdr's own doctrine
forbids driving a user's session from outside it. Spawned processes get an environment with
`CLAUDECODE` and every `CLAUDE_CODE_*` variable removed but the claude CLI's credential
`CLAUDE_CODE_OAUTH_TOKEN` (issue #533, "Startup screens").

**Lanes → panes.** One herdr workspace labelled `hopper` (found by label, else created
`--no-focus`). One **tab per job run**, created with `--cwd <job cwd>` and labelled
`<laneId> · <jobId first 8>`; its root pane hosts Claude. The executor keeps `laneId →
paneId` for the job now on that lane and saves `{ session, workspaceId, tabId, paneId,
agentName, cwd }` with `ctx.saveState` the moment the pane exists. A job in
`waiting_answer` keeps its pane (the waiting pane) while its lane is freed; on resume the lane it
is claimed onto maps to the waiting pane.

**Start.** `agent start jh-<jobId first 8> --kind claude --pane <pane> --timeout 60000 --
<claudeArgsFor(yolo, args)> [--model <payload.model>]`; the default instance is yolo
(`--dangerously-skip-permissions`, see **Yolo** below). **Readiness wait:** herdr refuses `agent start` until the new pane is at its shell
prompt, answering `agent_pane_busy` ("agent target pane … is not an available shell") when
it is sent a few ms after `tab create` — seen live with 4 jobs claimed at once. The CLI
client maps that code to `paneBusy`; the executor retries `agent start` every 100 ms on
exactly that code until the 60000 ms start deadline (`pane … never reached its shell prompt`). Any
other error fails at once, but herdr's own `timeout` ("timed out waiting for agent startup": Claude
never came up while herdr waited, issue #462).

**A start that times out is tried again** (issue #462, seen live with 16 lanes filling at once). The
pane's shell never ran the scratch command or never answered where it runs, it never reached its
prompt, herdr's agent start timed out, or Claude was not ready by the start deadline: nothing of the
job has run yet. The executor closes and reaps the pane, waits, and starts again in a new pane on the
same lane — credentials placed again, since the reap took the scratch dir — up to 3 starts in all. The
pauses are 10 s then 30 s, each longer by up to half at random, so lanes that filled at once do not
start again at once. Each retry is a progress message, `claude did not start (attempt n of 3), trying
again in a new pane in <s> s: <why>`, and the last failure is `claude did not start in 3 attempts:
<why>`; `<why>` ends with the pane's last 30 lines when the pane was read. A startup dialog the hopper
may not answer (asked of a person, "A dialog before the send"), an unusable work tree or a Windows shell is never tried again. **One pane per
lane:** the executor refuses to map a pane already held by another lane (job `failed`,
pane left untouched). `agent_not_ready` (blocked at startup): read the visible
screen; if it is Claude's folder-trust dialog (contains `trust this folder`) **and the
dialog names the job's cwd** and `HOPPER_TRUST_WORKDIR` is true → send `down enter`,
log it via progress message `trusted workdir <cwd>`, wait for `idle`. Another dialog of Claude's
blocking startup → a question to a person ("A dialog before the send"); a screen that shows none is looked at again ("Startup screens").

**Yolo** (issue #267). Whether Claude has every permission is the herdr-claude instance's own
option `yolo` (default on, command-bearing), never an argument in its `args`; it is picked like the
instance itself — two instances, one yolo and one not, and a routing rule or a job's executor picks
which one runs a job. `claudeArgsFor(yolo, args)` (`src/executors/herdr/start.ts`) builds the command:

- **yolo** — `--dangerously-skip-permissions --settings {"skipDangerousModePermissionPrompt":true}`
  then the other args. The setting is Claude Code's own "the bypass permissions warning was accepted";
  on the command line it holds in any config dir (the per-user ones of issue #158 never accepted it, so
  job panes sat on the warning). Args that name `--settings` of their own keep theirs, and the warning
  is answered on screen instead.
- **not yolo** — the args, minus every argument that would grant every permission
  (`--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode
  bypassPermissions`). Claude asks before it acts; each permission dialog pauses the job on a
  question (`detectedBy: blocked`, the dialog as its text), and the escalation levels or the
  owner answer it.

**Startup screens** (issue #533, `src/executors/herdr/startup.ts`, `startup-screens.ts`, `claude-config.ts`). Owner
requirement: a job never blocks on interactive input — on a container or any machine nobody watches, a key press
nobody can give stalled or failed it, and each new screen of Claude's was a new failure (#288, #518, #527). So startup
is non-interactive by construction, and "A dialog before the send" below is the guaranteed fallback.

*By construction.* Before `agent start`, with the instance **unattended** (option `unattended`, default on; set per
instance in Settings → Plugins, stored in the `plugins` config record and applied without a restart, as every executor
option is), the pane's own shell seeds Claude's config where the machine has none: `$CLAUDE_CONFIG_DIR/.claude.json`,
else `~/.claude.json`, written only when absent (noclobber, mode 600), never the user's existing one — onboarding done,
the dark theme, `autoUpdates: false`; with `trustWorkdir`, trust and the external imports approval for the work tree,
the directory Claude starts in and its git top (each by its real path, only the work tree or inside it; Claude keys
trust by a directory or one above it, the imports approval by the repository's top); with yolo,
`bypassPermissionsModeAccepted`; with `ANTHROPIC_API_KEY` in the pane's environment, that key approved (its last 20
characters, as Claude records it). It prints `hopper-claude-config-seeded`, `-kept` or `-unwritable`; whatever it says,
Claude starts. Unattended, the tab also gets `DISABLE_AUTOUPDATER=1`: Claude never updates itself in a job's pane. The
yolo warning is accepted by `--settings` ("Yolo"). The claude CLI's credential `CLAUDE_CODE_OAUTH_TOKEN` is the one
`CLAUDE_CODE_*` variable the scrubbed environment keeps (`src/executors/env.ts`): the herdr server, whose environment
every pane inherits, started without it, so a hopper in a container given it had Claude stop at its login screen; a
user added later never gets admin's (`userProcessEnv`). Checked live (Claude Code 2.1.292,
`test/herdr/real-fresh-home.test.ts`, opt-in `HOPPER_REAL_CLAUDE`): in an empty home, a job worktree whose work tree's
`CLAUDE.md` imports a file outside it reaches Claude's prompt with no key pressed.

*Up is Claude's input box* (`promptShown`: a rule, the `❯` line, a rule below), on screen for 2 s (`PROMPT_STEADY_MS`,
counted in polls: Claude draws it before it says it is not signed in). Never herdr's word alone: herdr calls Claude
`idle` and `interactive_ready` at its first-run theme picker (seen live), where the start before sent the job's prompt.

*Each screen before it is decided on by its text* (`startupStep`), never by `state_change_seq`: herdr's does not move
between Claude's startup dialogs (seen live: trust, imports and API key all at one seq, so a dialog after the first was
never judged). The screen just answered is not answered again until it changes; at most 8 are answered. Defaults:

| screen | how it is known | answered | when |
|---|---|---|---|
| folder trust naming the dir Claude starts in | `trust this folder`, `Accessing workspace:` that dir | `down enter` | `trustWorkdir` |
| external CLAUDE.md imports (issue #518: a job worktree lies inside the work tree, so the work tree's `CLAUDE.md` importing its `AGENTS.md` imports a file outside the job's cwd) | `Allow external CLAUDE.md file imports?` | `down enter` | `trustWorkdir` |
| bypass permissions warning (issue #267) | `running in Bypass Permissions mode` | `down enter` | yolo |
| first-run theme | `Choose the text style` | `enter` (its default) | unattended |
| the API key in Claude's environment | `Detected a custom API key` | `up enter` (Yes) | unattended |
| a notice | `Press Enter to continue` | `enter` | unattended |
| login method, or the prompt with `Not logged in · Run /login` | its text | — | never |
| anything else that asks (`asksSomething`: a dialog's cursor or key hints, a cursor on an option outside the input box, Press Enter) | — | — | never |

A screen the hopper may not answer — no default, or one the instance may not give (trust or imports without
`trustWorkdir`, the warning when not yolo, a first-run screen when not unattended) — leaves Claude up at it: the send
asks it of a person ("A dialog before the send"); with no credential the question says so first. **A screen that asks
nothing is not one** (issue #527): on a Windows machine every job failed "blocked", the screen the base64
`-EncodedCommand` of the launch line herdr's agent start typed; on a wsl one, the dependency-sharing command still on
screen. Such a screen — the launch or a setup command echoed, Claude still drawing — is looked at again at each poll;
with herdr calling Claude up and the screen unchanged for 5 s, Claude is taken as up (no input box found); else, after
120 s (`SETTLE_TIMEOUT_MS`, a Windows launch is slow), the start times out, `claude not ready at startup: <screen>`, and
is tried again in a new pane. The screen is not cleared before the launch: herdr's agent start types the launch line
after anything the hopper could clear. **No marker is in the command that prints it** (issues #518, #527): each command
typed into a pane builds the marker it is waited on for when it runs (`printf 'hopper-%s-%s' …`), so the echo of the
command never answers herdr's `wait-output`; `test/herdr/markers-not-echoed.test.ts` checks every one.

Not covered by the seed: Claude on a Windows client keys its projects by Windows paths, which the POSIX shell's `pwd -P`
does not give, so there its trust and imports dialogs are answered on screen; a home where Claude ran but never
finished onboarding keeps its config, and its theme picker is answered on screen. zsh's own new-user menu in an empty
home eats the first command typed; the scratch command is typed again until it runs.

**The other agents** (issues #295, #307) run in print mode, where no screen is shown: stdin `/dev/null`, so a CLI that
would ask reads end of file and fails with its own error. Their default `args` skip their prompts (codex
`--dangerously-bypass-approvals-and-sandbox`, cursor-agent `--force --trust`, opencode `--auto`, omp `--auto-approve`).
Claude Code itself can run so too: the `claude` print-mode executor ("Print-mode agent executors").

**A dialog before the send** (issue #534, `src/executors/herdr/before-send.ts`). A dialog is never a failure.
Seen live: the trust dialog answered, Claude up, then a dialog of its own before the prompt went; the send
pressed `esc`, herdr refused the prompt (`agent is blocked and requires interactive input`), the job failed
and its pane was torn down, so there was nothing left to answer. Now, whenever Claude stands at a dialog
before the hopper's text reached it — after startup, at the first send of a run or of a reopened parked job,
or when herdr refuses a prompt with `agent_blocked` — the executor sends no `esc`. Standing at a dialog is herdr
calling Claude blocked, or its screen showing one before its prompt (`standsBeforePrompt`, issue #533: herdr calls
Claude idle at its first-run screens, and Claude not signed in shows its prompt with `Not logged in`). It looks again
for up to 10 polls, answering a screen it has a default for, by its text ("Startup screens"); one still standing is
the job's question (`detectedBy: blocked`), the dialog its text, with its options — prefixed, when Claude has no
credential, by "Claude is not signed in on this machine". The
job goes `waiting_answer` and keeps its pane; the question climbs the levels to a person as any other. The
turn is saved **unsent** (`TurnAnchor.unsent`, its `text` the prompt): on `resume` the answer goes into the
dialog — the option it names, by number or by its words; at a dialog without options, the answer and Enter;
at a dialog with options that names none, the question again, saying so, nothing typed (Enter would pick
whichever option has the cursor, often the one that quits); at Claude's prompt (it was not signed in) nothing is
typed, or the answer would be Claude's first message — then the text is sent, a new turn, once Claude is past it. Answered
straight in the pane, Claude past the dialog is the answer, and the reattach sends the text. Claude's
startup dialogs are selects without numbers (`❯ No, exit` / `Yes, I trust this folder`):
`select-dialog.ts` reads one as a question with its options numbered from 1, and picks the option an answer
names with arrow keys from the cursor, then Enter; a select without key hints either (the theme picker) is read by
`startup-screens.ts` `cursorPick`. Known safe startup screens answered up front by the launch itself ("Startup
screens", issue #533) appear less often; this is the fallback when one appears all the same.

**Answering a dialog.** On `resume`, when Claude still waits at a dialog and the answer names one
of its options — its number, or its own words, case and spacing aside (`dialogOption` in
`screen.ts`: the options around the last `❯ N.` line, so a numbered list in the transcript is not a
dialog) — the executor types that digit and watches the waiting turn go on (its anchor kept, no new
prompt). Any other answer dismisses the dialog with `esc` and is typed to Claude as text, as before.

**Migration** (tenant migration 9, `src/store/migration-yolo.ts`). A herdr-claude instance in the
`plugins` config record whose `args` granted every permission gets `yolo: true` and loses those
args; one whose args did not gets `yolo: false`, so it keeps asking. One with no args (the old
default was yolo) or already naming `yolo` is left as it is.

**Work tree** (issue #121). A job's **work tree** is its cwd: all of its coding work happens
under it — clones, git worktrees, builds, scratch and temporary files — never in a copy
outside it (`/tmp` or anywhere else). Opening the pane there is not enough on its own: Claude
Code's scratchpad lives under `/tmp` by default and its system prompt sends temp files there,
which is how a job drifted out of its tree. So the hopper directs it three ways:

- **Environment.** The tab gets `CLAUDE_CODE_TMPDIR` and `TMPDIR` = `/tmp/hopper-<job id>`, the
  job's **temp link** to its **scratch dir** `<cwd>/.hopper-scratch/<job id>`: Claude's scratchpad and
  every tool's temp files land inside the tree, in a directory that is the job's alone (issue #401), so
  the reap can remove it. The payload cannot move them. Not the scratch dir's own path (issue #506): a
  Unix socket path takes at most 108 bytes, tools bind sockets under `TMPDIR`, and Chromium's
  `org.chromium.Chromium.XXXXXX/SingletonSocket` alone takes 45 — under a real work tree Chromium
  aborted at startup in every job. `/tmp/hopper-` and a UUID job id take 48. (The print agents get the
  same link as their `TMPDIR`, issue #410.) It also gets `CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT=1` (issue #376): Claude
  Code would deny a dangerous-rm dialog by itself after two minutes, before the question can climb to
  the owner. A payload cannot turn the countdown back on.
- **The scratch dirs ignore themselves.** Before `agent start`, the pane's own shell runs
  `[mkdir -p <cwd> && ]cd <cwd> && mkdir -p <scratch> && printf '*\n' > <cwd>/.hopper-scratch/.gitignore && ln -sfn <scratch> <temp link> && [ "$(readlink <temp link>)" = <scratch> ] && printf 'hopper-scratch-%s\n' ready || printf 'hopper-scratch-%s\n' unusable`
  (`pane run`; the `mkdir` for the machine's work tree, never for a routing rule's: issue #361) — in the pane, so on whichever machine the work tree is. A fresh shell drops what
  is typed before its prompt (seen live), so the executor waits up to 1000 ms for
  `hopper-scratch-ready` in the pane's output (`pane wait-output`) and runs the command again,
  until the 60000 ms start deadline, then fails the job (`pane … never ran the scratch dir
  command`). Nothing is written to a repository's own `.gitignore`.
- **A work tree the machine cannot use fails the job at once** (issue #323). herdr opens a tab
  whose cwd does not exist in the user's home instead, silently (herdr 0.8.2), so `tab create` says
  nothing; the `cd` does. When the shell cannot enter the work tree or make the scratch dir, it
  or the temp link there is not the job's (another user's, or a directory), prints `hopper-scratch-unusable`; the executor reads the pane after each wait, and fails the job
  with what the shell said (`the work tree <cwd> is not usable on <machine>: …`), the pane closed,
  instead of retrying for 60000 ms.
- **The pane's shell must be POSIX** (issue #367). Every command the hopper types into a pane (the
  scratch command, the job worktree command, the reap) is POSIX shell. herdr opens a pane in the
  machine's default shell, and has no option to pick one per tab (herdr 0.8.2); on Windows that is
  PowerShell, which refuses `&&` (5.1) and has no `printf`, so the scratch marker never showed and
  every job there waited 60000 ms. The executor reads the pane after each wait, and when it shows a
  PowerShell or cmd prompt (`windowsShellOf`, `screen.ts`) fails the job at once: `the shell of pane
  <pane> on <machine> is PowerShell, and the hopper needs a POSIX shell …`, the pane closed. The
  hopper does not translate its commands per shell: the fix is on the machine, a POSIX shell as herdr's
  default for the hopper's session (README "A Windows computer").
- **`~` is the job's machine's home** (issue #323). Config keeps `~` as written (a machine's
  `workTree`, a routing rule's `workTree`: issue #361), and the executor resolves it
  when the job starts, against the home of the lane's machine: this process's for this machine, and
  for an attached one the home its probe found (`MachineSnapshot.home`: an ssh target's
  `printf '%s\n' "$HOME"` over ssh, a client target's `homedir()` in its `/release` answer). A hopper
  in a container has a home of its own that does not exist on the host; resolving `~` there sent
  every job to it. A client on Windows answers a drive-letter home (`C:\Users\<user>`): the hopper
  keeps it with `/` for `\` (`C:/Users/<user>`), so `~/hopper-jobs` resolves to `C:/Users/<user>/hopper-jobs`,
  a path Windows takes; any other home that is not absolute is no home (issue #365). An ssh or client
  target whose home is not known yet (no probe answered, or a client release older than this) takes no
  job: the decider leaves it out of placement, and holds a job when every machine that runs its executor
  is such a machine (`no machine that runs executor <x> has its home known yet: …`) or the job is pinned
  to one (issue #365: a burst of jobs once failed on one at once). The executor still fails a job under
  `~` at once if one gets there; an absolute work tree needs no home.
- **0 lanes rests a machine** (issue #365). An attached machine's `lanes` may be 0: it stays a machine —
  a client target still dials in and shows online — and the decider gives it no job. Adding a machine
  and the machine defaults still take at least 1.
- **Never the home** (issue #314). A job never runs with its machine's home as its work tree. The
  executor (herdr-claude and cursor-agent, in `workTreeOn`) resolves the work tree on the lane's
  machine, normalised (`~/..`, a trailing slash), and fails the job at once, before any tab or agent
  starts, when it is that home, above it, or `/`
  (`the work tree <cwd> on <machine> is its home or above it: …`). A machine whose home is not known
  yet still refuses `/`. The default work tree is the **jobs directory** `~/hopper-jobs`
  (`JOBS_DIR`, `src/domain/types.ts`): a machine's work tree when it names none (issue #361; tenant
  migration 11 had moved a stored `~` to it). A machine's work tree is made when missing — the
  scratch command starts `mkdir -p <cwd> &&` — and one that cannot be made fails as above (#323); a
  routing rule's is a directory named on purpose, never made. Which work
  tree applies is "Per-machine work trees" (issue #361). This is direction plus refusal, not a
  sandbox: an agent can still write where its OS user can ("Sandboxing jobs: mechanisms compared").
- **The prompt says so.** The footer's work-tree line names the cwd and the scratch dir, and
  tells the job to ask rather than work in a tree outside it. It sends clones and git worktrees
  made only for this job to the scratch dir, and says the reap below removes it.
- **The job's scope** (issue #410, `src/executors/herdr/job-scope.ts`). The reap below first found a
  job's processes only by `HOPPER_JOB_ID` in their environment, and whatever replaced or cleared its
  environment and left its session escaped it: 46 such processes were found on one machine, each in a
  session of its own under the user's systemd. So after the scratch command, where the machine runs a
  systemd user manager (a trial `systemd-run --user --scope -- true` succeeds), the pane's shell replaces
  itself: `exec systemd-run --user --scope --quiet --collect --unit=hopper-job-<job id> -p
  KillMode=control-group -p TimeoutStopSec=10s -- "${SHELL:-/bin/sh}" -l`, keeping its directory and
  environment. Every process the job starts is then in that scope's cgroup, whatever it does to its
  environment or session. The new shell drops what is typed before its prompt, so the executor asks it
  where it runs (`/proc/self/cgroup`) until it answers (`hopper-scope-entered`; the pane state records
  `scope`). Without systemd (a container, macOS) it prints `hopper-scope-none` and the job goes on
  without a scope; a shell that never answers within 60000 ms fails the job, pane closed.
- **The reap** (issues #401, #410; the script in `src/client/server.ts`, run by
  `src/executors/machine-shell.ts`). A job left processes and copies behind: dev servers and watchers
  started with `&` or `setsid` outlive the pane (herdr's close hangs up only the pane's own session),
  and every job's clone and `npm install` stayed on disk. On one machine that filled the home and left
  dozens of processes in deleted work trees. So when a job's pane closes — every terminal outcome, a
  cancel, a timeout, a reclaim at restart — the executor sends `esc`, `ctrl+c` twice, gives Claude up to
  5000 ms to exit by itself, and then reaps the job **through the machine's own connection, never as keys
  to the pane**: this machine runs the script itself, an ssh target over the hopper's ssh connection, a
  client target in its client (`POST /reap {jobId, scratch}`, "Client targets"). So a job is reaped
  though Claude is still in front of its pane, and though the pane is gone (a crashed hopper, a lost
  pane). The script, on whichever machine the job ran:
  1. stops the job's scope, `systemctl --user stop hopper-job-<job id>.scope`, which kills every process
     in it and waits up to 10 s (`TimeoutStopSec`);
  2. then every process whose environment still carries the job's `HOPPER_JOB_ID` gets `SIGTERM`, then
     `SIGKILL` after 3 s — the fallback where there is no systemd. The script runs with the variable
     unset, so it never matches itself. Linux only (`/proc`); elsewhere this step is skipped.
  3. removes the job's scratch dir — only a path that is `…/.hopper-scratch/<job id>` — unless a
     repository in it (`.git`, outside `node_modules`) has uncommitted changes (a `node_modules` link to
     shared dependencies aside), or commits no remote has (a worktree: its `HEAD`; a clone: `HEAD` and
     every branch). Then nothing is removed and each such repository is printed; a pushed git worktree
     of a repository outside is removed through `git worktree remove`, never with `--force` (its
     `node_modules` link removed first), so its repository keeps no stale entry.
  It also prints each repository whose `HEAD` holds a remote branch the default branch (`origin/HEAD`) does not,
  `hopper-pushed <path>` (issue #630): the job pushed work. Asked with `keep` (`POST /reap {jobId, scratch, keep}`;
  a timed-out job's, issue #630), it says what is there and removes nothing but the job's credentials: the scratch
  dir stays, as a parked job's, so the job may go on there; its cleanup keeps it too (the job carries `liveness`),
  and the sweep removes it as any ended job's once `scratchMaxAgeHours` old. A client of an older release ignores
  `keep` and reaps as before. It prints `hopper-reaped` last. What it kept is never removed silently: `cleanup` answers it
  (`Executor.cleanup` → `Reaped`), and the engine records `job.work_kept { paths }` on the job; the
  sweep below tries it again. A machine the reap cannot reach leaves the job to the sweep.
  `HOPPER_KEEP_PANES` skips the reap with the close. A container a job starts with rootless podman runs
  in a scope of podman's own and outlives the reap, but its monitor (`conmon`) carries the job's id and
  stays in the job's scope, so it is stopped: the container goes on unmonitored (no restart policy, no
  `--rm`). A service meant to outlive the job is started outside it, e.g. `env -u HOPPER_JOB_ID
  systemd-run --user …`, or through a socket's daemon (`docker compose` against a podman socket).
- **The sweep** (issue #410, `src/engine/sweep.ts`). The reap runs when a pane closes; a hopper that
  crashed, a lost pane, a machine that rebooted or could not be reached left nothing to run it. So at
  startup, after recovery and the reap of each job it ended, and then on each machine every
  `reapEveryMinutes` (a `local`, `ssh` and `client` machine option, default 10; checked every minute, read
  at each sweep), the engine asks the machine — through the first of its executors that reaches it,
  `Executor.machineShell` — what jobs left there (the survey: the `hopper-job-*` scopes, the
  `HOPPER_JOB_ID`s of its processes, and the scratch dirs under the work trees of the newest 2000 jobs, with
  their ages; a client target's `POST /survey {roots}`), and reaps:
  - the scope and processes of every job the hopper knows that is not live (live: claimed, running,
    waiting on an answer, or led by an operator);
  - an ended job's scratch dir once it is `scratchMaxAgeHours` old (a machine option, default 24), or at
    once while its work was kept (`job.work_kept`), with the reap's rule: work not pushed is never
    removed. Work kept that the sweep then removes is recorded as `job.work_removed { paths }`; work it
    keeps the first time, as `job.work_kept`.
  A job id the hopper does not know is never touched: it may be another hopper's, or a test's. A machine
  offline at startup is swept once it is online. Each reap is one log line.
- **Each job its own git worktree** (issue #379). One work tree serves every job given it, so jobs
  running at once in one repository stepped on each other — branches, the index lock, uncommitted
  files, builds; seen live with four jobs in one repository on one machine, and a job-rules line asking
  each agent to make its own worktree was followed by some and not others. With the herdr-claude
  option `jobWorktrees` (default on), after the scratch command the pane's shell runs
  `makeJobWorktreeCommand` (`src/executors/herdr/job-worktree.ts`): when the work tree is the top of a
  git repository (`git rev-parse --show-toplevel` is the shell's `pwd -P`; a directory inside a
  repository, such as a home kept in git, is not), it fetches (`GIT_TERMINAL_PROMPT=0`, a failure
  ignored), runs `git worktree prune`, makes the **job worktree**
  `<work tree>/.hopper-scratch/<job id>/<work tree's name>` with `git worktree add --detach` at
  `refs/remotes/origin/HEAD`, else the current branch's upstream, else `HEAD`, enters it, and prints
  `hopper-job-worktree-made` (waited for up to 10 minutes, for the fetch or a first clone). A worktree an earlier run of
  the job left is entered as it is, nothing fetched. The command is one line that prints
  `hopper-worktree-running` first (issue #518): a zsh whose start-up files were busy lost or mangled the
  command of many lines typed into it, so the hopper waits 10 s for that line and, when it never shows,
  clears the line (`ctrl+c`) and types the command again, 3 times at most; a shell that never runs it times
  the start out (tried again in a new pane: "A start that times out is tried again"). Every wait for a line the pane prints — the
  scratch command's, the worktree's, the dependencies' — reads the screen and runs to the hopper's own
  deadline by its clock: on two machines herdr's `pane wait-output` answered within seconds while the
  worktree was still being made, so its answer only says when to look. The outcome is read wherever it
  stands on its line. Claude starts there; the pane state keeps the work tree as `cwd`
  (the reap's scratch dir follows from it) and the job worktree as `jobWorktree`; the job reports the
  job worktree (`job.workTree`, so the lane shows it), the trust dialog naming it is accepted, and the
  footer adds the fixed `[hopper job worktree]` line after the work-tree line: work there, it is the
  job's alone, the work tree is shared and left as it is. Not a repository's top, and the job has a repository (a GitHub issue's,
  issue #361): the command first fetches its **checkout** `<work tree>/<name>`, or clones it there from
  `https://github.com/<owner/name>.git` the first time, then makes the job worktree
  `<work tree>/.hopper-scratch/<job id>/<name>` of the checkout the same way, enters it and prints
  `hopper-job-worktree-checkout`; the pane state keeps the checkout as `checkout`, and the footer names
  it as what the worktree is of. Neither: `hopper-job-worktree-none`, and the job runs in its work tree. Git refusing:
  `hopper-job-worktree-unmade`, the job fails at once with what git said, pane closed. The worktree
  ends with the job through the reap: in the scratch dir, it is removed with it (`git worktree
  remove`, so the repository keeps no entry) unless it holds uncommitted or unpushed work, which is
  kept and recorded as `job.work_kept`. The footer's line also says to make no other clone or worktree
  of the work tree for the job (issue #410). Print-mode agent executors and the command executor make no
  job worktree: jobs there that share a work tree share it.
- **Shared dependencies** (issue #410, `src/executors/herdr/shared-deps.ts`). Each job ran its own `npm
  ci`, about 400 MB, for as long as it ran. With the herdr-claude option `sharedDependencies` (default on),
  after the job worktree is made its pane's shell links the worktree's `node_modules` to the dependencies
  installed for its lockfile, `<work tree>/.hopper-scratch/deps/<git hash of package-lock.json>/node_modules`.
  When no job has installed them yet, the first runs `npm ci --prefer-offline` in its worktree and moves
  the result into place, under a lock per work tree (`flock`), so jobs at once with one lockfile install
  once and the others wait and link. A new lockfile gets an entry of its own, so dependencies in use never
  change under a job. An entry no job worktree links to, unused for the machine's `scratchMaxAgeHours`, is
  removed by the next job that shares. Outcomes (`hopper-deps-…`, waited for up to 15 minutes): `linked`,
  `installed`, `own` (npm workspaces link into the repository: an install of the job's own), `kept` (the
  worktree already has `node_modules`: a run before), `none` (no `package-lock.json`, or no npm), `failed`
  (the job goes on and installs as it needs). Linked or installed, the footer's job worktree line says
  `node_modules` is a link to dependencies shared with the repository's other jobs, read-only, and to
  replace it with an install of the job's own (`rm node_modules && npm ci`) before changing dependencies.
  The reap removes the link, never what it points to. Not done: a worktree per issue reused across runs
  (`worktrees/<repo>-<issue>`, a `hopper/<issue>` branch); the job worktree of issue #379 stays the job's
  own, in its scratch dir.

Running or installing what a job built, and reading files elsewhere, stays allowed: the rule is
about where the work is done, not what is touched.

**Prompt, once.** `agent prompt <agent> <prompt + protocol footer>` (no `--wait`). Footer, with the
default job rules (the first five lines; "Job rules", issue #172):

```
[hopper publishing rule] Any text you send to GitHub (commit messages, branch names, pull request titles and bodies, issue text) describes the change and how it was verified, in neutral terms. Never quote or name the repository owner or any other person. Never include personal or machine details: email addresses, people's names, IP addresses, hostnames, tailnet names, home directory paths, usernames, machine or pane ids, port numbers of local machines, codes, tokens or secrets.
[hopper parallel work] Other jobs run at the same time as this one, possibly in the same repos. Nothing orders or holds jobs for each other: no job waits for another.
If your work overlaps another job's, sort it out yourself. Either state the assumptions you made about the other work, or make the needed fix in the other project and annotate it with which way the dependency runs (which work depends on which).
[hopper writing style] Write all text for people in Simplified Technical English (ASD-STE100): short sentences, one instruction per sentence, active voice, simple common words, one meaning per word.
[hopper formatting] Format the text you write for a person in the hopper (a question, a research report, a proposal, a note) in Markdown: a short summary first, then sections and lists. Put names, paths and commands in code spans. Do not use raw HTML or images.
[hopper work tree] This job's work tree is <cwd>. Do all of the job's work inside it: clones, git worktrees, edits, builds, test runs, scratch and temporary files go under it. Never make or work in a copy of the code outside it, under /tmp or anywhere else. Temporary files go in <cwd>/.hopper-scratch: git ignores it, and TMPDIR and your scratchpad point there. Running or installing what you built, and reading files elsewhere, is fine. If the job seems to need a work tree outside this one, ask instead.
[hopper protocol] When you need an answer from the user, ask exactly one question, in Simplified Technical English (ASD-STE100), in Markdown: one short sentence that says what you need first, then the context, with the options as a numbered list. End your message with a line containing only: HOPPER_QUESTION
If your question needs research or a proposal before it can be answered, say so on a line of its own before HOPPER_QUESTION: "Suggest: research — <the aspect>" or "Suggest: proposal — <the aspect>". A person decides.
When you are asked to research, do not do the work: research, then write a research report in Simplified Technical English (ASD-STE100), each part on a line of its own starting with its label — Question:, Findings:, Sources and evidence:, Confidence:, Open threads:, Next step: —. Write each part in Markdown, with a short summary first, then lists, code spans and links where they help. End your message with a line containing only: HOPPER_RESEARCH_REPORT. A person accepts it, asks you to dig deeper, or steers you; you keep your session meanwhile.
When you are asked for a proposal, do not do the work: write the proposal in Simplified Technical English (ASD-STE100), as Markdown, as a set of alternative paths. Start with TL;DR: (one or two sentences) and Problem: (a short problem statement). Then write each path as a heading "Path N: <title>" with these lines: Summary:, Security:, Effort:, Risk:, Friction: (for the person), Creates: (the jobs, issues or research that continuing with it creates), and more detail in Markdown if needed. Then Recommended: the number of the path, or the numbers of a combination, and why in one or two sentences. If no change is needed or no viable path was found, write Paths: none — and the reason. End with Context: (what you read and relied on). Write each part in Markdown, with a short summary first, then lists, code spans and links where they help. End your message with a line containing only: HOPPER_PROPOSAL. A person selects one or more paths to continue with; you are told the decision, or what to change.
When a command waits for a login (it shows a code to enter at a URL), never ask a question about it: leave the command running in the background, and end your message with a line containing only HOPPER_AUTH_PENDING, then one line each: tool: <the command>, url: <the URL>, code: <the code>, expires_in: <seconds until the code expires>. The user completes the login; then the command goes on and you continue.
When the job is blocked on something only a person or the outside world can do (access to be granted, a review, a release), and you have nothing else to do, end your message with a line containing only HOPPER_WAITING, then one line: for: <what you wait for>, and, if you can, one line: until: <how you will know it happened>. To be woken when it happens, first start a command in the background that ends when it happens (a poll), and name it in until:. While you wait, the hopper does not prompt you; a person can also end the wait. Never open a question only to wait.
When the job is completely finished, end your final message with a line containing only: HOPPER_DONE
If the job cannot be done, end with a line containing only: HOPPER_FAILED followed by the reason.
```

The job rules lead the footer so every job gets them, whatever its source; the work-tree line
follows with the job's own cwd (`protocolFooter(cwd, jobRules)`); the last line stays the turn
anchor. The default names no comment path: jobs never write to issues.

**Monitor** every `HOPPER_HERDR_POLL_MS` (1000): `agent get` (status, `state_change_seq`)
and `agent read --source recent-unwrapped --lines 200`.

**Turn anchor (B1).** At every send record `{ seq: state_change_seq, anchor, text }` (saved in
`job.executorState.turn` with `blockedAtSend`, before the prompt, so a restarted daemon can
watch the same turn) where
`anchor` is the last line of what was sent as Claude echoes it — the footer's last line
(`If the job cannot be done, …`) on the first turn, the answer's last line on a resume.
Only output lines **after the last occurrence of the anchor** count. **Every** outcome
below except `blocked`, agent gone and timeout requires status `idle`/`done` **and**
`state_change_seq` greater than at send — or, **stalled** (issue #278), Claude waiting (`idle`, `done`
or `blocked`) with `state_change_seq` unmoved since the send for `idleNudgeMs`: herdr never said the
turn moved, yet nothing works on it, and a job must never stay running on a waiting Claude. Marker normalisation: strip the Claude Code gutter
(`●`, `⎿`), whitespace, and surrounding `` ` `` / `*`; `HOPPER_DONE` and
`HOPPER_QUESTION` must then equal the whole line; `HOPPER_FAILED` is a prefix match
(after the anchor only). Parser tests cover: a wrapped echoed footer, the previous turn's
marker still on screen, a marker in backticks or bold. Then:

| observed | outcome |
|----------|---------|
| marker line `HOPPER_DONE` is the last marker (whole line, trimmed) and status idle/done | `finished`, result `{ summary: <assistant text of the final turn, ≤ 4000 chars>, paneId }`; a block that opens with a tool call (`● Bash(…)`) is the text after the call's output, never the call (issue #377) |
| last marker `HOPPER_FAILED` | `failed`, error = text after the marker on that line or the next line |
| last marker `HOPPER_QUESTION` | `question`, `detectedBy: marker`, text = the assistant message before the marker |
| last marker `HOPPER_AUTH_PENDING`, nothing after it but its field lines (`tool:`, `url:`, `code:`, `expires_in:`; also `kind:`, `expires_at:`, `interval:`) | a **login** ("Logins", issue #476): no question, no nudge. Reported to the logins; the job stays running and waits, as on background work, until Claude goes on by itself (the login then `completed`), the user acts on it, it expires, or `timeoutMs`. A login the logins cannot take (no code, no URL) is said back to the job, three times at most, then the job fails. Field lines are never progress; output after them means the job went on, and the marker no longer counts |
| last marker `HOPPER_WAITING`, then a `for:` line (and an `until:` line) | the job's **own wait** ("A job's own wait", issue #483): outcome `wait`, no question, no nudge. The job is `waiting_on`, its lane free, its pane kept. The turn's output lines then are saved as `turn.markersAfter`: when Claude goes on by itself in the same turn, that marker no longer counts. Without a `for:` line the marker is no wait (a status note) |
| status `blocked` (question/approval UI) | `question`, `detectedBy: blocked`, text = the dialog alone (`dialogText` in `screen.ts`, issue #377): from its border, or the ● line above it, to its options — title, what it is about, warnings, countdown, options; gutter, box edges, cursor and key hints removed. Earlier tool output above it is not the question: it is in `recentOutput`. No dialog found: the last 30 visible lines |
| idle/done with no marker after the anchor for `idleNudgeMs` (20000), and no background work in the footer | **status note** (issue #163): no question, no outcome. The executor types `STATUS_NOTE_NUDGE` into the pane as the next turn of the same job (anchor = the nudge, same `timeoutMs` clock) and watches again. Further status notes in a row wait 1, 5, 15 and 30 minutes idle before their nudge (`NUDGE_GAPS_MS`, `nudge.ts`, issue #491); the one after that gets none: progress `waiting: N status notes in a row without a marker; no more nudges until claude works again`, and the watch goes on until Claude works again by itself (a background notification, a person in its pane), which begins a new row, or `timeoutMs`. Before each nudge, the check before a nudge (issue #627): work over at the source ends the job done; a person awaited means no nudge |
| idle/done with no marker, and the footer under the input box names background work (`backgroundWork`, `screen.ts`: `· 1 shell ·`, `background task`, `monitor`, `agent`) | no status note, no nudge (issue #491): Claude Code wakes the job when that work ends. Progress once: `waiting on background work (1 shell): no nudge while it runs`. When the footer no longer names it and Claude stays idle, the status note timer starts |
| stalled, and the anchor nowhere on screen or text unsent in the input box | **lost send** (issue #278): what was sent never reached Claude (seen live: Claude sat idle, the job running, across daemon restarts; once the pasted prompt sat in the input box as `[Pasted text #1 +29 lines]`, its Enter lost). Text in the input box (`inputBoxText`, a `Try "…"` suggestion aside) is submitted with `enter`, progress `the prompt sat unsent in claude's input: submitted it`, never pasted twice; else the executor sends the same text again (`turn.text`, saved with the turn), progress `the prompt never reached claude: sent it again`; after 3 sends in all, or for a turn saved without its text, `failed` `the prompt never reached claude …` with the screen |
| stalled at a dialog (a picked option that never landed) | `question`, `detectedBy: blocked`, as above |
| agent gone (`agent get` error / pane closed) | `failed`, `claude exited` + last output |
| `timeoutMs` (default 3600000) exceeded | interrupt, `failed` `timed out` |

Marker matching: a line equal to the marker after trimming whitespace and the `●`/`⎿`
gutter. The prompt echo contains the markers mid-line only, never as a whole line.
Progress: on change of the last non-empty assistant line, `ctx.progress(min(0.9,
elapsed / expectedMs), line)` (`expectedMs` default 600000).

**Stopped on a question.** When a turn stops on a question (any `question` outcome) the monitor saves
`parkedSeq` = the `state_change_seq` it saw, for `answeredInPane` ("Questions" → "Answered in
the pane"). The next send drops it.

**Resume** (`resume(ctx, answer)`): `agent get` the saved agent; gone → `failed` `pane lost`.
If `blocked` → `send-keys esc` first. `agent prompt <agent> <answer>`; then the same monitor.

**Cancel** (`ctx.signal`, reason `'cancel'`): `send-keys esc`, then `ctrl+c` twice, then
`pane close`; outcome `failed` `aborted`. **Shutdown** (reason `'shutdown'`): return
`failed` `shutdown` at once, pane untouched (the engine discards outcomes during shutdown).
**cleanup(job)**: same exit-and-close from `job.executorState`; idempotent. Rejects only when the
pane may still be open: its herdr not reached (a client target not dialled in, ssh failing), or
`pane close` refused for any reason but `pane_not_found` (a pane already gone resolves). The engine
then defers it ("Deferred cleanup").
The executor is `idempotent: false`. `timeoutMs` and the `expectedMs` progress clock apply
per `run`/`resume` call; time spent waiting for an answer does not count.

## Questions

Lifecycle: executor returns `question` → engine, in one tx: question created (`open`, `tier` =
`QuestionService.firstStage()`: the first escalation level's instance name, or `human` with none),
job `waiting_answer` + `questionId`, `resumeOn` = its machine, lane idle (or closed if
draining), events `question.asked`.

**The raising machine (issue #485).** The question records where it was asked as `raisedBy`
(`{ machineId, name?, laneId? }`, `src/domain/raised-by.ts`): the asking lane's machine, else the job's
`resumeOn`, else its pin, with the machine's label from the lane's snapshot as the job ran. A snapshot:
nothing updates it, so it stays right after the job resumes elsewhere or the machine is renamed or
removed. Every `question.*` event carries it — the `machineId` subject (`laneId` where known) and
`raisedBy` in its data, an additive field that keeps each type's version — from `ask()` and the question
service's one `emit()`, so the event log holds it for every step of the question. Webhooks send the stored event, so
receivers get it as is; the Grok Bot routine body takes `machineId`, `machineName` and `laneId` from it, not
from where the job is at send time. The UI names it on the question card, the question history, event
lines and Attention, and says *machine unknown* when a question has none. Tenant migration 20 fills it on
older questions from the `question.asked` lane, then `resumeOn`, then the pin, the name from the machines
config while the machine is there; past events are not rewritten. Login prompts from machines (the
device-code component's optional `machine`) carry the same shape.

**Visible and answerable at once.** From that commit on, the question is in `GET /api/questions`
(every open question, whatever its stage) and the job in `/api/queue` `waitingAnswer`; the UI
refreshes both on `question.asked` and shows the answer box at every stage, not only `human`.
The owner may answer while a level works on it: their answer wins, the in-flight level call is
aborted (`superseded`), no level above is called, and nothing is pushed. **Push is gated:** the
Grok Bot routine webhook fire only on `question.escalated_to_human` (issue #481) — after every level
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
   `question.escalated {target: "human", reason, text, jobId, goal, answerUrl, notifyCount: 1}`,
   then `question.escalated_to_human {reason, text, jobId, goal, answerUrl, notifyCount: 1}` — once
   per question, so a subscriber that wants only the owner's questions names that type and hears
   no level hop, however many levels there are (issue #357).
   Every `HOPPER_HUMAN_RENOTIFY_MS` while open: `question.escalated` again, `renotify: true`,
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

**The machine that answers** (issue #150). A level's `claude` runs where its Claude sign-in is. A
hopper in a container has none, so `claude-cli` takes an option `machine`: an attached ssh machine
that runs claude for that level, through the hopper's ssh connection (`commandOn`), as `sh -c
ON_MACHINE sh claude <argv>` — the same argv, the prompt on stdin, in a fresh private dir there,
removed after with the project dir claude keeps for it (`ON_MACHINE`, shared with `claude-plan`).
On a **client target** (issue #482) the hopper runs no command, so the level sends the call to its
client, `POST /level {model, effort?, jsonSchema, prompt, timeoutMs}` (`clientLevel`, signed like every
call on its link): the client builds the same lockdown argv itself (`src/client/level.ts` `levelArgv`, the
one owner of it — `claudeArgv` here is that function), runs its own claude with the prompt on stdin in a
fresh private dir removed after with claude's project dir, kills it at the timeout (exit 124, reported as
`claude timed out after <n> ms`), and answers `{code, stdout, stderr}`; the level parses stdout as on any
machine. The body names only the model (an alias or id, never an option), the effort, the schema and the
prompt: a signed call can start nothing but this locked-down run. This is what makes escalation work in a
container hopper whose only machine joined as a client: there is no `local` and no ssh machine. A client
release without the call is replaced by the keeper as for any release change ("Client releases").
The level finds the machine by id through `RoleContext['escalation-level'].machine` (`MachineLookup`,
as a usage source does) and reaches a client through `client` (`ExecutorContext['client']`); a machine
not configured, offline, a client not dialled in or a container target (`docker exec` passes no stdin)
is `{ error }` with why and how to fix it, so the question escalates. `machine` is not
command-bearing: the owner designates it in the Question gates panel; it can only name a machine
already configured.

**Always a machine** (issue #174). `machine` is a **machine option** (`.meta({ machine: true })`):
required, and picked from the configured machines — the UI offers a select of them (`choices`
filled by the host from `machines:`), never a text field, and no empty choice. This machine is no
default: it is the `local` machine in the list, like any other; on it claude runs here, as before
(the snapshot has no `ssh`, `docker` or `client`). The built-in levels name `local` where this host
is a machine and none in the container, where one must be picked. A fresh plugins config names none
either (issue #259, "Built-in instances: no machine of its own"): its levels wait for one to be picked. `POST /ui/api/plugins` refuses an
`options` or `add` edit whose machine option is missing or names no configured machine (`add`
carries `options` for it), and the removal of a machine an instance's machine option still names.
Tenant migration 3 names the `local` machine in every claude-cli level and claude-plan usage source
that named none: they ran here. Detection runs nothing here: claude runs on the machine, and whether
it does shows in each question's trail.

**A level that names no machine** (issue #442; owner decision: both — fill it where it is certain, and
pick it at run time as a safety net). The edits above still refuse a level or source without its
machine, but a plugins config written with none (a fresh store, issue #259; the container) holds
claude-cli levels and a claude-plan source that name none, and the option's schema made them
unavailable: every question went to the owner with a zod message on its trail. The `machine` option
is now optional in the schema, and `src/domain/machine-pick.ts` decides, pure:

- **At run time** (`pickMachine`). A claude-cli level that names no machine picks one per question:
  the job's machine (`AnswerRequest.jobMachine`: `resumeOn`, else its pin) where claude can run there
  — online, and this machine, an ssh target or a client target (issue #482), never a container target
  (`refusal`) —; else
  the only machine that can; else the **default escalation machine** (the plugins config's
  `escalationMachine`, `EscalationLevelContext.escalationMachine()`). The reply carries `machine:
  { id, why }`, and the question service puts it on the attempt: the trail says on which machine the
  level ran and why. None: the level does not run; it escalates with the plain reason
  (`NO_MACHINE_FOR_LEVEL`, or that several can and nothing says which) and how to fix it. A claude-plan
  source that names none reads the only machine there is (any connection), at each read, its readings
  and account that machine's; none, or several: its state says so, and it reads again soon.
- **In Settings** (`machineNote`, from the configured machines, not their state). Each such level and
  source in `GET /api/plugins` carries `machine: { machine?, needsMachine, note }`: the machine it
  runs on, or, when none can run it or several can with no default set, `needsMachine` and the plain
  reason. The UI shows the level as *needs a machine*. No question action needs a level, so none is
  hidden: an escalated question waits for the owner as before.
- **A level that names its machine** (`namedMachineNote`, issue #482): flagged *needs a machine* when that
  machine can never run it — not configured, or a container target —, and *cannot run* while it is
  offline (from the machines as the engine last listed them, `lastListed` in the host), each with the
  plain reason and how to fix it (start the hopper client on a client target; check ssh on an ssh one;
  or pick another machine). A level that can run there carries no note.
- **In the store** (`fillMachines`, tenant migration 17, `migration-name-the-machine.ts`): a level or
  source that names none names the one machine that can run it, where exactly one is configured
  (claude-cli: `local`, `ssh` or `client` — a client since issue #482; claude-plan: any). Anywhere else it is left unnamed, and flagged. The
  plugins config is re-read by version, so the parts follow it live.
- **The default escalation machine** is set in the Question gates panel (`POST /ui/api/plugins`
  `{ action: 'escalation-machine', machine | null }`): a configured machine, else refused. It is a
  machine reference like a machine option: a rename follows it, and a removal of that machine is
  refused while it names it.

**Anthropic API plugin** (`anthropic-api`, an escalation level, not in the built-in instances). The
other way a hopper without a claude CLI answers: one Messages request per question through
`@anthropic-ai/sdk` (`messages.parse`, `output_config.format` = the level reply schema, optional
`effort`, no tools), the claude-cli prompt as the user message. The API key is a runtime secret
(`apiKeyEnv`, "Secrets"), read per question; `baseUrl` (command-bearing) sends it elsewhere, for a
compatible provider. A refusal, an API error, a reply off the schema, the timeout or an abort is
`{ error }`. Detection checks only that the key is there: never a paid call. Added from the Question
gates panel; the key itself is never typed into the hopper — the hopper stores no secret.

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
next question fails the job `too many questions` (and cleans up).

**Status note (issue #163).** Only a real question opens a question: the `HOPPER_QUESTION` marker,
or Claude's own dialog (`blocked`). A turn that ends without a marker is a status note — progress
("the tests run in the background, I will report"), often a turn ended while background work runs.
It opens no question, fires no `question.*` event or webhook, and holds nothing: its last line is
already the job's progress, and the executor nudges the agent (`STATUS_NOTE_NUDGE`, `screen.ts`):
go on; ask with the marker if an answer is needed; end with `HOPPER_DONE` or `HOPPER_FAILED`. An
agent that asked in prose asks again with the marker. herdr-claude nudges after `idleNudgeMs`, then
after 1, 5, 15 and 30 minutes for further status notes in a row, then no more until Claude works again
by itself, and never while its footer names background work (issue #491: each nudge is a paid turn,
and one job waiting on a background poll got six in minutes); cursor-agent resumes its chat
with the nudge, at most three times in a row, then fails the job (a print-mode turn never waits on
background work). Questions stored before keep `detectedBy: idle`; no new one carries it.

**The check before a nudge (issue #627).** Before herdr-claude nudges, it asks `ExecutionContext.beforeNudge`
(`NudgeCheck`, `src/engine/nudge-check.ts`). The job's source first (`overAtSource`, `src/domain/pull-requests.ts`):
the job's own pull request is ready for review (the whole issue or a part), or its issue is closed as complete
(`judge`), or its issue is closed by any other means or gone (`JobSource.workState`) → the job ends done, not nudged:
progress `ended done, not nudged: <why>`, the status note its summary, `endedBy` the why. The run then goes the
way of any done job: its source judges it (`completeOrFailed`), so an issue closed as not planned ends failed,
not complete. A source that judges nothing (`notComplete` absent) tells nothing. Then what the job waits on a
person for (`personAwaited`): an open watch on its job stream (issue #613) or a credential request that names it
(issue #583) → no nudge: progress `waiting on a person (<what>): no nudge`, and the watch goes on as after the
last nudge of a row, until Claude works again by itself or `timeoutMs`. Else the nudge. A check that cannot
tell (GitHub unreachable) is said in the progress, and the job is nudged as before. cursor-agent and the other
print-mode executors do not ask it.

**Recovery at startup (B2, B3).** `install.sh` restarts the daemon, not `hopper-herdr`,
so a running job's pane and Claude outlive a restart.
- `running` job of a non-idempotent executor (herdr-claude) **reattached** when its lane row
  still holds it and `executor.canReattach(job)` says its work is alive — for herdr-claude:
  `executorState` has a `turn` and `agent get <agentName>` answers for the saved `paneId`.
  Probed before the recovery tx (herdr calls). In the tx: the job stays `running` with its
  `laneId`, its lane is kept (not closed), `job.reattached { reason: "daemon restart" }`.
  After it: `executor.reattach(ctx)` runs the monitor from the saved turn anchor (`seq`,
  `anchor`, `blockedAtSend`) — a turn that ended while the daemon was down is detected on the
  first poll (status idle/done, seq past the send), one in progress is watched, one never sent is
  a lost send after `idleNudgeMs` and sent again; `timeoutMs` and
  the progress clock restart at reattach. No `job.started`; the outcome is recorded as any
  other run's. The decider is unchanged: the kept lane is an ordinary busy lane.
- Same job, work gone (no `turn`, agent gone, pane differs, or the lane row lost) →
  `executor.cleanup(job)`, job `failed` `interrupted by daemon restart`, `job.failed`. Not
  re-run: a second run repeats real side effects. A non-idempotent executor without
  `reattach` always takes this path.
- Same job, its machine **not answering yet** (issue #368: `canReattach` rejects — a client target
  not dialled in, an ssh target not replying; recovery runs before either can) → in the tx the job
  stays `running` with its `laneId` and its lane is kept, as a reattached one, but no event yet.
  After it the runner asks `canReattach` again every second, the job held by the runner as any
  run is (cancel and shutdown abort the wait): alive → `job.reattached { reason: "daemon restart" }`
  and reattach as above; gone → failed `interrupted by daemon restart`; still no answer after the
  **reconnect grace** (`HOPPER_RECONNECT_GRACE_MS`, default 120 s) → failed `machine <id> did not
  reconnect within <n> s after the daemon restart`. Either failure frees the lane and cleans up;
  a pane its cleanup cannot reach then may still run, so that cleanup is deferred and tried again
  (issue #371, "Deferred cleanup").
- `claimed` jobs, any executor → requeued (`job.requeued { from: claimed }`), `executorState`
  and `pendingAnswer` kept, nothing closed. The claim → `running` write happens before the
  executor is called, so a claimed job never ran: a fresh claim has no pane; a resume claim's
  pane is its waiting pane, which the next resume uses.
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
`seenAt` while it is shown with a UI session. No event: seen changes no job, and nothing outside the
UI reads it; it is kept as part of the question's record. Seen does not touch the nav badge (issue #499).

**Nav badges count what is pending, not what is unseen** (issue #499, reversing the badge part of #37 and
#42). The Questions badge counts the open questions at the human stage, seen or not: it stays across
views and reloads while one is open, and clears only when every one is answered, closed, dismissed or
expired. A question still with an escalation level does not count: it does not wait on the owner yet.
The count follows the live stream: every `question.*` event refreshes the open questions. Opening the
Questions view changes nothing in the count. Any other badge for something pending (the Logins badge,
issue #477) follows the same rule: it counts what is pending and clears only when none is.

**Question history** (issue #37): every question stays in the `questions` table with its text,
trail, answer and status; nothing prunes it. Settings' Question history (issue #151) lists handled ones (status not
`open`, newest first, the last 200 from `GET /api/questions?status=all&limit=200`) as one compact
line each — time, outcome, first line of the question — that opens to the question, the answer
and who gave it, and the job. The history is local to the hopper's SQLite file: no route sends it
anywhere, and the hopper writes nothing of a question to GitHub (it writes only labels).

**Lapsed** (issue #376). Claude Code may deny a dialog by itself when its countdown runs out ("Claude
Code will automatically deny this request in 1:59, …"; `autoDenyMs` in `screen.ts`). The monitor reads
the countdown when the turn stops on the question: the question gets `lapsesAt`, the pane state too, the human stage's
`question.escalated`/`question.escalated_to_human` carry it, and the UI shows it on the open question.
When the job's work runs again (below) with nothing typed, at or after `lapsesAt` (less 5 s: the
countdown is read in whole seconds, up to a poll late), nobody answered: one tx, question `lapsed`,
`question.lapsed { questionId, lapsesAt }`, no `question.answered`, any stage aborted, and the job
reattached as below with `reason: "the dialog lapsed"`. A key pressed in the pane before the countdown
ends is still the owner's answer.

**Answered in the pane.** The owner may type the answer straight into a waiting pane instead of
the UI. On every engine tick, `src/engine/pane-answers.ts` asks the executor of each
`waiting_answer` job `answeredInPane(job)` (port method; herdr-claude implements it; the decider
is untouched). herdr-claude: the monitor saves `parkedSeq` (the `state_change_seq` at which the
turn stopped on its question; the name predates parked jobs, issue #501, and is kept for the state jobs hold) in `executorState`; a job that stopped before that field existed uses its turn's send
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

**Logged out** there is no card: the page is the landing page (issue #213, "Who you are, and sign-in
first"). A 403 on any mutation drops the stored token and the page falls to the landing page. A
session whose role cannot answer sees a notice where the answer box would be. In the UI rework this is
`ui/src/views/questions.tsx` (the notice is `data-slot="login-notice"`; Close sits next to Send answer and asks first in a
dialog, `components/confirm.tsx`, never `window.confirm`); `test/ui/questions.test.ts` renders
the whole app in happy-dom against a fake daemon.

**Order and reading position** (issue #450). The open questions have one order, oldest first: the
longest waiting on top, ties by `seq`. `GET /api/questions?status=open` answers in it, and the view sorts
by `createdAt` again (`longestWaitingFirst`, `ui/src/model/questions.ts`), so a refresh or a reconnect
never reorders the list. A gained attempt or a tier change ("With level-1" to "For you") never moves a
question; there is no grouping by tier. Every other listing (`status=all`, a handled status) is a
history, newest first. The view keeps the reading position (`ui/src/lib/reading-position.ts`): the first
card whose top is on screen is the anchor, and after every change (an arrival, a question leaving, a
card growing) the window scrolls by what it moved, so the card in view and the answer being typed stay
put; when the anchor itself leaves, the next card takes its place. Arrivals are shown at once; those
that land below the screen show as an "N new below" button (`data-slot="new-questions"`) that scrolls to
the first of them. Nothing is held back, so seen marking is unchanged. `test/ui/questions-reading-position.test.ts`
lays the cards out by hand (happy-dom has no layout).

## Decider changes

`waiting_answer` jobs are in neither `waiting` nor `running`, hold no lane, and are not
inputs. A waiting job with `pendingAnswer`: effective priority `+ policy.resumeBoost` in
both modes; pinned to `job.resumeOn ?? spec.machineId`; router holds do not apply to it (the
job was already admitted once) — it is never re-held for the router.

## API additions

| method | path | returns |
|--------|------|---------|
| GET | `/api/questions?status=open\|answered\|expired\|cancelled\|all&limit=100` | `{ questions: Question[] }` `open`: oldest first (the longest waiting on top); any other: newest first (issue #450); default `open` |
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
| `question.escalated_to_human` | `{ questionId, reason, text, jobId, goal?, answerUrl, notifyCount }` — the human stage only, once per question; never a level hop or a re-notification |
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
Op `propose` (issue #537): outcome `proposal` (text = `message`); resumed (sent back), a proposal again: `message`
then `Revised after: <answer>`.

## Settled in phase 2 (2026-10-02)

- **Construction, as built:** `createEngine` also takes `questions`, `maxQuestions`,
  `keepPanes`; `createServer` takes `questions`; `startApp(config, seams?)` accepts
  `{ herdr?, executors? }` for tests (production passes nothing). The engine starts after
  `server.listen` so `answerUrl` carries the real port. `/api/health` lists `executors`.
- **`job.requeued`** `data.from`/`reason` also take `waiting_answer` / `answered`.
- **Panes close on every terminal outcome** (finished, failed, cancelled, restart failure)
  via `executor.cleanup`, unless `HOPPER_KEEP_PANES=true`. Timeouts and failed startups
  close their pane too.
- **Deferred cleanup** (issue #371). A cleanup that cannot reach the job's machine is not dropped.
  Seen live (before the reconnect grace): restart recovery failed a job on a client target that had
  not dialled back in yet; the one cleanup it queued never reached the pane, Claude kept working, and a rerun of the issue started
  beside it seven minutes later. The two collided until the old pane was closed by hand.
  `src/engine/cleanup.ts`: when `Executor.cleanup` rejects, the job gets `cleanupDeferred { at, error }`
  and `job.cleanup_deferred { error }` (once per deferral). Every tick tries each deferred cleanup again
  that is not running; the first that goes through clears the field and records `job.cleaned_up
  { deferredAt }` (an engine trigger). The deferrals are read back from the store at start, so a
  restart keeps them. Meanwhile the decider holds a waiting job of the same item (step 5): the
  engine passes `DecisionInputs.cleanupDue`, the ended jobs whose cleanup is deferred or running now.
  The UI flags such a job (Ended, the locked entries, Attention). **Mark closed**
  (`POST /ui/api/jobs/:id/cleaned-up`, operator) ends a deferral by hand — the pane closed by hand, or
  its machine gone for good — with `job.cleaned_up { by: "user" }`; without it a machine that never
  comes back would hold its items for good.
- **herdr unit:** a second `herdr --session X server` exits 1, so
  `hopper-herdr.service` has an `ExecCondition` that skips the start when that
  session's server already runs; it unsets `CLAUDECODE` and the `CLAUDE_CODE_*` markers
  because panes inherit the server's environment. `install.sh` never restarts an active
  herdr unit — that would kill every waiting pane.
- **The level's reply schema is a literal draft-07 object.** zod's `toJSONSchema` stamps `$schema`
  draft 2020-12, which the claude CLI rejects ("no schema with key or ref"); every tier then
  exits 1 and every question reaches the human. Found live; the unit tests' fake `claude`
  could not see it.
- **Screen chrome** that is never progress: the status/spinner line, user echo, `⏵` mode
  line, the effort indicator (`… · /effort`), spinner tips (`⎿  Tip: …`), and the CLI's update
  notice (issue #360).
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
| `src/sources/` | `JobSource` adapters (`github`), the GitHub API port + `gh` CLI adapter + in-memory fake, the sync loop, its slots (`sync-slots.ts`, the sources followed live, issue #356), its Run again half (`rerun.ts`, issues #362, #354), what it gives the host for an item's snapshot (`item-text.ts`, issue #662: the source's renderer, who edited the item) and its after-done half (`after-done.ts`, issue #579: a finished job's pull request followed, a job failed for want of a merge judged again); since slice 4 the GitHub sources' option schemas (`config.ts`, was the `sources.yaml` loader) and their factories (`compose.ts`), reached through the job-source plugins | engine internals (uses the narrow `SourceHost` it is given), http, plugins |
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

SSE adds non-domain `event: source.updated` (`data: SourceStatus`), like `delivery.updated`, and `event: usage.recorded` (`data: { added }`, issue #502) when the usage history keeps new samples.

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
   expiry `HOPPER_UI_SESSION_HOURS`, default 12 — since issue #439 an idle timeout and a maximum from the sign-in config, "Session lifetime"), rotate the code, and answer with a
   same-origin HTML page whose inline script stores the token in `localStorage`
   (`jh_session`) and goes to `/`. Mismatch → 403. `localStorage` is scoped to the exact
   origin incl. port, so no other server on `127.0.0.1` can read it. Sessions live in the store
   (`ui_sessions`, migration 6), so a daemon restart does not log the UI out; the row holds
   only the token's SHA-256 and the expiry, never the token. Expired rows are deleted on
   lookup. Logout deletes the row.
4. **`GET /ui/api/session`** with header `x-hopper-session` → `{ authenticated,
   expiresAt? }`. Without a valid session the page is the landing page with the ways to sign in
   ("Who you are, and sign-in first"); it names no command and takes no pasted code (issue #247).
5. **Mutations** — `POST` only, JSON body, all of: header `x-hopper-session` = a live
   session token (constant-time); `Origin` exactly `http://127.0.0.1:<port>` or
   `http://localhost:<port>`; `Sec-Fetch-Site`, when present, `same-origin`;
   `content-type: application/json`. The custom header is the CSRF defence (a cross-site
   page cannot set it or read the token). Any failure → 403 `{ error }`, logged.

| method | path | body | effect |
|--------|------|------|--------|
| POST | `/ui/api/jobs/:id/cancel` | `{}` | engine `cancel(id, "cancelled in UI")` (the source is told) |
| POST | `/ui/api/jobs/:id/approve` | `{}` | engine approve |
| POST | `/ui/api/questions/:id/answer` | `{ answer }` | `QuestionService.answerByHuman` (404/409). Idempotent per question (issue #459): the owner's same answer again returns the question with no second effect; another answer is 409 |
| POST | `/ui/api/questions/:id/close` | `{}` | `QuestionService.closeByHuman` (404/409): close without answering ("Questions" → Close) |
| POST | `/ui/api/questions/:id/dismiss` | `{}` | `QuestionService.dismissByHuman` (404/409): drop the question; a job still waiting on it is cancelled ("Questions" → Dismiss) |
| POST | `/ui/api/questions/:id/seen` | `{}` | `QuestionService.markSeen` (404): `seenAt` once; the nav badge does not read it |
| POST | `/ui/api/plugins` | `{ action, … }` | edit plugins.yaml: one instance's options, select a plugin, add or remove a list role's instance, rescan (phase 5 slice 7, issue #4; "Settled in slice 7") |
| POST | `/ui/api/rules-file` | `{ text, version }` | replace the rules file whole (issue #18, "Question gates"): 400 over 64 KiB, 409 stale `version` |
| POST | `/ui/api/webhooks` | `{ action, name, … }` | edit the webhook subscriptions (rows in the store, issue #78): add (with a `secret` typed in, or none: the hopper makes one), edit (url, events, active), replace (`secret`), rotate, remove one; answers `GET /api/webhooks`, never a secret but one the hopper made, once (`generatedSecret`); `cache-control: no-store` (issues #18, #451) ("Webhook signing secrets") |
| POST | `/ui/api/webhooks/test` | `{ name }` | Send test event (issue #378): one signed test event to the subscription, one attempt — typed as the first event type it names, with that type's example data plus `test: true` and `subscription` (issue #481), or `webhook.test` for `*` only; answers `{ ok, status?, detail }`. No delivery row, nothing appended |
| POST | `/ui/api/notifiers` | `{ action: test \| send-open, name }` | a running notifier's action (issue #378): a marked test payload, or every question open at the human now; answers `{ ok, status?, detail, sent?, failed? }` ("Grok Bot routine webhook") |
| POST | `/ui/api/machines` | `{ action, … }` | add, edit or remove one attached machine in plugins.yaml, applied without a restart (issue #18; "Machines from the UI") |
| POST | `/ui/api/device-link` | `{ keep? }` | `{ links }`: `keep`'s code again while it is live, else a fresh login code, as `http://<LAN name>:<port>/#login=<code>`, one per LAN name; 409 without LAN names ("Reaching the UI across the LAN") |
| POST | `/ui/api/logout` | `{}` | drop the session |

Since issue #39 a session may also come from a realm, and each mutation needs a UI
role: "Sign-in: realms" (Roles).

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
   `job.failed`); for items that already have a job: `host.refresh(jobId, item, source)`
   (re-sort and respecify; applies only to queued/held — see **Waiting jobs take the config as
   it is now** below),
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
5. **A failing source is never silent** (issue #358): its error is logged once when it changes, and
   once when the source is ok again; a source in error longer than the **stall threshold**
   (`STALL_AFTER_MS`, 30 min) records `source.stalled { source, kind, error, since }` once per run of
   failures, which the notifiers send.

**Waiting jobs take the config as it is now** (issue #375). Each sync offers every item that already
has a waiting (`queued`/`held`) job to `host.refresh(jobId, item, source)`, one tx that re-reads the
job (`src/engine/source-host.ts`):

- **Priority:** the routing rule's, else the item's, as now; a change → `job.reprioritized`. A job
  that ran before (requeued) is re-sorted too.
- **Spec, only while the job has never started** (`attempts` 0, no pending answer): routing is run
  again and the parts the source and routing rules give the spec — executor, model, work tree,
  default work tree, machine pin, routing rule (`SpecFromConfig`) — are worked out again. The job
  keeps what they gave it last as `fromConfig` (absent on a job from before: its spec as it is). A
  part whose value on the job differs from `fromConfig` was changed by hand and is kept; the others
  take the new value. When the config's answer changed, the spec is replaced
  (`JobRepository.respecify`), `fromConfig` updated and `job.respecified { from, to }` recorded; a
  Decision follows, since the pin may have moved. A new spec its executor rejects is not applied
  (logged); the job keeps the old one.
- **A started job keeps its spec.** A job waiting on an answer resumes in the pane, agent session
  and work tree it ran in, so neither its machine nor its work tree can change under it. To run it on
  the new config, cancel it and run it again.

**Re-run.** A source key may have many jobs; `jobs.source_key` is an index, not unique, and
`getBySourceKey` returns the **newest** (`created_at`, then `seq`, descending). An item whose
newest job ended — `finished`, `failed` or `cancelled` — **and** whose end was reported
(`sourceState.sync.finalReported`, so the source's marker — `hopper:done` or `hopper:failed` on
GitHub — was written at least once) gets a new job when the source offers it again. The GitHub
source stops offering an issue while `hopper:failed` or `hopper:done` is present (and a finished
job's issue is closed), so removing that label — after reopening, for a finished one — is the
re-run gesture, and a leftover `hopper:claimed` does not block it (the old job makes the key known).
Unreported, the item stays one attempt, so a failing label write cannot loop. Predicate:
`isRerunnable` in `src/domain/types.ts`. The key spans sources: an old `github` job and a
`github-app` re-run share it. Before issue #186 a finished job was never re-run, so an issue reopened
after a job that finished without shipping stayed stuck, skipped without a word.

**Run again** (issues #313, #354). An ended job need not wait for a human to clear its marker at the
source, nor for a sync to offer its item again: `POST /ui/api/jobs/:id/rerun` (operator; the Ended
panel's Run again button) asks the sync loop (`SourceRegistry.rerun`) to queue the item again now. Only
the newest job of its key, status `failed` or `finished` (a result that is not wanted), whose end was
reported (`finalReported`), of a running source that implements `JobSource.rerun` — else 409; unknown →
404. On the job's report chain the source gives the item back (`JobSource.rerun`) — on GitHub
(`takeBack`) a closed issue is **reopened** (the new job is cancelled while its issue is closed, and its
own pull request's merge closes it again), `hopper:failed`, `hopper:done`, `hopper:rejected` and
`hopper:claimed` go, and the source label comes back if it was taken off — and answers the item as it
stands now. `SourceHost.rerun` then, in one tx, creates the new job as `ingest` does (routing rules, the
queue gate; priority and lane caps apply as to any job), with `rerunOf` the ended job, and appends
`job.rerun { by: "user" }` on the ended job; the route answers the new job, and the UI's toast says where
it is (waiting for acceptance, held and why, queued, or failed at intake with its reason). A sync that
offered the item in between already made the job: that one is answered. The ended job is kept as it
ended. A source that cannot give the item back → 502 with its error, and nothing is recorded. **An issue no
longer assigned to the connected account is refused** (issue #527): its new job was cancelled `unassigned` at
once while Run again answered success (22 such jobs in one day). `takeBack` reads the issue first and throws
`RerunRefused` before any write — 409, `job <id> cannot run again: its issue is not assigned to the connected
account <login>: assign it (Sources, Assign to me) and run it again`; nothing is reopened, relabelled or
recorded, and the failure assessor records it as not retried. Before
issue #354 Run again only cleared the labels and waited for a sync, and a closed issue was refused (409,
issue #348); neither is so now. Any job made for a key that already had one carries `rerunOf`, whether
Run again or a human clearing the marker made it.

**Locked entries** (issue #355). A failed job does not drop out of the queue: the newest job of its
item, failed and not dismissed, is a **locked entry** (`isLocked`, `src/domain/locked.ts`), listed in
`/api/queue` `locked`, highest priority first, then oldest — under the Overview's Waiting jobs and in the
Queue view's Locked panel, with its failure, the job it runs again (`rerunOf`), Run again and Dismiss.
Its status stays `failed`: the decider never sees it, so it takes no lane and no budget, and nothing
else that reads `failed` (the Ended list, the cards, the webhooks, the source's `hopper:failed`)
changes. The queue is the truth; the issue's labels mirror it. Run again (above) unlocks it: its new
job is the item's newest, so the failed one leaves `locked`, and a new failure is the locked entry in its
place. **Dismiss** (`POST /ui/api/jobs/:id/dismiss`, operator) sets `dismissedAt` and appends
`job.dismissed { by: "user" }`: the job leaves the locked entries, stays failed, keeps its issue's
`hopper:failed`, and can still be run again. A job that is not failed, or already dismissed → 409. A job
of no source (from before phase 3) is never a locked entry: it cannot run again. The UI keeps the locked
entries apart from its other jobs (`locked` in the store), since they are of any age while the rest
reach back 24 hours.

**Run again offered only where it is taken** (issues #362, #354). The UI never offers an action the
daemon refuses: the Ended panel's Run again (`canRerun`) needs a failed or finished job, the newest of its
item, its end reported. A closed issue no longer blocks it (Run again reopens it), so the per-sync
`JobSource.closedItems` check and its `sourceState.sync.itemClosed` mark that #362 added are gone; rows
that still carry `itemClosed` keep it, and nothing reads it.

**Not run again, said out loud** (issue #186). An offered item whose newest job ended but cannot
re-run yet (its end is not reported to the source) is not dropped silently: it is listed in the
source status `detail.notRerun` (`{ key, job, status, reason }`, shown on the Sources view) and
logged once per key, `hopper: <key> not run again: job <id> <status>, <reason>`. An item whose job is
still live is only re-sorted, as before. Residual: gh mode's search can lag about a minute, so a
just-reported issue may be offered once more with its old labels and re-run; the app source never
searches.

A source error never stops the daemon or other sources; it is shown in status and retried.

## GitHub source

> **Since issue #359** the gh CLI adapter is gone, and with it `owners`, `whoami()`,
> `searchOpenIssues` and every search: discovery lists the app's installed repos or a connected
> account's job repositories, repo by repo. The GitHub sources are `github-account` and `github-app`
> ("One way to GitHub as the user", at the end). The rest of this section is the phase-3 design.

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
triggers a decision. A started job's priority follows too, since issue #535 ("High priority everywhere"): the live priority.

**Full issue context into the job** (owner request, phase 3 addition). The prompt is the issue
body, then a block:

```
[hopper issue context]
repo: owner/repo · issue: #N · url: …
title: …
labels: a, b · author: owner
priority: 75 (label:hopper:high) · project item: <project title> · Priority=P1 (or "none")
done: …: done is the job's pull request, ready for review; with yolo mode on for the repo, it may also merge it ("Done is a pull request" below)
recent comments (oldest first, up to recentComments; only the assignee's, no hopper-marked comments — anyone else's text never reaches the job; issue #387):
- <author> at <ISO>: <body, ≤ 1000 chars>
...
```

The block ends at the comments list: no footer (write criteria below).

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
author in `authors` (issue #387: assigned to the user's connected account instead), no `hopper:done` / `hopper:failed` / `hopper:rejected` / `hopper:backburner`, repo allowed,
not addressed to another hopper (`hopper@<name>`, "Queue gate"). Already-claimed
issues with no job here (another machine, a wiped database) are **not** re-run: an issue
labelled `hopper:claimed` with no local job is skipped and shown in status detail.

**Item → job:** key = issue URL; title → goal; prompt = body + issue context (above); env as
above; empty body → claimed, then failed with error "empty issue body"; priority per
"Priority"; cwd = `repoPaths[repo]` (expanded) else `defaultCwd`.

**Write criteria.** The hopper's only issue writes are labels (state); it posts no comments at all
(owner decision, 2026-10-04: a finished issue needs no comment). It never closes an issue (issue
#187): the merge of the job's own pull request does — a person's, the job's own with yolo mode on (issue #579), or the
hopper's own with yolo mode on (issue #637, "PR waiting" below) —;
until then the issue stays open, labelled `hopper:done`. (Issue #38 had the hopper close a finished job's issue; once
done meant merged, that close only ever met a closed issue.) A failed or cancelled job's issue stays open.
The one write that is not a label: the user's **Run again** reopens the job's closed issue (issue #354, above). No claim, progress,
question, answered, failure, cancel or completion comment; no reactions, other issue edits, or PR
comments. Jobs get no way to write to their issue (no token, no helper), and their prompt says
nothing about commenting (owner decision, 2026-10-04: a job has no reason to talk on its issue): the
issue context block ends at the comments list, with no footer. A question goes to the owner through
the UI and the Grok Bot routine webhook, never onto the issue; a reply on the issue is not an
answer.

Comments the hopper posted before this rule start with a hidden marker line (`<!-- hopper v1
kind=… -->`). They remain on issues, so the context filter still drops any comment carrying the
`<!-- hopper v1 ` prefix (and, in app mode, any by the bot).

**Done is a pull request** (issues #171, #187, #579, #637). A job that ends done (`HOPPER_DONE`, or any
executor's `finished` outcome) is not recorded finished until its source has said its work is **complete**
(`JobSource.notComplete(job)`, asked by the engine's runner before `recordOutcome`). **What GitHub shows decides, not
what the job did** (issue #637): before it the rule asked "did this job make the pull request?", and a run again that
pushed to an older pull request, one whose older pull request merged before the check, or a maintenance job with nothing
left to push all ended failed. For the GitHub sources (`src/sources/github/completion.ts`) complete is one of:

1. The issue is **closed as completed** — by any pull request, commit or person, at any time (`isClosedAsCompleted`: its
   `state_reason` is completed, or its last close event's closer is a merged pull request and it is not closed as not
   planned). Closed as not planned is not done.
2. A pull request **of the issue's repo that closes or references it** — `closedByPullRequestsReferences` (a closing
   keyword, to the default branch), or a cross-reference (`Refs #N`, any mention) — is open, not a draft and has no merge
   conflicts (GraphQL `mergeable` is not `CONFLICTING`; `UNKNOWN`, not yet computed, does not count against it), or is
   merged at or after the job's `createdAt`. Whoever opened it, whenever. One that says `Part of #N` ships a part, not the
   whole (partly done, below). A merge before the job, on an issue still open, is work the job was asked to redo: not done.
   An open pull request of the repo that names the issue **only on its branch** (`namesIssue`: `issue-N`, `issue_N`,
   `issueN` anywhere, or `N-…` at the start or after a slash; not `fix-N`), ready for review, counts the same
   (`GitHubApi.openPullRequests`, the newest 100 open; asked only on a miss): no cross-reference shows it.
3. The issue **asks to update the pull requests it names** (`asksToUpdate`: its title, or a line of its body, starts with
   bring / rebase / update / refresh / fix the conflicts and names a pull request): each pull request it names in its own
   repo (`#N` or its URL, at most 10 asked, `GitHubApi.pullRequest`; a number that is an issue counts for nothing) is
   merged, at any time, or open with no merge conflicts. The job need not have pushed: one already current has nothing to push.
4. The issue's **deliverable is an artifact** (issue #673: `isArtifactDeliverable`, a line of its body that says
   `Deliverable: artifact`, any case): the job made at least one artifact linked to the issue (its `issue` is the job's
   issue URL; `JobSourceContext.jobArtifacts`), and a comment on the issue names one — its link or its id. `share ID
   --owner` posts that comment ("Artifacts": share with the owner). A pull request still counts too. The job's `done` line
   says so (`artifactDoneLine`). The line sits in the issue's text, which anyone who may edit the issue can change: the
   most it can do is end a job done with an artifact and no pull request, the same reach as asking for no code change.

**A merge is never needed:** a pull request is done; a merge is only allowed (owner decision, issue #579). A miss names
what was looked at (issue #637): `not complete: the issue <url> is open, and no pull request in <repo> that closes or
references it is ready for review or merged since the job began: #12 (open, draft), #13 (open, merge conflicts)` — plus,
for an update, the named pull requests and their state. **A miss is asked again** once after `HOPPER_DONE_RECHECK_MS`
(default 60 s): GitHub may list a new pull request, or a new head commit, only some seconds after the push. The failure
assessor looks a third time before it assesses the failure ("Failure assessment": a done-check miss).

**A pull request left in conflict or as a draft** (issue #626) is not done, but the next step is fixed, so no person
is asked. When a done job is neither complete nor partly done, the runner asks its source for the job's own open pull
request that one step finishes (`JobSource.unfinishedPullRequest`; for GitHub one that closes the issue or ships part of
it): with merge conflicts, `rebase` it onto its base branch (conflicts come first: a draft with them is rebased); a draft
free of them, `mark_ready` it for review. The job then goes on in its own session (`Executor.resume`, in the same pane
and work tree) told that step's **finish brief** (`finishBrief`, `src/domain/pull-requests.ts`): fixed text, no model
call, recorded as `job.finish_briefed`. Its next end is judged again. At most `MAX_FINISH_BRIEFS` (2) per run; after them,
or with no such pull request, an executor that cannot resume, or any other state, the job fails `not complete:` and is
handed to a person as before.

**Yolo mode** (issue #579, `src/domain/yolo-mode.ts`) is whether a job may merge its own pull request once the
repo's checks pass. Off unless a person turns it on: an admin's setting of the user's (`yoloMode` in the user's
settings; `GET /api/yolo-mode`, `POST /ui/api/yolo-mode`, `yolo_mode.changed`; Settings → Yolo mode), `on` for every
job repository, and per repository (`repos`, `owner/repo` lowercased), which wins. The source reads it each time it
builds a job's prompt (`JobSourceContext.yoloMode(repo)`), so a change applies to the next job without a restart; a
running job keeps what it was told. It never changes what done is. Off by default because a merge with nobody
reviewing it is a merge nothing else stops where a repository has no branch protection, and a merge to the default
branch runs what it triggers there (here: the `dev` image is published from it) — the UI says so beside the switch.
Not *Yolo*, the herdr-claude executor's choice that Claude runs with every permission ("Yolo" above). Since issue #637
yolo mode also has the **hopper** merge: following a PR waiting job's pull request (below), it merges one that is ready —
not a draft, no merge conflicts, its checks passed, or it has none and none started within two minutes of its last push (issue #677, "No checks means ready" below; on this repository the check is `pr / test`, issue #672, `docs/deploy.md` "Local development and tests") — with a merge commit (`GitHubApi.merge`, `PUT
/pulls/{n}/merge`, through the job's source's own connection). One definition of done; the merge is an extra step after
it.

| yolo mode | the job's prompt says |
|-----------|-----------------------|
| off (default) | `done:` checks pass, pushed, a pull request with `Closes #N` open, not a draft, no merge conflicts; an issue that needs no code change: closed as completed. Do not merge it: a person reviews and merges it |
| on for the repo | the same, then: the hopper merges the pull request once its checks pass, or, when the repo has no checks, a short time after the last push. Do not merge it yourself (issue #652: the job holds no token to merge with; before it, the job merged) |

Both say, before the yolo part: an issue that asks to update an existing pull request is done by pushing to its branch,
no new pull request, once it has no merge conflicts with its base (issue #618).

The prompt's `done:` line carries the parts the hopper cannot see — the repo's own checks, verifying where the
product runs — so a job is told everything done means, and the gate holds it to the part GitHub can show. Anything
short of it — a local commit, a branch, a draft, a pull request with merge conflicts, the issue closed as not
planned — fails the job with `not complete: <what was looked at>` after the re-check; an error asking GitHub
(transient or not) fails it with `could not confirm the work is complete: <error>`. Fail closed: a failed job's issue
stays open with `hopper:failed`, never `hopper:done`, and removing that label re-runs it. A source without `notComplete`, and a job
of no source, take every done job as complete. Before issue #171, a job that said it was done was closed as
completed with nothing on the default branch.

**Partly done** (issue #579). A job that ships part of its issue opens its pull request with `Part of #N` in its body
in place of `Closes #N`, lists in it what is left, and ends done; its prompt's `done:` line says so. Not complete by
the rule above, it is asked once more before it would fail (`JobSource.partlyDone`; the engine's verdict,
`src/domain/pull-requests.ts` `judge`): the job's own pull request that mentions the issue (the issue's
`CROSS_REFERENCED_EVENT` timeline, `GitHubApi.referencingPullRequests`), in the issue's repository, whose body says
`Part of #N`, open and ready for review — not a draft, no merge conflicts — or merged already. Found, the job ends
`finished` with `partlyDone` (its URL; on the job and on `job.finished`), never failed; the issue gets
`hopper:partly-done`. The next part runs once that pull request is merged (below): the hopper does not split the issue
and does not ask; a person who wants it split splits it.

**After done** (issue #579, `src/sources/after-done.ts`, `src/sources/github/follow.ts`). A finished job's report
keeps its pull request in the job's source state (`pullRequest`, `follow: open`, `part` for a part), and each sync of
its source asks again where it is (`JobSource.follow`), on the job's report chain:

| the pull request | then |
|------------------|------|
| still open | what is seen of it — a draft, merge conflicts, its checks, when it opened — kept in its source state (`seen`), no event (issue #637); with yolo mode on for its repository and it ready, the hopper merges it: then as merged, `byHopper: true` on the event. A refused merge (405, 409, no access) is kept on it (`mergeError`) and asked again next sync; a transient error is a report retry. Neither fails the job nor makes a failure record |
| merged — the issue closed as complete by it, or the pull request merged | `job.pull_request_merged`; `hopper:pr-ready` → `hopper:done`. A part: `hopper:partly-done` only comes off, so the next sync offers the issue again and a new job takes the next part |
| closed without a merge | `job.pull_request_closed`; → `hopper:pr-closed`, which keeps the issue out until a person removes it (then it runs again) |

The issue closes when the pull request merges, by whoever merges it, as GitHub does; the hopper still never closes one.
A pull request the report could not name is followed only to its merge. A throw is a report retry, asked again next
sync. **A job that failed only for want of a merge** — its error `not complete: …`, from before a pull request was
done — and still waiting on a person in Needs a person is judged again at each sync of its source: done or partly done
now, it is finished (`SourceHost.finishComplete`), its hand-off closes on `job.finished`, and its end is reported again,
so its issue loses `hopper:failed`. The failure assessor's `not-complete` cause says so: a pull request waiting for its
merge is never a failure.

**PR waiting and the Pull requests list** (issue #637, `src/domain/pull-request-list.ts`). A finished job whose pull
request is open and followed is **PR waiting**: done, not failed, using no lane, and kept in sight until its pull request
merges (it drops off) or closes without a merge (it shows `closed` and waits on a person: `hopper:pr-closed`). It is not a
job status: the job is `finished`, its source state `follow: open`. The report names the newest ready pull request that
closes the issue, else one that references it, else one on a branch named for it, so the list can link it; one it cannot
name is followed only to its merge. `GET /api/pull-requests` (`PullRequestsView`), the UI's Pull requests view and `hopper
prs` give the same: per job repository (and any other a card is in), its yolo mode and its cards, oldest first — the
issue, the pull request, `state` (`open`, `closed`), `checks` (`passing`, `pending`, `failing`, `none`, `unknown` until
seen), `mergeable` (`mergeable`, `conflicts`, `unknown`), `draft`, `openedAt`, `yolo`, and for an open one why its merge
`waits`: the first of `no pull request`, `not checked yet`, `draft`, `conflicts`, `checks failing`, `yolo off`, `checks pending`, `checks
not started`, `merge refused` (`mergeError` says what GitHub said), `ready` (issue #677); `base`, the branch it merges into. At the top, `yolo: { on, total }` over those repositories, and `waiting`:
per repository and reason, how many, the most first. All of it is what the last sync saw (`seen`), never asked of GitHub
at read time. Only the newest job of an item counts. Each repository's yolo switch is `POST /ui/api/yolo-mode` with
`repos`; `hopper yolo <owner/repo> on|off|default`.

**The done-check backfill** (issue #637, `src/failures/backfill.ts`). Failures an earlier done rule left — `not complete:`,
waiting on a person (its hand-off open, or its record neither run again nor settled), the newest job of its item — are
judged once by today's rule (`doneAtSource`). Done: in one transaction its hand-off closes (`finished`), its record turns
`resolved`, and its job ends finished with one event, `job.finished` with `result.backfill: "done-check"`; its end is told
to its source again, so the issue gets `hopper:done`, or `hopper:pr-ready` and is followed (PR waiting) when a pull request
of it is still open. Its issue is never reopened and nothing runs again. Not done: it stays in Failures; the answer gives
its card's plain sentence. It runs once per store at the first start of a build that has it, before the sync and the
assessor start (`backfills` in the user's settings, set once every job's source could tell; a GitHub error leaves it for
the next start), and again whenever asked: `POST /ui/api/backfill/done-check` (operator), `hopper backfill done-check`,
answering `{ backfill, changed: [{ jobId, state: finished | pr-waiting }], unchanged, failures: [{ jobId, reason }] }`. A
job it changed is no longer failed, so a second run changes nothing and writes no event.

**A failed job whose issue is closed as complete is finished** (issue #350). A job can end failed
after its work landed: its pane ends on a restart after its own pull request merged, a credential
expires while it waits on a question, or it closes its issue with a commit and then trips. Before
the sync loop reports a failed job, it asks the source `closedAsComplete(job)` (GitHub: closed as complete,
above, `src/sources/github/completion.ts`); true → `SourceHost.finishShipped`
ends the job `finished` (its `error` cleared; `job.finished` with result `issue closed as complete`,
after the `job.failed` already logged), and the report labels the issue `hopper:done`, never
`hopper:failed`. Any failure path is covered — the runner's outcome, restart recovery, an expired
question — because the report is the one place every failure passes. A transient error asking is a
report retry; a permanent one reports the failure. A source without `closedAsComplete` leaves every
failed job failed.

| report | on GitHub |
|--------|-----------|
| claimed | ensure labels `hopper:claimed`, `hopper:done`, `hopper:failed` exist (`gh label create --force`, once per repo per process); add `hopper:claimed`. **No comment** |
| finished | **no comment**; remove `hopper:claimed` (and `hopper:failed`, for a failed job found done later), add `hopper:pr-ready` while the issue is open — its pull request waits for review —, `hopper:partly-done` for a part, `hopper:done` when the issue is closed as complete already (only a job whose work is done or partly done is finished, above); never a close. The pull request is then followed ("After done"). Removing the end label from the open issue — reopened, when a merge closed it — is the re-run gesture |
| failed | **no comment**; remove `hopper:claimed`, add `hopper:failed` (removing it is the re-run gesture) |
| cancelled | **no comment**; remove `hopper:claimed` |
| rejected | **no comment**; remove `hopper:claimed`, add `hopper:rejected`; the issue stays open (removing the label is the re-run gesture) |

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
  (`src/sources/github/closer.ts`); a pull request opened before the job closing the issue cancels
  as above; a permanent error asking counts as "not its own".
- **And a started job's issue closed as complete with no pull request** (issue #350): closed as
  completed (`state_reason`) at or after the job's `createdAt` — a commit's `Closes #N`, or a close
  with no code — gives a job that has started (not `queued`/`held`) no signal: a job may end its
  issue itself. A waiting job is cancelled; a close as not planned, or before the job, cancels.
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

**Authors outside the allowlist are never acted on** — not as issues, not as answers. *Superseded by
issue #387: intake is by label and assignee, whoever filed the issue ("Intake by label and assignee").*

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
folded into plugins.yaml `jobSources`; the gh bin became github-gh's `bin` option, gone with that source in issue #359).

| var | default |
|-----|---------|
| `HOPPER_SOURCES_FILE` | `~/.config/hopper/sources.yaml` |
| `HOPPER_WEBHOOKS_FILE` | `~/.config/hopper/webhooks.yaml` |
| `HOPPER_GH_BIN` | `gh` |
| `HOPPER_UI_SESSION_HOURS` | `12` (no longer read since issue #439: "Session lifetime") |

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
  (`· Symbioting… (20s …)`, `* Crafting… (18m 43s …)`), `(ctrl+b to run in background)` and the elapsed timer above it (`(12s)`), the new-message indicator, user
  echo, `⏵` mode line, effort indicator, spinner tips, the CLI's update notice (`✔ Update installed ·
  Restart to update`, `✗ Auto-update failed …`, issue #360), and every line under a spinner up to the
  next `●` or `❯` line (a tip wraps). Each was found live; expect more after a Claude Code upgrade.
  The update notice never blocks a job: a running job keeps its Claude, and the next job starts on
  the new one.
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

> **The gh side of this phase is removed (issue #359):** no gh source, no `enabled: auto`, no gh→app
> switch. The App adapter stays as the `github-app` source.

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
| phase-3 fields (`authors`, `label`, `repos`, `projectErrors`, `repoErrors`, `checkErrors`, `permanentErrors`; `skippedClaimedWithoutJob` until issue #440 replaced it with `intake`) | yes | yes |

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

- `issues: write` now covers only labels (write criteria).
  Reading which pull request closed an issue needs nothing more (verified against the live app,
  2026-10-04). The open pull requests that close an issue (the done-check, "Done is a pull request") are read
  the same way, over GraphQL with the installation token; not yet verified against the live app. The
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
question reaches the owner (questions never go onto the issue), and when intake stops (issue #358). Not a
**Webhook subscription**: no store row, no schema change, no domain event; in-memory only.

- Events: `question.escalated_to_human` (issue #481: once per question that reaches the human; never a level
  hop or a re-notification, so never `question.escalated`, which other consumers keep); `source.stalled`
  (body adds `sourceName`, `error`, `since`) and `connected_account.expired` (body adds `provider`,
  `account`, `reason`); `artifact.created` (issue #673: body adds `artifactId`, `title`, `type`, `size`, `issueUrl` and
  `url`, the artifact's stable URL under the user's link base — `NotifierEvents.artifactUrl`). Never `job.finished` or
  `job.failed`.
  A Grok Bot routine reached through a **Webhook subscription** instead subscribes to
  `question.escalated_to_human` only, by name, for the same one post per question.
- Config (issue #378): the instance's options `urlEnv` and `keyEnv` (default `GROKBOT_WEBHOOK_URL`,
  `GROKBOT_WEBHOOK_KEY`) name two runtime secrets ("Secrets"): the variable, or the mounted file the
  variable `<name>_FILE` names, both with the user's **secret prefix** (`HOPPER_USER_<ID>_` for every user
  signed in with GitHub; empty only for the default admin account), so a user's routine is
  `HOPPER_USER_<ID>_GROKBOT_WEBHOOK_URL` and `_KEY`. Read at each use: once the `_FILE` variables are in
  the runtime, the files can be written, or the key rotated, without a restart. Detection, its command
  and the test event name the variables as the runtime reads them (`PluginContext.secretName`). Missing
  or a named file not there yet: needs-setup, and nothing is sent. (Before issue #378 this section
  described an `envFile` option the plugin never had.)
- Open questions (issue #378): a question escalated while the routine is not configured is not lost.
  The notifier checks every 5 s; when the routine **becomes** configured it sends each question open at
  the human, once each (`offered: true`). Configured already at start: nothing is re-sent on a restart.
  The UI's **Send open questions** sends every open one again, on each press.
- Request: `Authorization: Bearer <key>`, JSON body `{ source: 'hopper', kind, at, jobId, issueTitle,
  issueUrl }` (title/url from the job's source ref, else null); a question's `kind` is
  `question.escalated_to_human` (issue #481; `question.escalated` before) and it adds `question` (the agent's Markdown
  source, as written, and `questionFormat: 'markdown'`, issue #569), `questionId, answerUrl?` and what the job already
  knows, so a receiver can route and rank it without calling back
  (issue #378): `machineId`, `machineName`, `laneId` (the question's raising machine, issue #485; null when it has
  none), `priority`, `labels` (the item's labels at intake; null for jobs
  taken before), `repo`, `issueNumber`, `detectedBy`, `askedAt`, `escalatedAt`, `openSeconds`,
  `offered`. 200 = a run started.
- Test event (issue #378): **Send test event** in the UI (`POST /ui/api/notifiers`, `action: test`)
  posts `{ source: 'hopper', kind: 'question.escalated_to_human', test: true, at, message }` once (issue #481:
  a question's kind, so the receiver routes it as a real one; `test: true` marks it), no retry, and answers the
  HTTP status. A notifier offers its actions in GET /api/plugins (`actions`); a custom notifier offers
  one by having the optional `test` or `sendOpen` member (`Notifier`, ports.ts).
- Delivery: 10 s timeout; 3 attempts, backoff `base * 2^(n-1)` (base 1000 ms), retried only on
  network error, 429, 5xx; other non-2xx is final. Success logs kind, jobId, status; final
  failure logs an error. The key is never logged. Work runs deferred, off the event listener;
  `stop()` unsubscribes and awaits in-flight posts.
- `createGrokBotNotifier({ name, routine, logger, clock, baseMs?, timeoutMs?, watchMs? })` → `Notifier`;
  the job, the question and the open questions come from the `NotifierEvents` feed.
  `AppSeams.grokbot` (`baseMs`, `watchMs`) lets tests shorten the backoff and the check.

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
| `executor` | `Executor` (unchanged) | 1..n | `herdr-claude`, `test` | live (since issue #142) |
| `job-source` | `JobSource` (unchanged) | 0..n | `github-account`, `github-app` (`github-gh` removed by issue #359) | live (since issue #356) |
| `machine-source` | `MachineSource` (unchanged) | 1 | `local` | live (since issue #18) |
| `usage-source` | `UsageSource` (unchanged) | 0..n | none in production; `fake` stays a test fake at the `ports.ts` seam | live (since issue #356) |
| `notifier` | `Notifier { name; start(events); stop() }` (new) | 0..n | `grokbot-routine` | live (since issue #356) |
| `vault-backend` | `VaultBackend { name; check(reference); read(reference) → value }` (issue #585, "Vault backends") | 0..n | `hashicorp-vault`, `1password`, `bitwarden` | live |

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

**Fixed answers first** (issue #629, `src/questions/fixed-answers.ts`). Before Jev first and the levels, a question whose
answer the facts fix is answered without a model, and Jev and the levels are not asked:

- **Allowed dialogs.** A permission dialog read off the screen (`detectedBy: blocked`) that asks to edit
  (`Edit file`, `Create file`, `Write file`, `Overwrite file`) or read (`Read file`) one file, where the file is inside the
  job's work tree (`job.workTree`; a relative path is taken from it; `..` is resolved; a path under `~` never is) and a
  file the dialog's question names is that file: answered with the number of its `Yes` option — never a "Yes, allow all
  … during this session" option. No work tree reported, or anything the parser does not recognise: not answered here.
- **Reused answers.** A question a person already answered (`answeredBy: human`, status `answered`) on the same item —
  this job, then each job it runs again by `rerunOf`, up to 20 — with the same text, case and spacing aside and a
  countdown (`1:59`) aside: answered with that person's newest answer.

The risk rules run on the question and the fixed answer, as on a level's: a hit sends the question to the owner, the
fixed answer on the trail as a recommendation. The attempt is `tier: fixed`, `role: fixed`; `question.answered` names
`by: fixed`. A question no fixed answer fits goes on to Jev first and the levels as before.

1. Each level gets the full request — question, job prompt, goal, rules file, the trail so far
   (earlier runs, and the levels below with their recommendations) and its place,
   `level: { number, of }` — and replies `{ answer?, escalate, reason, confidence? }`. `answer` is its best
   answer: the exact text to type. `escalate: false` **answers**. `escalate: true` sends the
   question to the next level up, its answer staying on the trail as its **recommendation**: the
   next level sees it, and the UI's **Use answer** sends it as the owner's answer in one click, by the
   same route as Send answer (issue #459).
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
3. **Auto-answer** (issue #632, `src/questions/auto-answer.ts`) decides whether the answer goes into
   the job with no person. In order: the consequential guard (`src/minor-decisions/guard.ts`:
   permissions, a machine the blast-radius gate keeps) and a high-priority job send the question to a
   person; with auto-answer off, the answer is only a recommendation and a person answers; a
   `confidence` (`low`, `medium`, `high`) below the threshold sends the question to the next level, or
   from the top level to a person. No confidence meets no threshold. The settings are the user's
   (`autoAnswer`, default on at `high`), read at every question, changed at `POST /ui/api/auto-answer`
   (`auto_answer.settings_changed`) and shown in Settings → Question gates.
4. Accepted → the answer is typed into the pane; `answeredBy` names the level, and `question.answered`
   carries `auto: true` and the confidence. Past the top level, or with no levels → the human.

**Why a question came to a person** (issue #679, `src/questions/escalation.ts`). When a question reaches the human
stage, it keeps `escalation`: `reason` — `guard` (a risk rule or the consequential guard held an answer back on
purpose; `guards` names each, with what it catches), `low_confidence` (the top level was below the threshold),
`no_answer` (no level gave an answer: it failed, gave none, or there are no levels), `frontier_escalated` (the top
level sent it up), `high_priority`, `auto_answer_off`, or `fork` (it waits for a fork's result) — and
`recommendation`, the last answer on the trail (who, what, how sure). The question card says it in one sentence at
the top, with what the level recommends; Use answer names the level (`Use Fable's answer`). The Questions list
filters by reason, with counts; `GET /api/questions?reason=` and `hopper question list [--reason]` do the same. A
question sent to a person before this has no `escalation`; the card says the reason was not recorded. Attempt
reasons no longer end in "(no rules yet)"; the rules view says when there are none.

**Correcting an auto-answer** (issue #632). A person may correct a level's answer that went into the
job (`POST /ui/api/questions/:id/correct`, Settings → Question history): the question's answer is the
person's now, `corrected` keeps the level, its answer, when and by whom, and `question.corrected` is on
the trail. The job keeps the correction (`pendingCorrection`) and gets it ahead of whatever it next
resumes with (`withCorrection`, `src/engine/answers.ts`): its next question's answer, a review brief,
or a parked job's re-queue. A running job gets it at its next stop; to give it at once, park the job
and re-queue it. A job that ended cannot get one, and the route refuses it. The **agreement stats**
over the last 30 days — the auto-answers, the corrected ones and the share kept — are in
`GET /api/question-gates` `autoAnswer.stats`, so the threshold can be tuned.

**The ladder.** Rules, Jev, then the escalation levels, then a person. Jev first takes a question that
lists its options (issue #550); the levels are pluggable and their order is the plugins config's, moved
in Settings → Question gates; an install adds levels where it wants them. The built-in ladder is one
level, the frontier model (issue #632): a lower Opus level gave answers like the Fable level's, at more
cost and time. Tenant migration 33 (`src/store/migration-no-opus-level.ts`) drops the Opus level from a
stored config that still holds exactly the old built-in pair (`claude-cli` on `opus`, then on `fable`),
and moves an open question at it to the Fable level; any other set of levels stays.

**The model that ran.** Each level attempt records `model`: the model id the level reports it
ran — for `claude-cli`, the keys of the CLI's `modelUsage` (`fable` → `claude-fable-5-1`) — else
the configured alias. The trail shows whether a level is really the model it names.

`claude-cli` runs locked down (`--tools ''`, `--strict-mcp-config`, `--setting-sources ''`,
`--json-schema`). Built-in level: `level-1` (`claude-cli`, model `fable`).

**A level is named as a level, never after a model** (issue #209). The built-in levels were `opus`
and `fable`, and kept those names when their model option changed: the UI titled a level `fable`
that ran Sonnet. The model a level uses is only its `model` option. The plugins config refuses a
level whose name is a model name (`isModelName`, `src/domain/plugins.ts`: a Claude model alias or
id, or the level's own `model` option). Tenant migration 5 (`src/store/migration-level-names.ts`)
names each stored level named after a model `level-<its place>` (a taken name gets `-2`, …), plugin
and options kept, and moves an open question at that stage to the new name; a question's trail is
history and keeps the names it was written with.

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
  only), `output(bin, args, input)` (all of stdout, `input` on stdin, same timeout), `exists(path)`,
  `pythonImports(python, module)`, `env(name)`. (`github-gh` reported `needs-setup` when `gh auth
  status` failed; that source is removed, issue #359.)
- **Option choices** (issue #151) `choices(sys)` → `{ [option]: { value, label?, description? }[] }`:
  the values an option may take, read from the system with the same kit and limits as `detect`. Run
  at start and on rescan; reported per plugin in `GET /api/plugins` `plugins[].choices`; the UI offers
  them as a select instead of a typed value, and a configured value not listed stays shown as
  "not listed here". Absent, empty or throwing → the option is typed. `claude-cli` (`model`) and
  `gate-router` (`model`) list the models of the `claude` on PATH (`claudeModels`,
  `src/plugins/claude-print.ts`): one stream-json `initialize` control request on stdin, answered
  with the models the account can use (alias, name, description); no prompt, so no model call. Only
  the default `claude` is asked, not an instance's own `bin`: the list is per plugin.
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

**Superseded by issue #198** ("Config in the database: no config files"): the plugins config is the
config record `plugins`, a JSON value in the database, edited in the UI. The shape below is unchanged,
but for its `github` (github-gh) instance: removed by issue #359, tenant migration 14.

The truth for which instance fills which role. Mode 600, owner-editable, mtime-watched (5 s).
Every role is live since issue #356 ("Every setting applies without a restart"): the router, queue
sorter and escalation levels swap between calls; the list roles keep an unchanged instance and build a new
or changed one. No role shows `changed — restart pending` any more.

```yaml
version: 1
router:    { name: gate-router, plugin: gate-router, options: { jevPath: ~/workbench/jev-src/grok-bot-jev, python: python3, model: haiku } }
escalationLevels:   # lowest first; above the top level is the owner
  - { name: opus, plugin: claude-cli, options: { model: opus } }
  - { name: fable, plugin: claude-cli, options: { model: fable } }
executors: [ { name: herdr-claude, plugin: herdr-claude, options: { cwd: ~/workbench/app-workflows } }, { name: test, plugin: test } ]
jobSources:
  - { name: github, plugin: github-gh, options: { enabled: auto, bin: gh, appFile: ~/.config/hopper/github-app.json, authors: [owner], label: hopper } }
  - { name: github-app, plugin: github-app, options: { appFile: ~/.config/hopper/github-app.json, authors: [owner], label: hopper } }
machines:  { name: local, plugin: local, options: { lanes: 4 } }
usageSources: []
notifiers: [ { name: grok-bot, plugin: grokbot-routine, options: { urlEnv: GROKBOT_WEBHOOK_URL, keyEnv: GROKBOT_WEBHOOK_KEY } } ]
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

**Amended by issue #198** (owner decision, 2026-10-05): command-bearing options are edited in the UI
like any option (admin only); the 409 below is gone. "Config in the database: no config files".

**Command-bearing options** (owner decision, 2026-10-03, issue #6 option (a)): an
option that names a program, its arguments, a working directory, an interpreter, or a file
that is sourced or executed — `bin`, `args`, `cwd`, `python`, `jevPath`, `claudeBin`, `envFile` and their
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
- applies like a file edit: every role is live (issue #356), in place before the answer.

Per piece, in the words of issue #6: "task" is an **executor** instance ("task" is not a
glossary word); "connector" is a **job source** or **notifier** instance; a **lane** has no
options of its own — lane count is the **machine** instance's `lanes` option.

Residual risk: a session holder can still change non-command options — a router's
thresholds, an escalation level's model or the levels' order, a source's labels. Each can change which jobs are pulled or how a question is answered; none can run a
command, and the levels' fail-closed contract and the risk rules (code, not options) still stand.

### Failure

| role | on create failure or unavailable |
|---|---|
| router | `pass-through`; advice `source: fallback`; `/api/health` says `fallback: true` (also while the router's own advice is `source: fallback`) |
| escalation level | stays in its place and escalates every question it gets (`/api/plugins` `escalationLevels[].active: null`, `reason`); fail safe: a broken level never answers and never hides the levels above |
| executor | jobs naming it `held`, reason `executor <name> unavailable`; never failed or re-routed |
| job source / notifier | dropped; error in `/api/plugins` |
| vault backend | dropped; error in `/api/plugins` and on Settings → Vault; a vault secret kept in it is refused at delivery, saying why |

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
  depends on its `jevPath` and `python`. The catalogue in `/api/plugins` detects each plugin
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
  `idleNudgeMs` (20000; `idleQuestionMs` before issue #163, renamed by tenant migration 2). Detection: `which bin`, then `which claudeBin` — never `--version`,
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
  `args`, `cwd`; claude-cli `bin`; gate-router `jevPath`, `python`. zod
  carries the mark into `z.toJSONSchema()`; `/api/plugins` shows it. `session` is not marked (it
  names a herdr session, not a program).
- **Tests:** `AppSeams.herdr` swaps the herdr-claude built-in for `herdrClaudePlugin(seam)`
  (detection `available`, the seam client driven); `AppSeams.executors` still register after the
  plugin-built ones.
- **No store migration.** Instance names default to the old executor names (`herdr-claude`,
  `test`), so stored `spec.executor` values keep working. `DecisionInputs.unavailableExecutors` is
  new: Decisions stored before this slice lack it (read-only history; nothing replays them).

### Settled in slice 4 (2026-10-03)

> Everything below about github-gh (its detection, pause, `bin`, `appFile`) is history: the source is
> removed by issue #359.

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
  `rerunnable`, `rejections` (issue #387); `RoleContext['machine-source']` = `executors()` (asked on every list, so
  seam executors registered after the host count); `RoleContext['usage-source']` = `machine(id)`
  (issue #139).
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
| `HOPPER_ROUTER_MODE` | *Removed by issue #211: there is no router mode.* |
| `HOPPER_SOFT_LIMIT` / `HARD_LIMIT` | `0.7` / `0.95` — the defaults: the usage limits set on the Usage view win ("Usage limits", issue #522) |
| `HOPPER_BURN_WINDOW_HOURS` | `18` (0: off) — "Usage pacing" (issue #373) |
| `HOPPER_RESET_AWARE_PLACEMENT` | `true` — "Usage pacing" |
| `HOPPER_CRITICAL_PRIORITY` | `100` (0: off) — "Usage pacing" |
| `HOPPER_ROUTER_CHEAP_BOOST` | `10` |
| `HOPPER_WEBHOOK_BASE_MS` | `1000` |
| `HOPPER_LANE_IDLE_GRACE_MS` | `5000` |
| `HOPPER_ANSWER_TIMEOUT_MS` | `180000` — the question service's per-stage ceiling |
| `HOPPER_RULES_FILE` | `~/.config/hopper/rules.md` |
| `HOPPER_HUMAN_RENOTIFY_MS` / `HUMAN_TIMEOUT_MS` | `900000` / `86400000` |
| `HOPPER_RESUME_BOOST` | `20` |
| `HOPPER_MAX_QUESTIONS` | `5` |
| `HOPPER_KEEP_PANES` | `false` |
| `HOPPER_RECONNECT_GRACE_MS` | `120000` — issue #368: after a restart, how long a running job waits for its machine to answer before it fails ("Recovery at startup") |
| `HOPPER_DONE_RECHECK_MS` | `60000` — issue #637: a job that ended done whose source finds it not done is asked again after this long (GitHub's lag) before it fails; `0`: at once ("Done is a pull request") |
| `HOPPER_LOCAL_MACHINE` | `true`: this host may be a machine, though a fresh plugins config lists none (issue #259); `false` in the image: the container is not a machine, and the boot removes a `local` one (issue #141) |
| `HOPPER_WEBHOOKS_FILE` | `~/.config/hopper/webhooks.yaml` |
| `HOPPER_UI_SESSION_HOURS` | `12` (no longer read since issue #439: "Session lifetime") |
| `HOPPER_PLUGIN_DIR` | `~/.config/hopper/plugins` |
| `HOPPER_PLUGINS_FILE` | `~/.config/hopper/plugins.yaml` |
| `HOPPER_AUTH_FILE` | `~/.config/hopper/auth.yaml` (issue #39, "Sign-in: realms") |
| `HOPPER_PUBLIC_URL` | unset (issue #39) |
| `HOPPER_UPDATE_CHECK_MS` | `60000` — self-update check interval; `0` is the default, never off ("Self-update") |
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
  Schema (string, number, boolean, enum, string list, else JSON; a select of the option choices
  where the plugin lists them); restart roles show `changed —
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
  - { name: laptop, plugin: ssh, options: { ssh: user@laptop, lanes: 2 } }
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
| `herdr` | `true` | it runs herdr. `false` (issue #142, "Cursor executor and machine defaults"): online while it answers over ssh (`true` there), herdr-claude refuses it; `session` unused |
| — | — | **no herdr binary** (issue #311): every call runs `PATH="$PATH:$HOME/.local/bin" exec herdr …` there (`REMOTE_PATH`, `src/executors/ssh.ts`). An ssh command's shell is not a login shell, so `~/.local/bin` (where herdr installs) is often not on its PATH; naming it in the command also survives the race that once lost a call its PATH (the shell env file a new pane's shell rewrites; `zsh:1: command not found: herdr`, exit 127, seen live). `herdrBin` is refused |

**Reaching it** (authentication: "Target authentication" below; the argv here predates it). `createHerdrCliClient({ ssh: { target, controlDir } })` runs the same herdr argv as
`ssh -F ~/.ssh/config -o BatchMode=yes -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPath=<dataDir>/ssh/<16 hex>
-o ControlPersist=60 -- <target> '<argv, POSIX single-quoted>'`. `-F` names the user's config only
(`/dev/null` when there is none): under the hopper unit (PrivateTmp, so a user namespace) the
root-owned files in `/etc/ssh` look foreign-owned and ssh refuses them ("Bad owner or permissions",
seen live 2026-10-04, issue #58), as the self-update mirror found before. The remote login shell must read
POSIX single quotes (sh, bash, zsh; not fish). One shared connection per target (the probe and every
job share it). ssh's own failure (exit 255) is `HerdrError` code `ssh`; herdr's JSON errors come back
as they do locally. A unix socket path is capped at 104 bytes (macOS; 108 on Linux), and ssh adds 17
characters to it while it sets the master up. ssh's own `%C` (40 hex) did not fit under a signed-in
user's data dir (`<work dir>/users/<id>/ssh/`: every ssh machine offline with "too long for Unix domain
socket", issue #295), so the socket is 16 hex of a hash of `user@host:port`; a control dir too long even
for that shares no connection rather than fail.

**Online.** `herdr --session <session> status server` over ssh says `status: running`. Probed in the
background at most every 30 s; `list()` never waits, so a machine that is off or asleep never stalls
a Decision (every Decision awaits every machine source). Offline until
the first probe answers. Transitions are logged once per reason (`hopper: attached machine
laptop online (ssh laptop)` / `… offline: <reason>`). Offline → the decider gives it nothing; a
waiting-answer job whose pane is there stays pinned (`resumeOn`) and waits.

**Executors are told the machine.** `ExecutionContext.machine` is the lane's `MachineSnapshot`
(`ssh` and `herdr { bin, session }` on an attached one); the runner looks it up per run. herdr-claude
drives that machine's herdr and records `ssh` and `session` in its pane state, so resume,
reattach and cleanup (which have only the job) reach the same herdr. Pane ids are per herdr server:
held panes are keyed by machine and pane. An executor that cannot run elsewhere is simply not listed
in the machine's `executors`.

**A machine's disk** (issue #401, `src/machines/disk.ts`). Jobs filled one machine's home: clones, installs
and test temp dirs piled up until nothing could be written. So every machine whose disk can be read
carries it on its snapshot, `MachineSnapshot.disk` — `{ freeBytes, totalBytes, low }` for the filesystem
its home is on, where the jobs directory and the scratch dirs live. This machine's is read with
`statfs` at every list; an ssh target's in its probe (`df -Pk "$HOME"`, before the home it prints); a
client target's by its client, in its `/release` answer (a client older than this says none). A container
target has none. It is **low** below 5 GiB free or below a tenth free, whichever comes first — the
machine's own thresholds (issue #410): the `local`, `ssh` and `client` machine-source options
`diskLowBelowGiB` (default 5) and `diskLowBelowPercent` (default 10). The source judges each reading
by the thresholds as they are at that list, so a change in Plugins applies at the next Decision. The
Machines view shows it on each card ("disk (home)", and a `disk low` badge), and the Overview's
Attention panel lists each machine running low, once per machine. **A machine whose disk is low takes no
new job** (issue #410, the decider's `fits`, `src/decider/assign.ts`): a job goes to another machine
that runs its executor; when none can take it for that reason alone, it is held with the reason
`disk low on <machine> (<n> GiB free), …: no new job is claimed there` (pinned: `pinned machine <machine>
disk low (…)`), which the queue shows under the job. A job resuming on the machine (an answered
question) returns to its pane as before, and running jobs go on. The reap ("Work tree") is what keeps
the disk flat; this keeps new work off a machine it could not keep flat.

**A lane shows its machine and its work tree** (issue #166). `lane-1` is on every machine, so a
lane is never named by its number alone: the UI names it `<machine label> (<machine id>) · lane-<n>`
(the id once when it is the label; `ui/src/model/board.ts` `laneName`), since labels can repeat and ids
cannot. An executor with a work tree reports it once resolved, `ExecutionContext.workTree(path)`, and
the runner keeps it on the job (`job.workTree`); the lane running the job shows that path. The
command executor has none and reports none. Every place that names a lane uses `laneName` — the lane board, the lane
timeline, a Decision's starts, the event lines — and a machine, `machineName`.

**Working directories resolve there.** A job's `cwd` (payload, or the instance's `cwd`) must exist on
the attached machine; a `~` in it is that machine's home, never this one's (issue #323, "Work tree"). A
cwd the machine cannot use fails the job at its scratch command, at once.

**Preparing a machine:** `bash scripts/attach-machine.sh <ssh-target> [lanes]` — checks herdr and
claude there, installs `systemd/hopper-herdr.service` there, `enable --now`s it, warns without
linger, confirms the session runs, and prints the plugins.yaml lines to set (no herdr path: herdr is
looked up there by name, as every call finds it, issue #311).

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
| `session`, `hostKey` | — | refused (unknown options of `docker`): it has no herdr |

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

**Where commands may run.** The command executor runs anything written in an issue assigned to the user (issue #387),
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
| client target | an HMAC of the **client token** on every request — the token derived from the link keys (issue #308) | an HMAC of the token on every answer; the same token on its dial-in | an unsigned, stale (30 s), replayed or altered request; an answer it did not sign; a dial-in no client target's key signs |

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
must not be able to read it); none set, the hopper's own key (issue #293, "Machines with no durable
~/.ssh"), then (issue #260) the key files `ssh -G` names for the target that exist, as the user's own
`ssh` would offer them. The known_hosts file holds one line per ssh target, written from each
machine's `hostKey` whenever plugins.yaml changes; a machine without one, or two machines pinning
different keys for one target, is never connected to (logged once). A target name is a plain name
(`[A-Za-z0-9_.-]`, optionally `user@`). On the target the key is installed with `restrict` (no pty, no
forwarding): `HOPPER_SSH_KEY_FILE=<key> bash scripts/attach-machine.sh <target>` adds it once and
prints the entry with its `hostKey` — the key the user's own `~/.ssh/known_hosts` holds for the
target, never one learned from a connection. Adding a machine from the UI pins the same way
(`resolveSshTarget`), or (issue #293) pins the host key the person confirmed from its fingerprint. The target's own
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

**Since issue #308 the client dials in to the hopper's own URL and joins with a join code ("Joining a
machine"):** the tunnel, the relay, `tokenEnv` and `scripts/attach-client.sh` below are gone. The signed
calls are as described here.

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
| `session`, `hostKey` | — | refused (unknown options of `client`): the client names its herdr itself, and its tunnel pins the keys |

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
`POST /claude {args, timeoutMs}` → `{code, stdout, stderr}` (issue #366): the client runs its own
`claude` (on its PATH; `ClientOptions.claudeBin`) for `claude-plan`'s usage read — exactly
`-p /usage --output-format json --no-session-persistence` or `auth status --json`, any other argv 400 —
with no shell, stdin closed, in a fresh `mkdtemp` dir removed after with the project dir claude keeps for
it. Zero turns, zero tokens: a signed call can read the machine's usage and account, never start a prompt.
`POST /level {model, effort?, jsonSchema, prompt, timeoutMs?}` → `{code, stdout, stderr}` (issue #482): an
escalation level's run ("Question pipeline", "The machine that answers") — the client's claude in print
mode, the argv built by the client from those fields alone (no tools, no MCP, no settings, no session),
the prompt on stdin, the same fresh dir and cleanup, killed at the timeout (at most 15 minutes) with exit
124; a model that is not an alias or id, an unknown effort, a schema that is not an object or an empty
prompt is 400 and claude never runs.

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

## Job shapes: sandboxed and operator-led (issue #316, 2026-10-06 — owner direction)

Owner direction, for the sandbox work (#314, #308, #315): container sandboxes (Podman or Docker) are the
primary, enforced path; and some jobs are done by hand in Cursor or a like IDE, not in a container. The
hopper supports both. A container is never taken to be the only shape a job has.

| Job shape | Who does the work | Where | Isolation | Check-in |
|-----------|-------------------|-------|-----------|----------|
| **Sandboxed** (primary) | an executor the hopper runs | a **container sandbox**, Podman or Docker | enforced by the container | the closing pull request |
| **Operator-led** | a person, or an IDE agent they drive | the operator's own IDE and work tree | the operator's; the hopper enforces none | the closing pull request |

**What follows, for every change after this one.**

1. **Both shapes are first-class.** A change that makes a container the only way a job is claimed, run
   or completed breaks this direction. So does one that makes operator-led work a hack beside it.
2. **Enforcement belongs to what the hopper runs.** The sandbox confines the jobs the hopper dispatches
   to an executor; it never reaches into an operator's IDE. An operator-led job runs nothing of the
   hopper's, so there is nothing to confine — and nothing to wait for but its source.
3. **One check-in for both.** The closing pull request being done ("Done is a pull request").
   No shape has its own gate, and none needs a hopper IDE plugin ("Work by hand in an IDE: how it checks
   in", settled there).
4. **One claim per issue, either shape.** `hopper:claimed` holds an issue against dispatch whichever shape
   claimed it: an operator-led claim has no lane and no executor, so the decider never sends the same
   issue to a container. Released, the issue is the queue's again (#318).
5. **Podman and Docker alike.** A container sandbox names a container engine by its socket, as a container
   target names its docker socket ("Target authentication"); nothing may assume one engine's CLI only.
   The deploy already runs on either (`docs/deploy.md`).

**Today, against the direction.**

| Part | Stands | Carried by |
|------|--------|------------|
| Container sandbox for agent jobs | built as the **sandbox box**: a person runs the Add machine line, the box joins as a client target and an instance of a template, and its jobs get only what that template is approved for ("Joining a machine", "Templates"). Not built: the hopper does not start or stop a box itself ("Joining a machine", option B), and the box's egress is open | #308; mechanisms compared in #315 |
| Work tree never the home root | enforced at job start: a work tree that is the machine's home, above it, or `/` fails the job; the default is the jobs directory `~/hopper-jobs` ("Work tree" → "Never the home") | #314 |
| Operator-led claim and its timeline designation | built: claimed in the UI (status `operator_led`, event `job.claimed_by_operator`), its own `operator-led` row on the lane timeline ("Operator-led work") | #318 |
| Operator-led progress | protocol settled and seen end to end (the pickup record), not read by the daemon | #319 ("Pickups on agent boxes") |
| Operator-led check-in | built: the closing pull request, as for any job | — |

**Not built here.** This section records the direction and what it binds; no daemon change. Each row above
lands with its own issue, test first.

## Agent boxes (issue #295, 2026-10-06; no catches since issue #307)

Owner request (#295): for testing, containers that run codex, cursor, omp, opencode and the like, all
attached — the hopper attached to every one of them, and the owner able to open a terminal in each.
Owner, on the first container deploy (#307): "No catches. All boxes must interop seamlessly and easily":
every box attaches to the hopper in its container and runs jobs, with no step by hand, and stays so across
re-runs and rebuilds.

An **agent box** is a container on this machine's docker with one agent CLI in it — `claude`, `codex`,
`cursor` (`cursor-agent`), `omp`, `opencode` — that is an ordinary **ssh target**: it runs sshd and its
own herdr session `hopper`, so the hopper attaches it like any machine over ssh (not as a container
target, which runs no agent and no herdr), and it runs the jobs of its agent's executor. The boxes are a
script and an image; they reach the hopper through the plugins config.

`bash scripts/agent-boxes.sh [--sign-in] [--remove] [--check] [agent...]` (no agent: all five). One command, safe to
run again: each run puts every box back as it should be. Per box `hopper-box-<agent>`
(`HOPPER_BOX_PREFIX` changes the prefix):

- **The hopper is found, not described.** In order: a hopper installed on this host when its database is
  named (`HOPPER_DATABASE_URL` or `HOPPER_DATABASE_URL_FILE`, and its install, `HOPPER_APP_DIR`); else the
  running container of the compose service `hopper` (`compose.yaml`; `HOPPER_CONTAINER` names another,
  `HOPPER_CONTAINER=` none); else none, and the boxes are made alone. For the container the script uses
  `docker exec <hopper> hopper …`: the operator CLI where the hopper runs, with the database it already
  holds — no database reachable from the host, no host install, no ssh config. `HOPPER_USER` names the
  hopper's user when it has several.
- **Image** `hopper-box-<agent>` from `scripts/agent-box/Dockerfile` (`node:24-bookworm-slim`, build argument
  `AGENT`): the agent CLI outside the home (npm, bun for omp, Cursor's installer for cursor), GitHub's CLI
  `gh` with git asking it for github.com credentials (so a job's `GH_TOKEN` clones and pushes) and a box
  identity for commits (`hopper agent box`), and this machine's herdr binary (`HOPPER_BOX_HERDR`, else
  `command -v herdr`) at `/usr/local/bin/herdr`. The login user `agent` has no password and is not
  locked; sshd takes keys only, `agent` only, no root.
- **Container**: `--restart unless-stopped`; with a hopper in a container, on **the hopper's network**
  (its compose network, `hopper_default`), where the hopper reaches it by name, `agent@hopper-box-<agent>`,
  port 22; sshd also published on `127.0.0.1` at a **fixed port** (`HOPPER_BOX_PORT_BASE`, default 2220,
  + 1 claude, + 2 codex, + 3 cursor, + 4 omp, + 5 opencode), so its Host and known_hosts line hold across
  restarts (#319's finding: an ephemeral port moved at each start). The home is the volume
  `hopper-box-<agent>-home` — the agent's sign-in lives there and outlives the box. Its main process is the
  herdr session. A box whose image changed, or not published at its port, is started again; one that left
  the hopper's network is joined to it again; a running one is kept.
- **Who gets in**: written into the box through docker — the hopper's key with `restrict`, as
  `scripts/attach-machine.sh` installs it. The key is the hopper's own, asked of it (`hopper ssh-key`,
  "Operator CLI"); with no hopper found, its file (`HOPPER_SSH_KEY_FILE`, made when missing) or its public
  line (`HOPPER_SSH_PUBLIC_KEY`, as the Add form shows it). The user's own public keys (`~/.ssh/id_*.pub`)
  unrestricted, for a terminal there (`ssh -t hopper-box-<agent>`, `herdr --remote hopper-box-<agent>
  --session hopper`).
- **ssh, for the person**: a `Host hopper-box-<agent>` (HostName `127.0.0.1`, its Port, User `agent`) in
  `~/.ssh/hopper-box.config`, rewritten from the running boxes on every run and Included first in
  `~/.ssh/config`; the box's host key in `~/.ssh/known_hosts` for `[127.0.0.1]:<port>`, read from the box
  itself through docker — the source, never a connection ("Target authentication"). A hopper installed on
  this host reaches the box through that Host; a hopper in a container never reads it.
- **Checked**: its herdr session answering `running` — over ssh as the hopper would reach it when the
  hopper's key file is here, else in the box through docker; and, for a hopper in a container, the box's
  port 22 reached from the hopper's container by the box's name.
- **Attached** on every run when a hopper is found: each box an `ssh` machine instance named after it
  (`ssh`: `agent@<box>` for a hopper in a container, the Host for one on this host; `herdr: true`,
  its `hostKey`; herdr is on the box's PATH, issue #311) through the operator CLI (`hopper config get|set
  plugins`, against its version; the daemon's 5 s watch follows it, no restart), filtered by
  `scripts/agent-boxes.ts`. A box runs **its agent's executor** — claude `herdr-claude`, cursor
  `cursor-agent`, codex `codex`, opencode `opencode`, omp `omp` ("Print-mode agent executors") — the
  config's instance of that plugin, switched on (an instance named after the plugin) when there is none.
  Attached again, a box keeps its lanes, executors and label and takes its new connection; one left with
  no executors takes its agent's again. A machine of another plugin under a box's name is refused.
- **Sign-in**: the summary says which agents are signed in. `--sign-in` runs, at this terminal, each
  unsigned agent's own sign-in in its box — `claude auth login`, `codex login --device-auth`,
  `cursor-agent login`, `omp login` (a link or device code, opened on any device) — kept in the box's home,
  so a rebuilt box stays signed in. opencode needs none: it runs its own free models unsigned. The
  hopper holds none of these credentials.
- **`--remove`**: the containers, their Hosts and known_hosts lines, and (with a hopper found) their
  machines. The home volumes stay.
- **`--check`** (issue #305): the proof that the hopper in its compose container and every box interoperate,
  changing nothing. In the hopper's container, ssh connects as the hopper does (`sshArgv`): its own key and
  the host key it pins for `agent@<box>`, both in its work dir; the box's herdr session `hopper` must answer
  `status: running` and its agent CLI (`cursor-agent` for cursor) its version. One line per box, exit 1 when
  any fails. It needs the compose container: a host install is checked by its Machines view.

**Why no sign-in is copied from this computer.** A CLI's sign-in is an OAuth refresh token; a copy
refreshed in a box can invalidate the original (Claude Code's own issue tracker reports a copied
credentials file failing instead of refreshing), and this machine's codex sign-in may route through a
local proxy a box cannot reach. Each box signs in once, in its own home, through the CLI's own flow.

**What runs there.** Each box its agent's executor; the job's GitHub credential (`GH_TOKEN`, issue #214)
reaches the agent's process, and gh hands it to git. A job's work tree is a path of the box: the jobs
directory `~/hopper-jobs` there by default. An executor instance whose `cwd` names a directory of
another machine (herdr-claude's, set for this computer) sends a job there that does not run; per-machine
work trees are #324's.

A `compose down` that removes the hopper's network takes the boxes off it: run the script again. A hopper
in a container on another computer is not served: the boxes are on this machine's docker.

**Residual risk.** The boxes reach the network (the agents need their APIs) and run whatever a job or
the owner tells their agent; they are not the container target's locked-down sandbox. sshd is published
on loopback only; on the hopper's network any container of it reaches the box's sshd, which takes keys
only. The hopper's key is restricted there; the owner's keys are not. codex runs with its own sandbox
off (`--dangerously-bypass-approvals-and-sandbox`): the box is the sandbox.

**Verification.** `test/scripts/agent-boxes-compose.test.ts`: against a stand-in docker that answers as a
compose deploy, a new box made on the hopper's network at its fixed port, a running one joined to it and a
moved one started again at its port, the box attached as `agent@<box>` running its executor through the CLI
in the hopper's container, the hopper's key asked of it, no hopper: the boxes alone; `--check` passing and
failing. `test/scripts/agent-boxes.test.ts`: the plugins-config filter (each agent's executor, switched on
when missing, kept when set); opt-in (`HOPPER_TEST_AGENT_BOX=1`: it builds an image with an agent CLI from
npm) a real codex box on the real docker, reached over real ssh with the hopper's key alone (no pty), its
herdr session running, attached to a test database through the operator CLI with its executor, kept on a
second run, then removed.

**Seen run (2026-10-07, this machine's compose hopper).** `bash scripts/agent-boxes.sh`, no flag and no key:
all five boxes rebuilt and made again on the hopper's network, attached, and online in the hopper's
Machines with their executors (`herdr-claude`, `codex`, `cursor-agent`, `omp`, `opencode`); `--check` ok for
each. A turn of each print-mode executor, run in the hopper's container over its own connection: opencode
(no sign-in) finished with its marker and wrote its file in `~/hopper-jobs`; codex, cursor and omp, not
signed in, failed at once with their CLI's own reason. A box made again gets a new host key (sshd's keys
live in the container, not the home): the same run pins it, and the hopper reaches the box again once the
plugins config is applied.

## Print-mode agent executors (issue #307, 2026-10-07)

Owner requirement (#307): every agent box runs jobs. Only Claude Code (`herdr-claude`) and Cursor's agent
(`cursor-agent`, issue #142) had executors; codex, opencode and omp had none. All three CLIs have a print
mode that answers in JSON, as Cursor's does, so they are built the way `cursor-agent` is, not in a herdr
pane (whose screen protocol parses Claude Code's TUI, "6d. Backends are configuration").

A **print-mode agent executor** runs an agent CLI in print mode on the job's machine — this one or an ssh
target, never a container or client target — in the job's work tree, one run per turn
(`src/executors/print-agent.ts`): the payload is herdr-claude's (`prompt`, `cwd`, `model`, `env`,
`timeoutMs`), the first turn's text the prompt and `protocolFooter(cwd)`, the job's credentials
(`GH_TOKEN`, issue #214 — which `cursor-agent` did not pass before) and `HOPPER_JOB_ID` and `TMPDIR` in
its environment. The last message's marker decides: `HOPPER_DONE` finished `{ machine, summary, chatId }`,
`HOPPER_FAILED <reason>` failed, `HOPPER_QUESTION` a question that pauses the job with `{ chatId, cwd }`
(the agent's session id, under the name `cursor-agent` already stored), no marker a status note nudged in
the same session at most three times in a row (issue #163). Not idempotent, nothing to reattach.

Like a herdr-claude job (issue #410, "Work tree"): its `TMPDIR` is the temp link to the job's own scratch dir
`<cwd>/.hopper-scratch/<job id>` (issue #506), the scratch dir named in the footer; each turn runs in the job's scope
`hopper-job-<job id>` where the machine has a systemd user manager (`systemd-run --user --scope … --
env … <agent> </dev/null`; the scope a turn before left is stopped first, since a print-mode turn never
waits on background work); the job keeps `{ cwd, ssh? }` from its start; and when it ends its `cleanup`
reaps it through the machine's connection — scope, processes, scratch dir — as the reap does. The sweep
reaches this machine and ssh targets through it.

Only the call and the reading differ (`src/executors/print-agents.ts`), taken from the real CLIs:

| executor | first turn | resumed | answer | its own error |
|----------|-----------|---------|--------|---------------|
| `cursor-agent` | `cursor-agent -p --output-format json --workspace <cwd> <args> [--model m] -- <text>` | `--resume <chat>` | one JSON result: `result`, `session_id` | `is_error` |
| `codex` | `codex exec --json <args> [--model m] -- <text>` | `codex exec resume --json <args> [--model m] -- <thread> <text>` | JSON lines: `thread.started` `thread_id`; the last `item.completed` `agent_message` `text` | `turn.failed` `error.message` |
| `opencode` | `opencode run --format json <args> [--model m] -- <text>` | `--session <id>` | JSON lines: `sessionID`; the `text` parts of the last message | an `error` event: `error.name`, `error.data.message` |
| `omp` | `omp -p --mode json --no-title <args> [--model m] -- <text>` | `--resume <id>` | JSON lines: `session` `id`; `agent_end`'s last assistant message, its `text` parts | `stopReason` `error`: `errorMessage` |
| `claude` | `claude -p --output-format json <args> [--model m] -- <text>` | `--resume <id>` | one JSON result: `result`, `session_id` | `is_error` |

A non-zero exit fails the job with the CLI's own error when it printed one, else its stderr. The CLI's stdin
is `/dev/null`: codex and opencode read a stdin that is not a terminal to its end before the turn, and the
pipe a run hands its child is never closed, so without it the turn never started (found on the agent
boxes).

**Claude Code in print mode** (`claude`, issue #533). The owner asked that headless interfaces be preferred where they fit,
for containers. Evaluated against herdr-claude: print mode shows no startup screen at all — no onboarding, no trust
dialog, no warning; checked live with 2.1.292 in an empty home, it answers its JSON result at once —, keeps session
resume (`--resume`, the job's session id, issue #510) and the hopper protocol's markers, so `HOPPER_QUESTION` pauses the
job and climbs the escalation levels as any print-mode question does. What it gives up is herdr-claude's: no pane to
watch or attach to, no reattach after a daemon restart, a turn never waits on background work, and permission
dialogs cannot be answered (default `args` `--dangerously-skip-permissions`, as yolo; in print mode nobody could
answer). So it is offered as its own opt-in executor for machines nobody watches (an ssh agent box, a container's
ssh target), and herdr-claude stays the default. The claude-plan usage source paces both (`executors` default
`herdr-claude`, `claude`).

Plugins `codex`, `opencode`, `omp`, `claude` (`src/plugins/executor/<id>/`, each defined by
`src/plugins/executor/print-agent.ts`, as `cursor-agent` now is): options `bin` (the CLI's name, on
`PATH`), `args`, `cwd` (the jobs directory) and `sshBin`, every one command-bearing. Default `args` run the
agent's tools without asking: codex `--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check`
(its sandbox would refuse the network a push needs; the machine is the sandbox), opencode `--auto`, omp
`--auto-approve`, claude `--dangerously-skip-permissions`. Opt-in, as `cursor-agent`: switched on in Plugins, or by `scripts/agent-boxes.sh` for the
box that runs it. Detection is `which` only and always `available`. Each agent signs in on the machine it
runs on; the hopper holds no credential of theirs. opencode runs its own free models with no sign-in.

**Verification:** `test/adapters/print-agent-executors.test.ts` (each CLI a stand-in printing the real
CLI's events and reading its stdin to the end as the real ones do: done, question and resume, failed,
status notes, the CLI's error, cancel, refusals),
`test/adapters/cursor-executor.test.ts`, `test/plugins/executor-plugins.test.ts`.

## Pickups on agent boxes (issue #319, 2026-10-06 — a spike)

Owner request: the agent boxes, against a test repo, fulfil a manual, interactive pickup session, and
report the pickup and how it stands, so the flow is seen end to end. Related: #318 (the claim of
operator-led work and its timeline designation), #316 (containers primary, plus work by hand in an IDE).

**The problem.** A job the hopper runs in herdr reports itself: herdr answers pane status, and the
executor turns it into `job.started`, `job.progressed`, a question, an outcome. Work a person (or an IDE
agent) does at a box by hand has no executor: nothing tells the hopper it was picked up, whether it is
moving, or that it stopped. GitHub sees only the end — the closing pull request.

**The protocol: the box keeps a pickup record, the hopper reads it.** The hopper pulls (repo law): a box
sends nothing and no route accepts a report. The box writes; the hopper reads over the ssh connection it
already holds to the box, as it reads herdr.

- **Pickup record** — one JSON file per issue in the box's pickup dir (`HOPPER_PICKUP_DIR`, else
  `~/.hopper/pickups/`, in the box's home volume, so it outlives the box), named
  `<owner>_<repo>_<number>.json`, written whole (temp file, then rename), so a read never sees half of
  one. Version 1:

  ```json
  { "v": 1, "issue": "https://github.com/<owner>/<repo>/issues/<n>", "mode": "operator-led",
    "state": "working", "pickedUpAt": "ISO", "updatedAt": "ISO",
    "workTree": "/home/agent/<repo>", "branch": "…", "pullRequest": "…",
    "history": [ { "seq": 1, "state": "picked-up", "at": "ISO", "note": "…" }, … ] }
  ```

- **States.** `picked-up` (the pickup), then any of `working`, `waiting` (on an answer), `blocked`,
  `pull-request` (names its pull request), and the two that end it: `finished` (the operator says the work
  is done) and `released` (handed back, not done). A status with nothing picked up, or after the pickup
  ended, is refused; an ended pickup is picked up again as a new pickup of the same record, its history
  going on. **`history`** keeps every state change with a `seq` that only grows (the last 50 kept): the
  reader polls, and a change between two reads is still seen, in order, once.
- **Heartbeat.** `updatedAt` is the box's last word — a change or a `beat`. A pickup not ended and not
  heard from past the stale time (the reader's `--stale`, 120 s by default) is **stale**: shown once, and
  once more when it is heard from again. An ended pickup is never stale.
- **The box's CLI**: `hopper-pickup pickup <issue url> [--work-tree] [--branch] [--note]`, `hopper-pickup
  status <issue url> <state> [--pull-request] [--branch] [--note]`, `hopper-pickup beat <issue url>`,
  `hopper-pickup list` (each record as one JSON line — what the hopper reads). In the box image
  (`/usr/local/bin/hopper-pickup` runs `scripts/agent-box/pickup.ts` with the box's node). The file is the
  protocol, not the CLI: an IDE extension, an agent's hook or a shell alias that writes the same record is a
  conforming writer.
- **The reader**, `node scripts/box-pickups.ts [--watch <s>] [--stale <s>] [box...]` (no box: the running
  `hopper-box-*`): `ssh <box> hopper-pickup list` per box, then one timeline line per change since its last
  read — `picked up (operator-led)`, each state with its note, `pull request <url>`, `stale`, `heard from
  again`, and a box `unreadable` (once) and `readable again`. It runs on this machine with the Hosts of
  `~/.ssh/hopper-box.config`; the hopper's key reaches the command too (`restrict` forbids a pty and
  forwarding, not a command).

**Seen end to end (2026-10-06).** The five boxes running, `hopper-pickup` put in each as the image puts it,
the test repo cloned into the claude and cursor boxes from a bundle (the boxes hold no GitHub
credential), the reader watching every 3 s with a 20 s stale time. On the claude box a pickup of one test
issue, a commit on a branch, `working`, `pull-request`, `finished`; on the cursor box a pickup of another,
`waiting`, `working`, `blocked`, silence until `stale`, a `beat` (`heard from again`), `released`, and a
status after that refused (`ended (released): pick it up again`, exit 1); the omp box stopped (`unreadable:
… Connection refused`). Every line came out once, in order, a burst of three changes between two reads
included.

**Found:** a box started again gets a new sshd port (published as `127.0.0.1::22`, any free port), so its
Host in `~/.ssh/hopper-box.config` and its known_hosts line are stale until `scripts/agent-boxes.sh` runs
again — the box stays unreadable, here as for the hopper. The same family as #306/#307 (boxes that do not
interop without a catch); the fix belongs there: a fixed port per box, or the Host rewritten at start.

**What the daemon would do with it (not built; for #318).** The concept the spike settles, for the work
that makes it a part of the hopper:

1. **Read in the machine source.** The `ssh` machine source already probes each machine every 30 s; the
   probe reads `hopper-pickup list` beside `herdr status server` (a box with no `hopper-pickup` has no
   pickups, not an error). A machine snapshot gains its pickups. No new route, no push.
2. **A pickup is a claim of operator-led work.** A pickup of an issue the GitHub source would take makes
   (or takes over, when it is waiting) that job as **operator-led** on that machine: the issue labelled
   `hopper:claimed` as for any claim, the job on the machine's timeline with no lane and no executor,
   so the decider never runs it a second time. The claim mode, its event and its timeline designation are
   #318's, now built ("Operator-led work" below): status `operator_led`, event `job.claimed_by_operator`;
   the pickup reader calls that claim.
3. **States are events.** Each new history entry becomes an event on the job (a state, its note, its
   time from the box); `stale` is the hopper's own reading, an event too, never a state the box writes;
   `waiting` could raise a question for the owner the way a pane's question does.
4. **Done stays the closing pull request** (#316's recommendation, "Done is a pull request"). `finished` is
   the operator's word, as `HOPPER_DONE` is an agent's: the job is finished only when the source says the
   work reached its completion, else it fails as any job does. `released` cancels the job and takes the
   claim off, so the issue is the queue's again.
5. **Trust.** A box writes what it likes into its own records; the hopper reads them only from a machine it
   attached, with its pinned host key, and acts only on issues its sources already allow. A record names an
   issue; it never names a command.

**Not built, on purpose.** No daemon change, no event, no migration: the spike's job was the protocol and
seeing it run. The reader is a script, as the boxes are.

## Work by hand in an IDE: how it checks in (issue #317, 2026-10-06 — research)

Owner direction (#316): containers are the primary, enforced job shape, and some jobs are still done by
hand in Cursor or a like IDE. The questions: how such work checks back in; whether that needs a hopper
plugin or another product surface, or git and GitHub alone; how it lives beside sandboxed container
jobs. Related: #314, #308, #315; the claim and its timeline designation are #318, the protocol #319.

**What already counts as check-in.** For a GitHub-sourced job, done is git and GitHub: the job's own
closing pull request being done ("Done is a pull request"). Labels carry claim, done and
failed; a local commit, a branch or a draft is never done. The `cursor-agent` executor is Cursor's CLI
in print mode on a machine's work tree, not the IDE. A client target serves herdr only; a container
target runs the command executor only.

**Options weighed.**

| Option | Check-in | Needs a hopper IDE plugin |
|--------|----------|---------------------------|
| Git and GitHub alone | the same closing pull request as an agent's job | no |
| Operator-led claim | the issue claimed; the job waits on the source's completion | no — a claim mode, no executor |
| Watched branch | the hopper watches pushes, may open the pull request | no; still ends at the pull request |
| IDE workspace watcher | an extension binds a workspace to a job | yes — a new surface to build and keep |
| Attach the IDE's machine | a machine for dispatched agents | no — it does not define check-in |
| Container to IDE handoff | the branch (or volume) carried on; ends at the pull request | no — a workflow, plus the claim |

**Settled (owner direction, #316 and #318; the protocol, #319).**

1. **One check-in: the closing pull request.** Work by hand is done exactly when an agent's is; the
   completion gate does not change.
2. **No IDE plugin is required.** The hopper needs only to know the issue was claimed as operator-led
   work, and to show that on the job's timeline: an IDE gives none of the pane feedback herdr does, so
   the designation stands in for it. Formal names only (operator-led, interactive, external session).
3. **Progress, when wanted, is a file the hopper reads**, not a push and not an extension: the pickup
   record of #319. An IDE extension, an agent's hook or a shell alias that writes the same record is a
   conforming writer; none is needed for check-in.
4. **Beside containers.** An operator-led claim has no lane and no executor, so the decider never
   dispatches the same issue to a container; `hopper:claimed` holds it. Released, the issue is the
   queue's again. A machine attached for an IDE is a
   machine for dispatched agents, nothing more.

**Not built here.** Research only: no daemon change. The claim mode, its event and timeline
designation are #318's; reading pickups in the machine source is #319's "What the daemon would do with
it".

## Sandboxing jobs: mechanisms compared (issue #315, 2026-10-06 — research)

The questions: which mechanism keeps a job to specific directories and never runs an agent with the
user's home as its workspace root (#314), and which keeps adding a machine easy while allowing a
sandbox (#308). Owner direction (#316): containers (Podman or Docker) are the primary enforced path,
and some jobs are still done by hand in Cursor or a like IDE (#317). Related: #310, #312, #319.

**What ships today.**

- **Work trees** ("Work tree", #121, #323): the pane opens in the job's cwd, `TMPDIR` and the scratch
  dir point inside it, the footer tells the job to stay in it. Direction, not enforcement: the
  process can still write anywhere its OS user can. At the time of this research `herdr-claude`'s
  and `cursor-agent`'s `cwd` default was `~`, so a job whose payload named no work tree ran with the
  home as its root. Step 1 below has since shipped (#314, "Work tree" → "Never the home").
- **Container targets** ("Container targets", #58): `docker exec` through a socket proxy, no network,
  no agent, no herdr. A real sandbox, for the `command` executor only.
- **Agent boxes** ("Agent boxes", #295; "Pickups on agent boxes", #319): one container per agent CLI,
  sshd plus its own herdr session, attached as an ssh target. Home is a named volume (the agent's
  sign-in survives the box); the host's home is not mounted; the network is open. The nearest thing
  shipped to a sandboxed agent machine.
- **ssh and client targets** (#59): full herdr and agent UX; the boundary is the OS user, which
  in practice means the whole home.

**Compared.**

| Option | Isolation | UX cost | Fit: hopper in a container, ssh / client attach | What breaks |
|--------|-----------|---------|--------------------------------------------------|-------------|
| Work trees only (directory jail by convention) | low: a prompt and an env, the OS user's full reach | none | as today; every target | nothing — and nothing is enforced |
| Landlock (kernel LSM, self-applied by an unprivileged process) | medium, files only (network from Landlock ABI 4, kernel 6.7); no PID or mount isolation | low: a wrapper around the agent start, no root, no daemon | works nested in an unprivileged container and on any Linux ssh / client host; not on macOS | git, `~/.claude`, `~/.ssh`, the agent's own install and caches need explicit read or write grants; a missing grant fails late and obscurely |
| bubblewrap (user namespaces; what Claude Code's Linux sandbox uses) | medium-high: own mount, PID and optional net namespace | medium: a bind list per job; Claude Code's built-in sandbox covers only the commands Claude runs, not the whole agent | good on ssh / client hosts; inside an unprivileged container it needs user namespaces, which Docker's default seccomp profile refuses | sign-in and git credentials must be bound in; ssh agent socket; herdr must start the agent inside it (the pane shell itself stays outside) |
| Podman / Docker, one box per machine (agent boxes, grown) | high, shared kernel; rootless Podman adds a user namespace | low once built: one script, one Add | best: the box is an ordinary ssh target; herdr, panes and the pickup record already work there | sign-in once per box (home volume); git needs a token or key put in per job; a work tree must be a path of the box; a containerized hopper does not reach the box's loopback sshd (#293) |
| Podman / Docker, one container per job | high, and nothing outlives the job | high: image pull and start per job, a herdr session per job | poor: herdr attach and the box's machine identity are per machine, not per job | sign-in per job unless a home volume is shared (which shares the state the per-job box was meant to drop); the timeline's machine identity |
| Firecracker (microVM) | highest: own kernel | highest: KVM, a kernel and rootfs pipeline, networking per VM | poor: no ssh / herdr attach model today; a laptop or IDE host rarely runs it | replaces the machine model; every credential and tool path re-plumbed |

**Recommendation.**

1. **#314 first, everywhere, in the executor.** A work tree that resolves to the machine's home (or
   `/`) fails the job at start, as an unusable work tree does (#323); the `~` default goes, and a job
   with no work tree takes a directory of its own below the home (per repository), never
   the home itself. Cheap, needs no new mechanism, and applies to IDE and ssh hosts too, where no
   container runs.
2. **The enforced sandbox is the agent box (#316: containers primary), grown — not a per-job
   container.** Per machine, one box; per job, a work tree inside the box's work volume. It already
   carries herdr, the sign-in and the pickup record; what it lacks for jobs: the job's git
   credential put in per job (the connected account's `GH_TOKEN`, as the hopper already sets it),
   a fixed sshd port per box (#319's finding), and a way for a containerized hopper to reach it
   (#293, #312). That is also #308's easy machine add: "add a sandbox machine" = build and attach a
   box, one action.
3. **Landlock as the optional layer on hosts that are not boxes** — ssh and client targets, and the
   IDE machines of #317. It needs no root and nests anywhere, so a wrapper can restrict writes to
   the work tree, its scratch dir and the agent's own state dirs. Prefer an established tool
   (`landrun`, or the Landlock support in an agent CLI's own sandbox) to a custom wrapper. bubblewrap
   stays the choice where namespaces are wanted and the host allows them; it is the weaker fit
   inside containers.
4. **No per-job containers, no Firecracker, for now.** Both pay a per-job start and break the herdr
   attach model; neither is needed for the threat model #316 implies (mistakes on trusted personal
   machines, not hostile tenants). Firecracker is the tier to revisit if the hopper ever runs other
   people's jobs.

**What each step breaks, and how it is kept.** Git: credentials go in per job (token in env, never
in the image); a mounted ssh key is the fallback. Claude sign-in: the box's home volume holds it,
signed in once over `ssh -t`; a Landlock grant for `~/.claude` on hosts. herdr panes: unchanged on a
box (herdr runs inside it); on a Landlock host the wrapper starts the agent, not the pane shell.

**Open for the owner.** Whether a box's network should be narrowed (an egress allowlist for the
agent's API and GitHub) or stay open; whether the sandbox is default on machine add or opt-in per
machine.

**Not built here.** Research only: no daemon change. Step 1 is #314's; steps 2 and 3 are #308's and
#310's.

## herdr by name on an ssh machine (issue #311, 2026-10-06)

Owner, on the Machines view's Edit form, which asked for a "herdr binary" holding an absolute path:
the person should not set a path; use `PATH`, just call the tool.

- **No `herdrBin`.** The `ssh` machine-source plugin has no such option (its schema refuses it); the Edit
  form and the machine card show no herdr path. `MachineSnapshot.herdr` is `{ session }`; a herdr-claude
  pane state records `ssh` and `session` only (an older one's `herdrBin` is read past, not used).
- **How a call finds herdr there**: `PATH="$PATH:$HOME/.local/bin" exec 'herdr' '--session' …`
  (`REMOTE_PATH` in `src/executors/ssh.ts`, used by the herdr CLI client over ssh). The machine's own
  PATH first, then `~/.local/bin`, where herdr installs and where `systemd/hopper-herdr.service` runs it
  from. This replaces the absolute path that was resolved once at attach because each call's shell could
  lose its PATH (row `herdr` above); the fallback is named in the command, so that race cannot hide it.
- **Adding a machine** checks, over the same connection, that `command -v herdr` answers with that PATH
  (else 409, "herdr not found: not on its PATH, not in ~/.local/bin"), and stores nothing of where.
  `scripts/attach-machine.sh` checks the same way and prints no `herdrBin`; `scripts/agent-boxes.ts`
  writes none (herdr is `/usr/local/bin/herdr` in a box, on its PATH).
- **Persisted state**: tenant migration 12 (`src/store/migration-herdr-by-name.ts`) drops `herdrBin`
  from every stored `ssh` machine; every other option stays.
- **Not changed**: a client target's `HOPPER_CLIENT_HERDR_BIN` (written by `scripts/attach-client.sh`,
  never typed in the UI; the dial-in client of issue #312 replaces it), and the herdr-claude executor's
  own `bin` for this machine's herdr (default `herdr`, from the daemon's PATH).

## Linking machines to a hopper in a container: protocols compared (issue #312, 2026-10-06 — research)

The question: how a computer or an agent box links to a hopper that runs in a container — no durable
host, no `~/.ssh` of its own, no ssh config ever (#309) — without today's ssh attach. The bar: adding a
machine is as easy as possible and allows a sandbox (#308, #310); every box interoperates with no catch,
across re-runs and rebuilds (#307, #306); no herdr binary path to type (#311). Related: #293, #315, #316,
#319, #262.

**What ships today, and where it misses the bar.**

| Path | Who dials | Reach needed | Catch |
|------|-----------|--------------|-------|
| ssh target (#10, #59, #293) | the hopper dials the machine | the container reaches the machine's sshd: `you@host.docker.internal` / `host.containers.internal` for the computer it runs on | a key to install by hand in `authorized_keys`, a host key fingerprint to check, sshd on the target, `herdrBin` because each call is a fresh login shell (#311) |
| client target (#59) | the machine dials the hopper | the client reaches the hopper's **host** sshd; its key goes in that host's `authorized_keys` with a forced relay command | leans on the hopper's host — exactly what a container hopper does not have (#293, "Not changed"); the token is a runtime variable, so adding one means a restart and a file; the install is a script run over the user's ssh |
| agent box (#295) | the hopper dials the box | the box's sshd on the computer's loopback, a random port; with the hopper in its compose container, the box's name on the compose network (#306) | the hopper must run on the boxes' computer; a restarted box gets a new loopback port (#319's finding), which only the owner's terminal uses |
| container target (#58) | the hopper runs `docker exec` | the hopper's docker socket (proxied) | runs commands only, no agent, no herdr |

Every catch in the table comes from one thing: **the hopper dials in**. Dialling in needs a reachable
address, an sshd, keys placed on both sides and a host key pinned, and a container that is recreated
keeps none of it. The client target already turns the direction round; only its transport — an ssh
login into the hopper's host — is wrong for a container.

**Compared.**

| Option | What it is, and who uses it | Ease | Fit: hopper in a container, boxes, sandbox | Cost |
|--------|-----------------------------|------|---------------------------------------------|------|
| **Client dial-in over the hopper's own URL** | the machine opens an outbound, long-lived connection (WebSocket or HTTP/2) to the hopper's URL and the hopper sends its calls down it. GitHub Actions self-hosted runners, Buildkite agents, GitLab runners, Coder workspace agents, Teleport nodes in reverse-tunnel mode, VS Code Remote Tunnels | high: nothing inbound on the machine, no sshd, no port | best: whatever reaches the UI reaches it — the compose network for boxes, `host.containers.internal` / the LAN / the public URL for the computer and laptops. A box needs no sshd and no published port, so its network can be cut to the hopper and the agent's API | a route outside the UI session (it changes nothing: the hopper still pulls, through the pipe); a reverse proxy in front must pass WebSocket upgrades |
| **Pairing by a one-time join code** (mint in the UI, give to the machine) | the admin's **Add machine** mints a short-lived, single-use code; the machine presents it once and gets enrolled. Tailscale auth keys, GitHub runner registration tokens (`config.sh --url … --token …`), Teleport join tokens, Buildkite agent tokens | high: one copied line, or an environment variable for a box | good: a box script passes it as an env var at create, no person needed; the code is hashed and expires, as the device link's login code already is ("Login codes") | none new: it is the device link's own mechanism, for a machine instead of a browser |
| **Pairing by device code** (RFC 8628 shape: the machine shows a code, a person approves it) | `hopper-client join <url>` prints a short code; the admin types or approves it in the Machines view. GitHub CLI and VS Code tunnels sign-in, Tailscale's login URL, TV apps | high for a person at the machine | weak for boxes: someone must be at each one; fine for laptops | a pending-approval list in the UI; the hopper already does this flow as a client (GitHub, `@octokit/oauth-methods`) |
| **Per-machine keypair as the credential** (after pairing) | the machine makes an ed25519 key and keeps the private half; the hopper keeps the public half and checks a signature on every connection. SSH keys, Teleport and Tailscale node keys, HTTP Message Signatures (RFC 9421) | invisible after pairing | good: the hopper stores a public key, not a secret ("Nothing leans on the machine"), and needs no runtime variable or restart per machine; the box keeps its key in its home volume, so a rebuild keeps its identity | replaces the client token's shared HMAC secret; node:crypto has ed25519, as it had HMAC |
| **Mutual TLS** | each side holds a certificate from a CA the other trusts. Kubernetes kubelets, service meshes, step-ca | invisible after enrolment | medium: TLS ends at the reverse proxy in front of a public hopper, so the hopper never sees the client certificate unless the proxy forwards it; plain-HTTP LAN installs have no TLS at all | a CA to run and rotate; an enrolment protocol (ACME, SCEP) on top — more than this needs |
| **SSH certificates** | a CA signs host and user keys, so no `authorized_keys` and no fingerprint check per machine. Teleport, smallstep, Netflix BLESS | medium: still sshd on every target | poor: still the hopper dialling in, still sshd in every box, and trusting the CA takes root on each target (`TrustedUserCAKeys`) | a CA, short-lived certs to renew; fixes trust, not reach |
| **WireGuard / a tailnet** | an overlay network: every node reachable by name. Tailscale, Headscale, NetBird, plain WireGuard | high once every node is in it | gives reach, not pairing or identity to the hopper: the hopper still needs a credential per machine on top. A container joins only with `NET_ADMIN` or a userspace sidecar | a second service and its keys to keep per machine; a fine **transport** for dial-in across networks when the owner already runs one — never a requirement |
| **Reverse tunnel as a service** | Cloudflare Tunnel, ngrok, frp: expose a local port through a relay | — | answers "reach the hopper from outside", which the public URL already does; it does not link a machine | a third party in the path |
| **mDNS / DNS-SD** (RFC 6762, 6763) | a service announces `_hopper._tcp` on the LAN; clients browse. Printers, AirPlay, Home Assistant | removes typing a URL on the LAN | poor: multicast does not cross into a bridge or rootless network, so a container hopper is not found unless it runs with host networking; discovery only, it proves nothing | worth at most a convenience in the join command later |

**Recommendation.**

1. **One way to add a machine: dial-in plus a join code.** Grow the client target, do not add a new
   kind. The client connects out to the hopper's own URL (WebSocket upgrade on one route; the existing
   HTTP/2 session and the signed `POST /herdr` calls ride on that stream unchanged, so `server.ts` and
   `src/executors/client.ts` keep their protocol and lose the ssh relay). **Add machine** in the UI mints
   a one-time join code (hashed, 10 minutes, as a device link) and shows one line to run there:
   `hopper-client join <hopper URL>#<code>`. The client makes its keypair, presents the code and its
   public key once, and is a machine. Device-code approval (the machine shows the code) is the second
   form for a person at a laptop; build it only when a real case asks.
2. **The credential is the machine's public key**, not a shared token: the hopper records it on the
   machine instance, so adding a machine needs no runtime variable, no restart, and no stored secret.
   Sign each connection (and keep the per-request signatures and the 30 s replay window that ship) with
   the key; prefer an established library for the signature format (RFC 9421) if one fits the client's
   no-`node_modules` install, else node:crypto's ed25519, as the HMAC is today. Removing a machine
   deletes its key; the next connect is refused.
3. **Agent boxes become clients.** The box image carries the hopper client; `scripts/agent-boxes.sh`
   (or a **Add sandbox machine** action, #308) creates the box on the hopper's own network with a join
   code in its environment. No sshd, no published port, no `~/.ssh` Host, no known_hosts line, no
   `--attach` through a host-installed CLI. A rebuilt box finds its key in its home volume and reconnects
   as the same machine; a re-run changes nothing. That is #307's "no catches", #306's fix, and #319's
   port finding gone. The pickup record (#319) is read over the same connection, as a signed call. A box
   that dials out only can have its network cut to the hopper and the agent's API (#315's open question).
4. **The computer the container runs on is a client too**, joined the same way, so the container never
   reaches into its host. `host.containers.internal` / `host.docker.internal` stays only as the address
   the client dials when the UI is published on the host's loopback.
5. **herdr from `PATH` (#311).** The client is one long-lived process that runs `herdr` with its own
   environment, not a fresh login shell per call, so the race that made `herdrBin` necessary does not
   happen there; the field goes for clients, and the client starts its own herdr session as it does now.
6. **ssh stays, demoted.** For a machine that cannot run the client (no node ≥ 24), the ssh target as
   #293 left it remains, behind an "attach over ssh instead" link, with no ssh config named anywhere
   (#309). No SSH certificates, no mTLS, no required tailnet, no mDNS: each fixes a part this path
   does not have.

**What it costs and breaks.** A route outside the UI session, authenticated by the machine's key;
"Loopback plus the LAN names and the public URL" must let a client's peer through (a box on the
compose network arrives from a container address, which `HOPPER_LAN_PEERS` refuses today), so the route
needs its own reach rule, decided with the repo law it amends. A reverse proxy in front must pass
WebSocket upgrades (every common one does, with a line of config). The client's ssh tunnel, its relay
and `scripts/attach-client.sh`'s host-side steps go, with no shim (the client token's runtime variable
and the existing client's pane state need a migration to the key and the new connection). Windows
(#262) gets a path with no sshd, since the client is node.

**Open for the owner.** Whether a join code may enrol more than one machine (one code for all boxes of an
`agent-boxes.sh` run, as a reusable Tailscale key) or exactly one; whether **Add machine** defaults to a
sandbox box or to the computer.

**Not built here.** Research only: no daemon change. The build is #308's and #307's; #310 asks the
same question from the add flow's side, and this section is its protocol half — #310 depends on it,
not the other way round.

## Operator-led work (issue #318, 2026-10-07)

Owner direction (#316, #317, #318): the hopper only needs to know that someone claimed an issue's job to
work it by hand, and its timeline must show that kind of work. A job in a herdr pane reports itself; work in
an IDE does not, so the claim is the one thing the hopper is told. No IDE plugin: done stays the closing
pull request. Names are formal (#318's naming note): **operator-led**, never the informal word.

- **The claim.** `POST /ui/api/jobs/:id/operator-led` (least role `operator`) on a waiting job — `queued`
  or `held`, accepted or not (claiming it accepts it) — sets status `operator_led`, `startedAt`, and appends
  `job.claimed_by_operator` (data `{}`). Any other status: 409. The issue already carries `hopper:claimed`
  (the source reports the claim of every job it makes); nothing more is written to GitHub.
- **Never run.** `operator_led` is neither waiting nor running to the decider (`WAITING`/`RUNNING` in
  `src/engine/decision-step.ts`), holds no lane, and restart recovery leaves it as it is.
- **Done.** The sync loop, after the cancel signals, asks the source of each operator-led job
  `notComplete(job)` (the same check an agent's `HOPPER_DONE` gets, "Done is a pull request"); complete →
  `SourceHost.finishOperatorLed` ends it `finished` (`job.finished`), and the report labels the issue
  `hopper:done`. An error asking is a report retry; the job stays operator-led. The pull request must be the
  job's own (opened at or after the job was created), as for any job.
- **Not done.** An issue closed by a person as not planned (closed as completed is done, "Done is a pull request"), the label removed, or the issue gone cancels it, as for any job
  (`check()`); so does Cancel in the UI, which takes the claim off the issue.
- **Where it shows.** `/api/queue` `operatorLed`; the Overview's Waiting panel lists them under
  *Operator-led*, with the button *Operator-led* on each waiting job; the lane timeline draws each one on a
  row of its own, `operator-led`, from the claim to its end, in the operator tone while it lasts, and the
  "lanes in use" spark leaves it out; the event lines show `job.claimed_by_operator` in the same tone; the
  instance totals count `operator_led`.

**Not built.** The pickup reader (above) does not yet make the claim: a pickup on an agent box naming an
issue whose job waits would call the same claim, and `released` the same cancel. That is the remaining step
of "What the daemon would do with it"; it depends on this claim, not the other way round.

## Adding a machine to a hopper in a container: the add flow (issue #310, 2026-10-06 — research)

The question: how a person adds a machine — the computer the hopper's container runs on, a laptop, a
sandboxed box — to a hopper in a container, with no durable host and no ssh config ever (#309), as easily
as possible and with a sandbox allowed (#308); every box interoperates with no catch across re-runs and
rebuilds (#307, #306). This section is the add flow, what the person does and sees. Its protocol half —
dial-in, the join code, the machine's key — is #312's ("Linking machines to a hopper in a container"),
and the sandbox mechanisms are #315's ("Sandboxing jobs"); both are taken as settled here, not argued
again. This section depends on them, not the other way round.

**What the person does today, per machine.**

| Machine | Path that ships | Steps for the person | Catch against the bar |
|---------|-----------------|----------------------|-----------------------|
| the computer the container runs on | ssh target typed as `you@host.containers.internal` / `you@host.docker.internal` (#293) | start sshd there; install herdr; paste the form's `restrict <key>` line into `authorized_keys`; check a fingerprint by hand; (Docker on Linux) add `extra_hosts: host-gateway` to the compose file | five steps, two of them on the host's security config; a herdr path (#311); the computer's whole account is the boundary |
| a laptop | ssh target typed as `user@host` | the same, minus the gateway name | the same; the laptop must be reachable from the hopper (same LAN or a tailnet) |
| a sandboxed agent box | `scripts/agent-boxes.sh --attach` (#295) | from a checkout on the host; with the hopper in its compose container, the hopper's own CLI there (#306) | an ssh box: sshd, a host key, a key line; boxes on this computer's engine only |
| a sandboxed command box | `scripts/container-target.sh` + `scripts/docker-proxy.sh` (#58) | from a checkout on the host; a docker socket handed to the hopper | runs commands only, no agent; the hopper container gets no engine socket in the compose deploy |
| a client target | `scripts/attach-client.sh` (#59) | from the hopper's host, over the user's ssh | dials the hopper's host sshd, which a container hopper does not have (#293, "Not changed"); a token variable and a restart per machine |

No path is a single action, and every catch is the hopper reaching *in* (#312's finding). The add flow
below has none of them because the machine reaches *out*.

**Reach, checked (rootless Podman 6.1, netavark, pasta; 2026-10-06).** The add flow rests on two facts
about where a machine can reach the hopper from, so both were run, not assumed:

- A container on a user-defined network resolves another container on it by name (`getent hosts
  <name>` answered the peer's address; an HTTP fetch by name answered). The compose file's `name:
  hopper` makes its network `hopper_default` on every run: a box started with `--network
  hopper_default` reaches the hopper as `http://hopper:<port>`, and a re-run or rebuild changes nothing.
- `host.containers.internal` from a container reaches a host service that listens on every interface
  (an HTTP fetch answered) and **not** one bound to the host's loopback (connection refused). The compose
  file publishes the UI on `127.0.0.1` only, so a box outside the compose network cannot dial the hopper
  through the host gateway; the computer itself can, through the published loopback port. And the ssh
  path to the computer works only because sshd listens on every interface.

**Options for the add action.**

| Option | What the person does | Ease | Sandbox | Cost and risk |
|--------|----------------------|------|---------|---------------|
| **A. Copy one line from Add machine** (join code in it, #312) | **Add machine** → pick *a computer* or *a sandbox box (agent: claude, codex, …)* → the UI shows one command with a fresh join code; run it there; the machine appears in the view, online, when it joins | high: one paste, nothing inbound, no ssh, no path | the box line is the sandbox: rootless container, every capability dropped, `no-new-privileges`, read-only root, its own home and work volumes, nothing of the host mounted, the compose network only (egress narrowed later, #315's open question) | a published box image per agent; a client installer the hopper serves; the join route ("What it costs") |
| **B. The hopper creates the box itself** (one click, through an engine socket mounted into the hopper) | **Add sandbox box** → click | highest: no terminal | as A once created | the engine socket is the user's whole account (rootless) or root (rootful); the docker socket proxy checks paths, not bodies ("Target authentication"), so a create it lets through could mount `/`. An admin UI session would hold code execution on the host. A mount and a compose change a container-only deploy does not have |
| **C. Boxes as compose services** (a `boxes` profile in `compose.yaml`) | `podman compose --profile boxes up -d` | high for the set the file names; another agent is a file edit | as A | one join code reused by every box (#312's open question); the set is fixed by the file, not by the view |
| **D. Keep ssh attach, polish it** (gateway name filled in, `host-gateway` in compose, herdr from `PATH`) | as today, fewer fields | medium: sshd, a key line, a fingerprint stay | none: the computer's account | fixes #309 and #311, not #306/#307 for boxes |

**Recommendation.**

1. **A: one Add machine action, one copied line, two choices.** *A computer* shows
   `curl -fsSL <hopper URL>/client/install | sh -s -- <join code>`, for the computer the container runs on
   (the URL is the published loopback one, `http://localhost:<port>`) and for a laptop (the LAN or public
   URL). The installer is served by the hopper, so the computer gets the hopper's own client release, as
   client targets already do ("Client releases"); it checks node ≥ 24 and herdr, installs the client as
   a user unit, and joins. *A sandbox box* shows `podman run -d --name hopper-box-<agent> --network
   hopper_default -e HOPPER_JOIN=http://hopper:<port>#<code> -v hopper-box-<agent>-home:/home/agent
   <box image>` with the sandbox flags above (`docker run` the same, the view offers either). The machine
   appears in the view live as it joins; the person names it there, or takes the default
   (`hopper-box-<agent>`, the computer's host name). Nothing is typed into the hopper but a name.
2. **Not B, for now.** One click instead of one paste is not worth handing an admin session the host's
   account. Revisit only with an engine API filter that checks request bodies (a create's binds, devices,
   privileges), and then as an opt-in mount, never in the default compose file. *Since issue #603 (owner
   direction): B is built, as that opt-in mount — `compose.sandboxes.yaml`, not the default compose file — and
   the hopper builds every request body itself, so no request carries a bind, a device or a privilege
   ("Sandbox boxes the hopper launches").*
3. **C as the bulk form of A, later.** When a set of boxes is wanted at once, a compose profile with a
   reusable join code is the same box line in a file; it needs nothing A does not build.
4. **D's two cheap parts land anyway, on the ssh path #312 demotes:** no ssh-config warning (#309), herdr
   from `PATH` (#311), and `extra_hosts: host-gateway` in `compose.yaml` so the Docker form of the gateway
   name works as documented.
5. **The computer's own sandbox is opt-in.** A computer added with A runs jobs as its user, as an ssh
   target does today. #315's Landlock wrapper is the layer for it; a person who wants jobs confined on that
   computer adds a sandbox box on it instead — the box line runs there too, joined to the hopper's network.

**What A needs, and what breaks.** No catch for #307 means the box joins and also runs jobs:

- **A published box image per agent** (`scripts/agent-box/Dockerfile`, built by the image workflow beside
  the hopper's image) with the client in it, and no sshd. Today the image is built from a checkout.
- **A box signs nothing in by hand.** The box's home volume keeps the agent's sign-in once made; the
  hopper may instead hand the agent its runtime credential per job through the job's environment, as it
  already sets `GH_TOKEN`, so a fresh box runs its first job with no `ssh -t` sign-in. Which credentials
  the hopper may hand to which box is a decision for the build.
- **Executors for codex, omp and opencode** ("6d. Backends are configuration"): until they exist those
  boxes join and stay idle, which #307 counts as a catch.
- **The join route** and its reach rule, the machine key in place of the token, and the removal of the
  ssh tunnel, relay and `scripts/attach-client.sh` with no shim — #312's "What it costs and breaks".
- **`scripts/agent-boxes.sh` goes** with its ssh Hosts, known_hosts lines and `--attach`: the box line
  replaces it. The pickup record (#319) is read over the client connection.

**Open for the owner.** Whether the first choice Add machine offers is the sandbox box or the computer;
whether the box line names Podman or Docker first (the view can detect neither: it runs in a container).

**Not built here.** Research only: no daemon change. The build is #308's (the add action) and #307's (the
boxes), on #312's protocol. Built for #308: "Joining a machine" below.

## Joining a machine (issue #308, 2026-10-07)

Owner request, on the hopper in its container: adding a machine must be as easy as possible, and allow
sandboxing. Built on #312's protocol and #310's add flow (above): **one Add machine action, one copied
line**, and the machine dials in. This replaces the client target's ssh tunnel; ssh targets stay, for a
machine that cannot run the client.

**What the person does.** Machines → **Add machine** → *A computer* or *A sandbox box* → **Show the
line** → run it there. The machine shows in the view, online, when it joins. Nothing is typed into the
hopper; the machine is named after its host name (a box: `hopper-sandbox-<agent>`), renamed in the view like
any machine. Never an agent box's name (`hopper-box-<agent>`): the line must not meet one.

| Choice | The line | Where it runs |
|--------|----------|---------------|
| A computer | `curl -fsSL '<origin>/client/install' \| sh -s -- '<origin>#<code>'` — `<origin>` the URL the page is open at | the computer: the computer the container runs on (the UI open at `http://localhost:<port>`), a laptop, a desktop |
| A sandbox box | `<podman\|docker> run -d --name hopper-sandbox-claude --restart unless-stopped --network hopper_default --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp -v hopper-sandbox-claude-home:/home/agent -e HOPPER_CLIENT_NAME=hopper-sandbox-claude -e HOPPER_JOIN='http://hopper:<port>#<code>' ghcr.io/henningfutrell/hopper:box-claude` | the computer the hopper runs on; a hopper installed on the host gives `--network host` and `http://127.0.0.1:<port>` |

**Join code.** `POST /ui/api/machines/join` (admin) mints one for the session's user: 32 random bytes,
hex, kept only as its SHA-256 in the instance's `join_codes` (migration 25), for 10 minutes, taken once
— the login code's shape (`src/machines/join-code.ts`). `hopper join-code [--user <id>]` mints one for a
script (the bulk form, #310's option C). Owner question #312 left open — one code for many machines — is
answered *one*: a script asks for one per machine.

**Join.** The client (`src/client/join.ts`) makes its **link key** — X25519, node:crypto — in its client
dir (`~/.config/hopper-client/link-key.pem`, 600; a box's home volume), and posts once to `POST
/client/join` `{code, key, name}`: `key` its public half, the **machine key**. The hopper takes the code
(403 when it was used, expired or never minted), adds a `client` instance `{key, lanes, executors}` with
the machine defaults under `name` (`-2`, `-3`, … when taken; a key already joined answers that machine,
unchanged), and answers `{user, machine, hopperKey}`: the public half of the user's link key, minted once
and kept in the user's schema like the hopper's ssh key. The client keeps it in `link.json`.

**Client token.** Derived on each end: HKDF-SHA256 over X25519(own private half, other public half).
The same on both ends; neither stores it; it never crosses the wire. Every request and answer is signed
with it exactly as before ("Target authentication"). The hopper stores the machine key — who the machine
is, not a secret — and its own link key, a secret by the same exception as its ssh key (AGENTS.md).

**Dial-in.** The client opens `GET /client/connect` with `Upgrade: hopper-client/1`, `x-hopper-user`,
`x-hopper-machine-key`, and `x-hopper-signature` over the user, the key, a timestamp and a nonce (label
`hopper-connect`, 30 s, once). The hopper applies the Host guard's rule itself (the upgrade bypasses
Fastify's hooks), finds the client target holding that key, checks the signature with its token, answers
101, and keeps the socket as the machine's **link** (`src/machines/links.ts`; a second dial-in replaces
the first). The hopper is the HTTP/2 client on it, the client the server: `POST /herdr`, `/release`,
`/load` unchanged. A link that ends is dialled again (1 s … 30 s); a fresh dial-in is probed at once, not
at the next 30 s. A removed machine's key finds no client target: refused, 401.

**Reach.** Whatever reaches the UI reaches the dial-in: a box on the compose network as `hopper:<port>`
(the compose file's `HOPPER_LAN_NAMES` and `HOPPER_LAN_PEERS` defaults), the computer through the
published loopback port, a laptop through a LAN name or the public URL. A reverse proxy in front must pass
the upgrade. Nothing listens on the machine.

**Install** (`GET /client/install`, `scripts/client-install.sh`; `GET /client/release`, the release as
JSON). Checks node ≥ 24 and herdr on `PATH`, writes the release to `~/.local/lib/hopper-client`, joins,
writes the units `hopper-client` and `hopper-client-herdr` (session `hopper-client`) with `PATH` holding
herdr's dir — herdr is called from `PATH`, never a configured path (#311) — and starts them. Without a
systemd user session it prints the two commands to run. Re-running keeps the link key: the same machine. With the hopper's URL and no join code it only reinstalls a joined computer's client (issue #545, "Client releases" → "When it cannot update").

**Sandbox box** (`scripts/box/`, published by the image workflow as tags `box-<agent>` and
`box-<agent>-sha-<commit>` of the public `hopper` package). One agent CLI (claude: the agent an executor
drives on a client target; cursor-agent runs only here and on ssh targets), herdr from its installer, the
client from `src/client`, user `agent`, Claude's first-run screens seeded, its auto-updater off (the root
is read-only). Its entrypoint copies the client into the home volume once (a loaded release must persist),
starts the herdr session, and runs the client — joining with `HOPPER_JOIN` the first time — again after
each release load (exit 75). The join line leaves the box's environment before anything starts (issue #606):
the entrypoint writes `HOPPER_JOIN` to a file only `agent` can read, runs itself again without the variable,
and gives the client the file's path (`HOPPER_JOIN_FILE`); the client reads it once and removes it, joined or
not. A file, because a process's starting environment stays readable in `/proc/<pid>/environ` after it unsets
a variable. So no process in the box — the entrypoint, herdr, the client, a job — holds the code, and a restart
dials in with the link alone. Its agent is signed in once, `<engine> exec -it hopper-sandbox-claude claude`,
and stays signed in in the volume. What the line confines: every capability dropped, no new privileges, a
read-only root, nothing of the computer mounted, the compose network only (no published port). What it
does not: its network reaches the internet (the agent's API, GitHub) — #315's open egress question.

**Removed, no shim** (owner law: no backwards compatibility). The client's ssh tunnel (`tunnel.ts`),
the relay (`relay.ts`), `scripts/attach-client.sh`, the client token variable (`tokenEnv`, `<dataDir>/
clients/<name>.sock`) and the job-hopper rename's client step. Tenant migration 12 drops a `client`
instance that names `tokenEnv`: its client still dials over ssh and can reach nothing; it is added again
with one line. `src/client/ssh-options.ts` moved to `src/executors/` — only ssh targets use it now.

**Residual risk.** The join code crosses the wire as the UI's session token does: over plain HTTP on a
LAN an on-path attacker who sees it could join a machine of its own first (the real one is then refused,
and the person sees a stranger in the view). Use the public URL over HTTPS beyond a trusted LAN. After
joining, the link key exchange protects every call as the ssh tunnel did.

**Verification.** `test/integration/machine-join.test.ts`: join with the line through the real daemon,
online under its name, herdr calls in its session, a code used once, minted only behind an admin
session, a taken name, a restart and a rename keeping the machine, a forged key and a removed machine
refused, the install served. `test/client/link.test.ts` (the token), `test/adapters/client-transport.test.ts`
(the link), `test/integration/client-release.test.ts` (releases over the link), `test/ui/machines.test.ts`
(the lines), `test/store/tenant-migration-12.test.ts`.

## Sandbox boxes the hopper launches (issue #603, 2026-10-09)

Owner direction, from a live test: a person had to start a sandbox box by hand, and removing its machine left the
container running. The hopper now starts, stops and removes sandbox boxes itself, through rootless Podman. This is
#310's option B, which that research put off; the owner asked for it.

**The sandbox engine** (`SandboxEngine`, `src/domain/ports.ts`; `src/sandboxes/podman.ts`). Rootless Podman at the
API socket `HOPPER_PODMAN_SOCKET` names — its libpod REST API over node:http, six calls: `info`, list containers
(by label), image exists and pull, volume create, container create and start, container and volume delete. Written
here, not taken from a library: dockerode speaks the Docker API, which has no rootless answer and other volume
semantics, and six calls cost less than its dependency tree. `problem()` refuses a socket that is not reached or a
Podman that is not rootless: rootful Podman is root on the computer. Unset: the hopper starts no box, and Add machine
shows the line ("Joining a machine").

**Launch** (`POST /ui/api/machines/sandbox` `{agent, template?}`, admin). The hopper picks a free name —
`hopper-sandbox-<template or agent>`, then `-2`, `-3`, … against every container Podman holds — mints a join code
that names it (instance migration 32: `join_codes.container`, a column only), and starts the box: the published
`ghcr.io/henningfutrell/hopper:box-<agent>` or the template's image, only once that image is approved (409 else), the
box line's sandbox flags fixed in the adapter (every capability dropped, `no-new-privileges`, a read-only root, `/tmp` a
tmpfs, the home the volume `<name>-home`, restart `unless-stopped`), `HOPPER_CLIENT_NAME` its name and `HOPPER_JOIN`
the join line on the sandbox network (`hopper_default` in the container, `host` on the host; `HOPPER_SANDBOX_NETWORK`).
Labels: `io.hopper.box` = the hopper's **instance id** (made once, kept in the instance settings) and `io.hopper.user`.
A box that does not start is removed again, its volume too; the answer is 502 with Podman's reason. It joins as any
box does; `POST /client/join` gives the client target the code's `container` option. Nothing a request carries
reaches the create body but an agent from a fixed list or a template's name.

**Keeping in step** (`src/sandboxes/service.ts`, every 10 s and at start, after the runtimes). The hopper lists the
boxes with its own instance label — another hopper's are not its — and keeps each one a client target of its user
names (`UserRuntime.sandboxBoxes`) or a live join code waits for (`JoinCodeRepository.waiting`). Any other is removed
— stopped (10 s, then killed) and deleted with its volumes — once it is found so twice in a row: a join's config write
may lag one check. A user's runtime whose plugins config cannot be read names nothing and keeps all its boxes: a box
holds an agent's sign-in, so nothing is removed on a config that cannot say which machines there are. A box of a user
the instance no longer has goes.

**Cleanup problems.** A remove that fails is kept in memory with its reason and time, logged once per reason, tried
again at the next check, and dropped when the box is gone. `GET /api/sandboxes` answers `{launch: {available,
problem?}, problems}` for the session's user; Machines shows the problems under *Sandbox boxes not removed*, and Add
machine starts a box with **Start the box** when `launch.available`, else says why and shows the line.

**Deploy.** Opt-in: `compose.sandboxes.yaml`, saved as `compose.override.yaml` beside `compose.yaml` (every compose
command reads that file with no flag; podman-compose does not read `COMPOSE_FILE` from `.env`), mounts the
rootless socket under `$XDG_RUNTIME_DIR`, sets `HOPPER_PODMAN_SOCKET` and adds group 0 — the user's own group in a
rootless container, which `podman.socket` (mode 0660) lets open it. `docs/deploy.md` "Sandbox boxes the hopper starts".

**Residual risk.** The socket is the user's account: a compromise of the hopper's process can start any container as
the user. What the hopper itself starts is fixed in code, and an admin UI session can start and remove boxes as it can
add and remove machines. A box the hopper did not start (one run from the line) is not the hopper's: it is never
removed by it.

**Verification.** `test/integration/sandbox-lifecycle.test.ts` (the real daemon, the engine double): a started box
joins as the machine that names it; a template's box only once approved; removing the machine removes the box and its
volume; a box not joined yet is kept; at start an orphan of its own goes and another hopper's stays; a failed remove is
shown with its reason until it goes; a box that does not start leaves nothing; no socket, or a rootful one, starts
nothing and says why. `test/adapters/podman-sandbox.test.ts` against real rootless Podman when
`HOPPER_TEST_PODMAN_SOCKET` names its socket: the flags, the labels, no capability left, removal with the volume.
`test/scripts/compose.test.ts`: the socket only with `compose.sandboxes.yaml`.

## Client releases (issue #70, 2026-10-05)

The hopper client is released from the hopper and loaded onto its client targets by the hopper: no
client target runs a client the hopper did not release.

- **The release** (`src/client/release.ts`) is the client's files — every `*.ts` file of the client's
  directory, never `relay.ts`, which runs here — its **manifest** (each file's name and SHA-256) and an id,
  the first 16 hex of a SHA-256 over the manifest. Same files, same id. The hopper's release is the client
  files of the install it runs from (`<app>/src/client`), read at boot: `scripts/install.sh` and a
  self-update ("Self-update") release a new client whenever its files change. No list of names is fixed in
  the client (issue #545): a release may add, remove or rename files, and the manifest it carries says which.
- **The calls**, signed like `POST /herdr`: `POST /release {}` → `{release, loads, home}`, the id of the release the
  client process runs (read from its install dir at start), `loads: 'manifest'` (it loads by manifest; a
  client before issue #545 says nothing) and its user's home, where `~` in a job's
  work tree resolves (issue #323; a client before it answers no home); `POST /load {release: {id, manifest, files}}` → the
  client checks the release whole before writing a byte — each name a plain client file name
  (`[a-z0-9][a-z0-9-]*.ts`, at most 64), `main.ts` among them, every file named by the manifest and its
  SHA-256 the manifest's, the id the manifest's — writes it to `<install>.next`, swaps it in (the one
  before kept as `<install>.prev`), answers
  `{release}`, and 1 s after that answer has left (time for it to cross the tunnel) exits 75; its unit
  (`Restart=always`) starts the new files. A load of the release
  already installed writes nothing. The request's signature covers the body's hash, so the manifest and
  the files arrive as the hopper sent them. `POST /reap {jobId, scratch?}` and `POST /survey {roots}` (issue
  #410) run the client's own copy of the reap and the survey ("Work tree" → "The reap", "The sweep") with
  no shell of the request's: a job id (letters, digits, `-`), its own scratch dir
  (`…/.hopper-scratch/<job id>`), absolute work trees — anything else is refused 400 before a script runs;
  the answer is `{code, stdout, stderr}`. The scripts live in `server.ts`.
- **Keeping it current** (`src/machines/client-release.ts`): each probe of a client target (every 30 s)
  asks `POST /release` after `status server`; when it is not the hopper's id, the hopper loads its
  release — never while a job runs on that machine (a running job's herdr calls must not meet a
  restarting client; it loads after). Each outcome is one log line per machine: `runs the hopper's
  release`, `loaded release <id> (was <id>)`, `loaded the bridge`, `loading it once no job runs there`, a
  failed load, `cannot update`, or a client older than releases (it answers no release: still online; add
  it again with Add machine).
- **Clients with a fixed file list** (issue #545). A client released before manifests checks a load
  against the list of names fixed in its own `release.ts` (exactly those names, an id hashed over them in
  order) and refuses anything else: on 2026-10-09 a client of seven files refused the hopper's ten, stayed
  on its release, and every call it did not have answered an unsigned 404 the hopper reported as a
  signature failure. The hopper knows such a client by its `/release` answer (no `loads`). It loads an
  empty release first: the refusal names the client's list. Then it loads the **bridge**
  (`src/machines/client-bridge.ts`): exactly those names, the id that client computes; its `main.ts`
  carries the hopper's release, every other file is a placeholder. The client restarts into the bridge;
  the bridge writes the hopper's release over the install dir (the release before the bridge stays as
  `<install>.prev`) and exits 75; whatever runs the client — the unit, a box's entrypoint, the loop the
  README gives a Windows computer — starts the hopper's release. Two restarts, no person. Should the
  bridge fail to write, it puts back the release before it and exits 75. A client's herdr session is its
  own unit, so a restart of the client leaves its panes, and the jobs in them, running; the load still
  waits until no job runs there. The bridge stays while any client released before manifests may still
  dial in.
- **When it cannot update.** A machine whose client still runs another release after three loads (each
  answered, or refused) is not loaded again until its client runs another release: the probe carries
  `client.update.problem` — the client's own refusal, or that it still runs its release after the loads
  — logged once as `cannot update`. Machines shows it with the line that reinstalls the client on that
  computer: the install with no join code (`curl -fsSL '<origin>/client/install' | sh -s -- '<origin>'`),
  which writes the hopper's release over the old one, joins nothing (it refuses a computer that has not
  joined) and restarts the client. A sandbox box keeps its client in its home volume: removing
  `~/.local/lib/hopper-client` there and restarting the box copies the image's client in again.
- **Errors name the cause.** A client answers a route it does not know before it reads the signature, so
  unsigned: an unsigned 404 is `client <machine> runs an older client release, which has no <call>`; any
  other unsigned answer, or one whose signature is not this machine's link key's, `did not prove itself`
  with which of the two.
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
- **The UI bundle check (issue #274).** `npm run build:ui` ends with `scripts/check-ui-bundle.ts`: the
  stylesheet `index.html` links must be at least 40 KB (a real one is ~90 KB) and hold a rule for each of a
  few layout utilities (`.flex`, `.h-8`, `.w-full`, …), or the build fails. Tailwind generates only the
  classes it finds by scanning the source files, and skips files any `.gitignore` covers, a parent dir's
  too: `install.sh` once built in a temp dir under a job's scratch dir (`.gitignore` of `*`), and the
  ~15 KB stylesheet it shipped left the sign-in page as logo shards with no controls (#272). So
  `install.sh` makes its build copy a git root of its own (`git init`), and the check fails the install —
  and a self-update's build of the next install, before the swap — on a hollow bundle whatever the cause.
- **One icon (issue #183).** The asset `index.html` names as its icon (`site/hopper-logo.svg`, built)
  is also served at `/favicon.svg` and `/favicon.ico`. Every other page the daemon serves — the API
  reference (Scalar's `favicon`), the sign-in pages — links `/favicon.svg`; `/favicon.ico` covers a
  page that names no icon.
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
  running job with no start in the log gets its span from `startedAt`. A span that ended on a question
  is followed by a *question wait* on the same lane, until the question is answered, closed, dismissed or
  expired; the job store wins there too (a wait of a job no longer waiting ends with the job). The nav's questions badge
  counts `awaitsOwner` (`ui/src/model/questions.ts`): open, at the human stage, seen or not (issue #499). The
  Questions view marks seen by `unseenByOwner`, the same test plus no `seenAt`.
- **Realtime.** One SSE connection; each domain event updates the log and chart history at once
  and debounces a `/api/queue` + `/api/machines` refresh (150 ms). One shared 1 s clock drives
  every ticking label. `ui/src/model/event-types.ts` is a `Record<EventType, true>`: a new event
  type that the UI does not subscribe to fails the UI typecheck.
- **Views** (hash-routed): Overview (KPIs with sparklines, lane timeline, attention, lanes /
  waiting / ended, ended-per-hour chart, usage gauges, live activity), Questions, Decisions,
  Events, Sources, Machines, Plugins (#13's panel, ported: "Settled in slice 7"), Webhooks. Charts read `/api/events?types=…&limit=5000`
  (`HISTORY_TYPES`): lane spans are derived client-side, no new API; ended-per-hour counts the job store's ended jobs.
- **Mutations unchanged**: cancel (now behind a confirm dialog), approve, answer, router mode (removed by issue #211),
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

**Logging a device in.** `open-ui.sh` works only on this machine. The other way is through the same
one-time login code (`POST /ui/login`; using it rotates it):
1. **Device link** — a logged-in browser's user menu item (issue #666) calls `POST /ui/api/device-link` and shows
   `http://<LAN name>:<port>/#login=<code>` per LAN name, each also as a QR code for a phone's camera
   (issue #95, `qrcode.react`). The code rides in the fragment, which the browser never sends; the
   page strips it from the address bar and history, then posts it. The QR follows the code: while the
   dialog is open it posts `{ keep: <code> }` every 2 s; the daemon answers the same links while that
   code is live (`loginCodes.live`, which spends nothing), else mints a fresh code, and the dialog
   redraws. Closing the dialog stops it; a shown code still expires after 10 minutes.

The landing page takes no pasted code and names no command (issue #247): a code reaches the daemon
only through a link.

Sessions are already in the store (migration 6), so a daemon restart does not log a device out; a
session still ends after its idle timeout or its maximum (issue #439, "Session lifetime").

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
lowest first → risk rules → owner (issue #134; before it, answerer → assessor). One panel, a
section of Settings (issue #151; the first until issue #363 put the version first; before it, below the open questions in the Questions view), shows the chain with
each level's instance and state, and edits what is configuration:

- **Escalation levels** — added (on top, under the name typed, else the plugin id), removed,
  moved earlier or later, and each level's non-command options (model, timeoutMs, effort, …), through
  `POST /ui/api/plugins` `add` / `remove` / `move` / `options`. A level's state comes from
  `GET /api/plugins` `escalationLevels[]`: active plugin, detection, and the reason one cannot run
  (it escalates every question). The levels are live: an edit applies to the next question,
  never `restart pending`. **This panel is their one editor** (issue #444, owner decision
  2026-10-08): the Plugins view shows the levels read-only (order, plugin, state) with a link here,
  and the shipped-plugin switches leave the escalation-level plugins out, as they do machines. A level
  whose plugin has a machine option and names none cannot save its options until one is picked: Save
  waits for it, as the server refuses them without one (issue #174). UI only: the stored
  `escalationLevels` is unchanged, so no migration. The form is shared with the Plugins and Routing views:
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

### Settings (issue #151)

Owner request: escalation levels, history and the related configuration do not belong on the
question page; one configuration plane organizes them, and models are chosen from what is
available, not typed.

**Settings** (`ui/src/views/settings.tsx`) is one entry in the main navigation with a section per
part, each routed by hash so a link and the back button work: `#settings/version` what is running,
its update channel and an available update — the first section and the default for `#settings` (issue
#363) —, `#settings/version-history` next, `#settings/questions` the question gates, `#settings/history` the question history,
`#settings/routing`, `#settings/plugins`, `#settings/webhooks` — the views that were their own
navigation entries before. The Questions view holds the open questions only. Machines, Sources and
Usage stay their own views: each is mostly live state, with its configuration beside it. The view
of a hash is the part before the slash (`useView`, `useSection` in `ui/src/app/nav.tsx`).

Every option a plugin lists **option choices** for (design.md "Plugin contract") is a select in
every options form — a level's `model` and the gate router's `model` among them.

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
- **Secrets (issue #56, "Secrets"; superseded by issue #451, "Webhook signing secrets": the signing
  secret is the hopper's own, typed in or made in the UI, sealed in the database).** The hopper makes, keeps and hands out no secret. An entry names
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

**Amended by issue #140** ("Usage per executor" below): a reading limits the jobs of the executors it
names, claude-plan's the Claude executors only, and `command-usage` reads any agent framework's.

Owner request: the UI shows the accounts in use and their usage, and usage throttles lanes.

**Built-in usage source `claude-plan`** (`src/plugins/usage-source/claude-plan/`). Claude
subscription usage comes from `claude -p /usage --output-format json --no-session-persistence`: a
local slash command, zero turns, zero tokens; Claude Code refreshes its own OAuth, so hopper
holds no credential. Prior art: `a status-bar script`.
- Options: `bin` (command-bearing, default `claude`), `intervalSeconds` (default 600, min 120),
  `machine` (a machine option, required: this machine as `local`, or an attached one; issue #174),
  `sshBin` and `dockerBin` (command-bearing, default `ssh`, `docker`). Detection: none — never a
  call to claude; claude is on that machine, and the source's state says whether it runs.
- **On an attached machine** (issue #139): on one, both calls run there through its
  connection — `commandOn`, as the command executor: ssh with the hopper's ssh key, or `docker exec` —
  in a fresh `mktemp -d` dir there, removed after with the project dir claude keeps for it. **A client
  target** (issue #366) runs no command for the hopper, so both calls go to its client as `POST /claude`
  ("Client targets"), found through the usage-source context's `client(id)`: the client runs its own
  `claude` (`bin` is the hopper's, not the machine's). Not dialled in, refused, or no answer →
  `machine <id>: …`, no readings, read again 30 s later. Its `PATH` is the machine's own. The machine is found
  through the usage-source context's `machine(id)` (as the machine sources list it now); not
  configured or offline → no readings and the reason, and it is read again 30 s later (on a poll), not
  an interval later: at start an attached machine is offline until its first probe. Every reading carries `machineId`, and the
  account's detail names the `machine`. A machine with throttling readings of its own is capped by
  those alone, not by the readings of every machine (decider step 1): one Claude account per machine.
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
  status — so a custom plugin's appears the same way. GitHub: the connected account's source names
  the account, and its pause reason (issue #359: the gh source and its `whoami` are gone); the
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

### Usage per executor (issue #140, 2026-10-05)

Owner request: "Do not assume Claude. Assigned machines may run a myriad of frameworks. Account
usage and related machine handling must not be Claude-only." Before, every claude-plan reading
throttled every machine: a Claude budget at its hard limit stopped a machine's Codex or `command`
jobs too, and Claude was the only framework whose usage the hopper could read.

- **A usage reading names the executors whose jobs it limits** (`UsageReading.executors`, glossary
  "Usage reading"): the executor instances of one **agent framework**, as a rule. Absent: every job,
  as before — a custom usage source that sets none keeps its meaning.
- **The decider caps per executor** (`src/decider/usage.ts` `laneEffect`). Steps 1-2 run once per
  executor the machine runs, over the readings that limit it; a job starts only while its machine has
  room *and* its executor's jobs there hold fewer lanes than the executor's cap. The machine's own cap
  is its least limited executor's, so its lanes stay while any executor may use them; a machine that
  runs no executor is capped by the readings that limit every job. Draining (step 8): an executor past
  its cap drains its own busy lanes, newest first; then the machine drains what is still past its cap.
  A Decision's reasons add a line per executor whose cap differs from its machine's.
- **`GET /api/usage` `machines[].executors`**: `{ executor, usedFrac, cap, band }` per executor the
  machine runs, in its order (`ExecutorLaneEffect`); the machine's `usedFrac`, `cap` and `band` are
  its least limited executor's. The Usage view adds a line under a machine for each executor whose
  cap differs from it (`executorEffectLines`).
- **claude-plan** gains `executors` (plain option, default `[herdr-claude]`, the built-in Claude Code
  executor instance): its readings limit Claude jobs only. A stored plugins.yaml needs no migration:
  the default applies to an instance without the option; one whose Claude executor has another name
  names it.
- **Built-in usage source `command-usage`** (`src/plugins/usage-source/command-usage/`): any agent
  framework's budget and account, from a command the operator supplies. Options: `command` (argv, no
  shell, command-bearing, required), `intervalSeconds` (default 600, min 60), `executors` (optional;
  absent = every job). It prints `{ readings: [{ used, limit, unit, window?, resetsAt?,
  informational? }], account?: { service, identity?, detail?, problem? } }`; anything else, a non-zero
  exit or a timeout (45 s) → no readings and the reason in `state().problem`. Detection is `which` of
  `command[0]` only. Runs in `<scratchDir>/probe` (0700). Readings are named after the instance; the
  account appears on `GET /api/accounts` as any usage source's.
- **Shared**: `usage-source/polled.ts` is the background refresh both built-ins use (one read at
  create, then every interval; `poll` never waits; a budget past its reset left out; stale after 3
  intervals); `usage-source/run.ts` the argv-only runner.
- **With a machine's own readings** (issue #139): step 1 filters to the readings that limit the
  executor first, then `readingsOf` applies — a machine with throttling readings of its own *for that
  executor* is capped by those alone, else by those of every machine. A machine's own Claude account
  then caps its Claude jobs, and a budget of another framework read for every machine still caps that
  framework's jobs there. claude-plan with `machine` runs through `polled.ts` like the rest; a
  machine not yet listed or probed online is read again after 30 s, not a full interval.
- **Not changed**: the herdr executor stays Claude Code's (its screen protocol parses Claude Code's
  TUI): another agent CLI is another executor plugin (`cursor-agent` is Cursor's), and
  `command-usage` gives it a budget.

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

- **The ssh target is never typed** (amended by issue #293, "Machines with no durable ~/.ssh": a plain
  `[user@]host` may be typed, which can carry no option). The add form offers only detected ssh targets, and the route
  refuses any other value: an ssh destination is command-bearing-adjacent (`-oProxyCommand=…`, a
  host that runs whatever it likes). Adding a Host alias stays a `~/.ssh/config` edit.
- **`herdrBin` is never taken from the UI** (amended by issue #311: there is no `herdrBin`; the add
  checks herdr is found by name, as every call finds it, and stores no path). On add the daemon resolves it over ssh, with the same
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

### The machines API names a connection, not a plugin (issue #206, 2026-10-05)

`GET /api/machines/config` `machines` is `ConfiguredMachine[]` (`src/domain/machines.ts`):
`{ name, connection, options? }`. `connection` is the machine-source plugin's id — `local`, `ssh`,
`docker`, `client`, or a custom one's — but the Machines view and its API speak of how a machine is
reached (glossary "Connection"), not of plugins; the plugins config and `GET /api/plugins` keep
`plugin`. The Machines view shows no "plugin" line: the ssh target, container or client line already
says how each machine is reached.

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

### Editing a machine: its name and every detail (issue #205, 2026-10-05)

Owner request: a machine's details are editable after it is added — its name, ssh target, herdr session
and the rest. The details were already options (issue #198: command-bearing ones too), but the Machines
view's Edit form showed lanes, executors and label only, and nothing renamed an instance.

- **Rename** is the `options` plugins edit with `rename: <new name>` (role `machine-source` only, else
  400): the instance's options and its name in one write, against `version`. Every machine option naming
  it (issue #174) and every routing rule whose `set.machine` names it follow in the same write; a section
  that was absent is written out, as `place` does. The same name is a plain options edit.
- **Refused (409, naming the jobs)** while the machine is in use as for a removal (a busy or draining
  lane, a waiting pane there) or while a job not ended is pinned to it (`spec.machineId`): those name the
  machine by id, and the job spec is not rewritten. A name another machine has: 409.
- **Persisted state**: lanes are stored under the machine id, so the old id's idle lanes are closed as
  any gone machine's (`planGoneLanes`) and the new id opens its own. Events keep the id they were
  written with. No migration: nothing stored changes shape.
- **UI**: the Edit form (`EditMachineForm`) shows the name, label, lanes, executors and the plugin's
  details (`DETAILS` in `ui/src/model/machines.ts`): ssh — ssh target (detected targets offered, any
  destination typed), herdr session, host key, a "runs herdr" switch (no herdr binary since issue #311); docker — container;
  client — token variable. An emptied optional detail goes (its default). The local machine's form
  (`LocalMachineForm`) edits its name and lane count. A changed ssh target is not re-probed: its host
  key is edited beside it, and without the right one the hopper does not connect.

### Adding this machine (issue #260, 2026-10-06)

Owner request: this machine is added from the Machines view as easily as any other — no ssh target to
pick, a name typed, and the herdr session named there created by the hopper — so that a hopper whose
plugins config names no machine (a wipe, `HOPPER_LOCAL_MACHINE=false` at the first boot) can run jobs
again without editing anything by hand.

- **`POST /ui/api/machines` without `ssh`** adds **this machine**: `{ name, session?, lanes?,
  executors?, label?, version }` → a `local` instance named `name` with options `{ lanes (default 4),
  executors?, session (default hopper), label? }`. 409 while a `local` instance exists ("this machine
  is already added, as <name>") or the name is taken; 400 for the default session or a session that is
  not a plain name (`HERDR_SESSION`: letters, digits, `.`, `_`, `-`). With `ssh` the body is as before,
  and still never carries `session`.
- **The herdr session is started** before the instance is written, when a configured executor is a
  herdr-claude instance (`ensureHerdrSession`, `src/executors/herdr/session.ts`): `herdr --session <s>
  status server`, and when it is not running `herdr --session <s> server` — as the transient user unit
  `hopper-herdr-<s>` through `systemd-run --user` where there is a user manager, so it outlives a
  restart of the daemon, else a detached process —, then waited for (10 s). One that does not start
  refuses the add with the reason (409), nothing written. While it is a machine the `local` source
  checks again, at most every 30 s and never blocking a Decision, and starts it when it stopped.
- **Its jobs run in that session.** The `local` plugin's optional `session` option is listed on its
  snapshot as `herdr: { bin: 'herdr', session }` (no `ssh`); herdr-claude runs a job there through a
  client of that session (`local(session)`), the instance's own when they are the same. Pane state
  records the session, so resume, reattach and cleanup reach the same server. Absent, the instance's
  own session, as before. The local Edit form changes it too.
- **Parts that run on a machine follow it.** Each escalation level and usage source in the plugins
  config whose machine option is unset gets the new machine's name in the same write.
- **Adding a machine over ssh needs no key setting** ("Target authentication", amended): without
  `HOPPER_SSH_KEY_FILE` the hopper offers the key files `ssh -G <target>` names that exist — what the
  user's own `ssh <target>` uses —, still never the agent; without any, the reason says to create one
  with ssh-keygen and install it on the target. A failed add reads `could not add <name>: <reason>`.
  No error a person sees points at a document.

### Knowing this machine, and the container (issue #275, 2026-10-06)

Owner request: detect when the hopper is on the machine, so adding it needs no ssh; containers stay
tricky and need a path of their own, which the detection does not give them.

- **An ssh target that is this machine is detected** (`isThisMachine`, `src/machines/this-machine.ts`):
  what `ssh -G <target>` makes of it — the user's own ssh config, nothing reached — is this host when its
  User is the user the hopper runs as, its Port is 22, and its HostName is `localhost`, this host's own
  name, a loopback or interface address of this host, or a name that resolves (within 2 s) to one.
  Another user is another account; another port is another machine (a container's published sshd); a
  target that cannot be resolved, or goes through a ProxyJump or ProxyCommand, is not this machine.
- **`GET /api/machines/config`** lists them as `ssh.here`. The Add form marks such a target "(this
  machine)", says it is added with no ssh, and sends it as before.
- **`POST /ui/api/machines` with such a target adds this machine** (issue #260's path): a `local` instance
  under the name given, its lanes and executors as sent, the herdr session `hopper`, started first;
  nothing is reached over ssh and no host key is pinned. While a machine is this one already it is
  refused: `ssh target <t> is this machine, already added as <name>`.
- **In a container** (`HOPPER_LOCAL_MACHINE=false`, issue #141) this machine is the container, which is
  not a machine. Nothing is detected as this machine there: with host networking the container would
  share the computer's addresses and pass for it. Adding this machine is refused (409) and
  `thisMachineRefused` says why and what works: attach the computer the container runs on over ssh — a
  Host in the container's `~/.ssh/config` whose HostName is `host.containers.internal` (Podman) or
  `host.docker.internal` (Docker), with a key of the container's the computer accepts — or as a client
  target. The Machines view shows that in place of **Add this machine**.
- **Still open** then, and closed by issue #293 ("Machines with no durable ~/.ssh" below): the
  container path was set up by hand inside the container (a key in the home volume, a Host alias, an
  `ssh` by hand to accept the host key).

### Machines with no durable ~/.ssh (issue #293, 2026-10-06)

Owner direction: the hopper will run in ephemeral containers, so it "can't use .ssh so easily": adding
a machine must not depend on a durable `~/.ssh` (config, keys or known_hosts) on the hopper's host, nor
on a sticky local machine. Everything an ssh target needs is in the database.

- **The hopper's own ssh key** (`src/executors/ssh-key.ts`). When the runtime mounts none
  (`HOPPER_SSH_KEY_FILE`), each user's runtime takes the key kept in their user schema's `settings`
  (`sshKey`: the OpenSSH private key and its public line), or mints one at its start (`ssh-keygen -t
  ed25519`, comment `hopper`) and keeps it there; then writes the private half to
  `<workdir>/<user>/ssh/hopper_ed25519` (mode 600) whenever the file there is not it — a fresh container
  gets the same key back. `hopperSshAuth` offers it (`ownKey`) first, then the key files `ssh -G` names
  that exist (issue #260, so a machine attached with the user's own key keeps working); a mounted key is
  still offered alone. A third stored-secret exception (AGENTS.md "Nothing leans on the machine"): no
  runtime holds it, and a container that keeps nothing cannot keep it either. No route answers it; its
  public half is `GET /api/machines/config` `ssh.publicKey` (absent while a key is mounted), shown in the
  Add form as the authorized_keys line `restrict <public key>`. A key that cannot be minted (no
  ssh-keygen) is logged; ssh then falls back to `~/.ssh` as before. A target that refuses the key fails
  the add with `<target> does not accept the hopper's ssh key: add the hopper's public key, shown in the
  Add machine form, to ~/.ssh/authorized_keys there`.
- **A typed ssh target.** `POST /ui/api/machines` takes a detected ssh target or a typed plain
  `[user@]host` (`isPlainTarget`: the same name ssh-safe pattern every connection checks, so it can carry
  no option; no port: port 22, or a `~/.ssh/config` alias for another). The destination is still
  resolved by `ssh -G` (the user's config when there is one, else none), so a typed name matching a
  pattern with a ProxyJump or ProxyCommand is refused as before. The Add form's ssh target is a text
  field offering the detected targets.
- **A confirmed host key.** `POST /ui/api/machines/host-key { ssh }` (admin; writes nothing) answers a
  **host key offer** `{ ssh, hostKey, fingerprint, known }`: the key `~/.ssh/known_hosts` holds for the
  resolved host (`known: true`), else the one the target presents now (`ssh-keyscan -T 5 -p <port> -t
  ed25519,ecdsa,rsa`, ed25519 first; `known: false`) with its SHA256 fingerprint as `ssh-keygen -l`
  prints it. The Add form asks for it on **Attach machine**; known, it attaches as before; not known, it
  shows the fingerprint and how to check it on the machine (`ssh-keygen -lf
  /etc/ssh/ssh_host_<type>_key.pub`), and **Trust this key and attach** sends the add with `hostKey`.
  The add pins that key and connects only to a target presenting it (`resolveSshTarget`, as before);
  without `hostKey` it pins the known_hosts one, and a target known_hosts lacks is refused. **Residual
  risk:** the person must check the fingerprint; one who confirms it unchecked trusts whatever answered
  that address at that moment.
- **In the container** `thisMachineRefused` now says to type the computer's target as
  `you@host.containers.internal` (Podman) or `you@host.docker.internal` (Docker), add the hopper's key
  there and confirm the host key — nothing inside the container. deploy.md and README "An ssh target"
  say the same.
- **Not changed.** A client target's tunnel still dials the hopper's host over ssh, with its key in that
  host's authorized_keys (`scripts/attach-client.sh`): that leans on the hopper's host, and stays open
  for a hopper in an ephemeral container. Container targets need the hopper's docker socket, as before.

### Router, queue sorter and routing rules (issue #18)

Owner request: the router, queue sorter and routing rules can be set in the UI; lane rules are out of
scope. So no rule targets a lane.

**Router.** The Routing view lists every router plugin with its detection. One that cannot run is
shown with its reason or its setup command and is never offered (on the hopper host `gate-router` is
unavailable while the Jev checkout is missing, so the reason is on screen). Selecting a router uses
`POST /ui/api/plugins` `select`; the configured
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
    set: { priority: 90, machine: laptop }               # any of: machine, executor, priority, workTree
```

- `match` fields are case-insensitive, and every field given must match. `source` is the
  job-source instance name. In `repo`, `*` matches any run of characters, the slash included.
  `label` means the item has that label. `title` is a substring match. An empty `match` matches
  every item. `set` needs at least one field: `machine` (a configured machine id, which becomes the
  `spec.machineId` pin), `executor` (a configured executor instance), `priority` (0..100), or
  `workTree` (an absolute path or one under `~`: the job's own work tree, issue #324; only with
  `machine`, since a path is one machine's, issue #361). The schema is strict, so a `lane` anywhere is
  refused.
- **The first matching rule wins.** Rules are applied at intake (`SourceHost.ingest`,
  `src/engine/source-host.ts`), when a source item becomes a job. The item's source, repo, labels,
  author and title come from `SourceItem`. The job records `spec.routedBy { rule, set }` (additive
  in `job.queued`, still v1), and the UI shows it on the job. A source re-sort does not change a
  priority that a rule set.
- **New jobs, and waiting jobs that have not started** (issue #375). A rule change reaches a
  queued or held job that has never started on the next sync of its source, as the source's own
  options do (**Waiting jobs take the config as it is now**, "Job sources"). A started job keeps how
  it was routed. The UI copy says so.
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

## Sign-in: realms (issues #39, #53, #185, #200, #215, #216, #237, #238)

### No special admin login; the instance admin (issue #240, 2026-10-06)

Issue #240: there is no special admin login. Requirements: remove the special admin login; the
admin is the first user to sign in with GitHub (issue #239); what the admin can do is issue #241's —
manage instance settings, see aggregated usage across users, not see other users' sensitive data. It
supersedes the special-login part of issue #238.

Inputs, from `main` at `4520f86`: #238 had removed `hopper login-code` and `scripts/open-ui.sh`; #239
recorded the first GitHub admin and granted their identity role `admin`; #241 added the totals across
users, behind role `admin`. What was left: a login code signed in with role `admin`, and role `admin` was
both the user's own configuration and the instance's. So a new user's login link (Settings → Users) made
its holder an admin of the instance — able to change sign-in, add users, apply updates and read the
totals across users — without being the first GitHub user. Lowering the login link's role instead would
take from added users the setup of their own environment, which #238 gives each user.

Decision (on the issue): keep the roles; gate what is the instance's on how the session signed in and
whose user it is. Issue #242, merged alongside, made admins many — the first GitHub admin is the first
super admin, and any admin makes others admin through their realm's admin rule — so "the admin" of #240
and #241 is every admin a realm grants, and the login code alone is narrowed.

- **The instance admin** (`src/http/instance-admin.ts`): a session whose role allows `admin` and that
  signed in through a realm or no sign-in (its identity is not the login code's) — the first GitHub admin,
  a super admin, an admin of a role rule or of Settings → Sign-in → Admins; or a login-code session whose
  user a super admin (whose realm is on) signs in as — their device link; or, while no super admin's realm
  is on, a login-code session of the oldest user (the default admin account on a hopper from before). A new
  user's login link names a user nobody signed in to through a realm, added after the oldest, so it never
  is; a device link gives at most what its maker's user had.
- **Gated on it**: `POST /ui/api/realms`, `/ui/api/users`, `/ui/api/update`, `/ui/api/plugin-store`, and
  the reads `GET /api/realms`, `/api/users`, `/api/instance` (403; a mutation's refusal carries `needs`
  so the UI keeps the session). Loopback without a session reads them as before.
- **Unchanged**: every other `admin` mutation acts inside the session's own user and stays `admin` —
  plugins, machines, routing, webhooks, the rules, the queue gate, connected accounts, device
  links (gh login, once here, is removed by issue #359). No stored role, session or login code changes; there is no migration. `SessionUser.instanceAdmin`
  tells the UI which of Settings → Sign-in, Users, Updates and the plugin store's actions to offer.

**Residual risk, stated.** A device link of a regular admin reaches only their own user. A hopper from
before whose GitHub admin is recorded no longer lets its default admin account in by login code as an
instance admin: sign in with GitHub. The read-only reports `GET /api/plugin-store` and `GET /api/update`
stay readable by any session, as before.

### No bootstrap login (issue #238, 2026-10-06)

Owner request: "There is no bootstrap login for first start. Each user gets their own whole
environment." Requirements: no bootstrap login — first start creates no bootstrap user or password;
each user gets their own whole environment. The issue's third requirement, an admin pane behind a
special login, was withdrawn by owner direction (issue #240): there is no special admin login, and the
admin is the first person to sign in with GitHub (issue #239), which every hopper offers (issue #214).
What the admin can do is issue #241's, not this one's. This also takes back issue #237's bootstrap with
the login code ("No password user realm" below), which #237's own text marks as superseded by this issue.

- **No bootstrap user** (instance migration 24, `src/store/migration-no-bootstrap.ts`). A new store ends
  with no user: the default admin account that migrations 17 and 21 make on the way is dropped with its
  user schema, which holds nothing yet. A migration function is given the version the store had when the
  run began (`from`, 0 for a new store), so the same migration keeps `admin` on an install from before —
  its work is persisted state, never dropped — and links no sign-in's identity (`none`/`anonymous`) to it,
  which it signed in as there. `UserRepository.admin()`, `Runtimes.admin()` and `IdentityLinks.realmsOf`
  are gone: nothing assumes a user exists. The instance's events go to every user's log and are kept
  nowhere while there is none (`InstanceEvents.append` returns nothing); the newest are read, and the
  plugin store's report taken, from the oldest user's runtime.
- **No bootstrap login code.** The start hands out no login code (`firstSignInLine` and the start's
  first-sign-in decision are gone), on a new hopper or one from before, and no longer turns the login
  code on when nothing else lets anyone in: a code nobody can mint is no way in.
- **No special admin login.** `hopper login-code` and `scripts/open-ui.sh` are gone. A login code still
  exists, minted only from a signed-in session: a device link (for the session's own user) and a new
  user's login link.
- **Each user their own environment.** Every identity's first sign-in makes its user (as since issue
  #158); no sign-in is now one identity like the others — its first visitor makes its user, everyone
  after signs in as that user — instead of always reaching `admin`.
- **The operator CLI** without `--user` acts on the one user; with none yet or several it refuses,
  naming what to do.

**Residual risk, stated.** The first person to sign in with GitHub becomes admin (issue #239): on a new
hopper reachable by others, sign in first. A hopper from before whose operator reached `admin` only by
login code loses that way in: they sign in with GitHub, which makes a new user, and `hopper user transfer
admin <that user>` (daemon stopped) moves `admin`'s work to it (docs/sign-in.md "Who signs in as which
user"). A lockout is mended with a role rule from the CLI or the environment (docs/sign-in.md "The
sign-in config from the CLI").

### No password user realm; the first sign-in is the login code (issue #237, 2026-10-06; the first sign-in gone since issue #238)

Owner request: "Inside the hopper, sign-in is GitHub only. The password user realm is gone." Remove
the password user realm (no username-and-password sign-in for users); bootstrap with the login key
(the one-time login code), not a password realm account; edge realms (SSO, SAML and similar) stay as
set up (#234, #185, #215); inside, users connect and sign in with GitHub (#214). What that settles,
taken from the issue, not asked: the realm type `password`, its accounts and the password fallback
(#219) go; the LDAP realm stays — a directory is an edge realm, its passwords are the directory's, not
accounts the hopper keeps; the login code, already the operator's way in from the host, is the first
sign-in. GitHub sign-in through the hopper's GitHub App is #214's.

- **Gone**: realm type `password` (the schema refuses it, naming `realms.<i>.type`), its accounts
  (`password_accounts`), the account actions of `POST /ui/api/realms`, `POST /ui/api/password`,
  `HOPPER_SIGN_IN_ADMIN_PASSWORD`, `src/auth/password.ts`, `src/auth/fallback.ts` and the `argon2`
  dependency; in the UI, a password realm's accounts and "Change your password". The username and
  password form (`POST /ui/auth/password`) is the LDAP realms' only.
- **Instance migration 22** (`migration-no-password-realm.ts`): every password realm leaves `sign-in`,
  `password_accounts` is dropped, and the identity links of those realms are deleted — a realm added
  later under the same name must not sign in as their users. Users and their work stay. A config left
  with no way in (no realm on, the login code off, no sign-in off) gets the login code on. Sessions of
  the removed realms end at the next start, as for any realm removed.
- **First sign-in** (`prepareSignIn`, `src/auth/start.ts`; minted in `src/main.ts` once the port is
  known): while the login code is on, no sign-in is off, the default admin account has no identity
  linked in a realm that is on (`IdentityLinks.realmsOf`), and no first GitHub admin (#239) signs in
  through one, each start mints a login code for `admin`
  and logs it with its link on the sign-in origin. The Jenkins pattern, with the login code in place
  of a stored key: nothing new is stored but the code's SHA-256, and it expires in 10 minutes.
- **No way in** at start (no realm on, the login code off, no sign-in off) turns the login code on and
  says so: the replacement of #219's invariant. Settings still refuses a change that would end the
  acting admin's own session; the CLI is the way back from a lockout, as before.

**Residual risk, stated.** A fresh code sits in the daemon's log at every start until `admin` signs in
through a realm that is on: whoever reads the journal (or the container's log) within its 10 minutes
can sign in as `admin` — the reach of `hopper login-code`, the host's operator. No password form is
offered unless an LDAP realm is on, so a public URL answers no password attempts by default.

**Since issue #214** a `github` realm is no redirect realm: it is a **device realm** — GitHub's device
flow through the hopper's app, nothing to set but label and role rules, every hopper has one, and the
token becomes the user's connected account ("Sign in with GitHub, and work through
that connection"). What the sections below say of a github redirect realm, its OAuth app and its client
secret is history (migration 23).

### Realm secrets stored, sign-in from the environment (issue #216, 2026-10-06)

Owner request: "Secrets for outside things the hopper runs against still come from the runtime it's
deployed in. Setting up a realm is different." Every realm setting, the client secret included, is set
in the UI and stored in the database; realms and similar launch settings can also be injected through
the environment, the way Grafana takes many of its settings (environment injection, not config files,
no persistent volume assumed); and the first start works like Nexus, Jenkins and Argo, with a random
password for the first admin. Related: #185, #198, #212, #215. The third requirement is the password
fallback of issue #219 ("Password fallback" below), which landed while this was in progress; this adds
only `HOPPER_SIGN_IN_ADMIN_PASSWORD` to it. What the issue left open was taken from those products and
the hopper's existing shapes, not asked:

- **A realm's secrets are its settings** (`clientSecret` for oidc, github and an introspecting gateway,
  `bindPassword` for ldap; `SECRET_SETTINGS`), in the config record `sign-in` like the rest.
  `clientSecretEnv` and `bindPasswordEnv` are gone: the schema refuses them. A realm that is on needs
  its secret (GitHub's always, LDAP's with a bind DN, a gateway's when it introspects); one that is off
  may wait for it, as before. **Write-only:** `GET /api/realms` answers each realm's `settings` without
  them and `secrets: [names set]`; a `save` that leaves one out keeps the stored one, `null` removes it
  (`editSignIn`), and the UI shows a password field that is empty, says whether one is set, and has a
  remove button. A bind password goes with its bind DN. The CLI's `config get sign-in` prints them:
  whoever runs it holds the database's credentials, which open them anyway.
- **Taken in once.** A realm stored before named its secret's variable; at the next start
  (`prepareSignIn`, `src/auth/start.ts`) the daemon reads the variable and stores the secret in its
  place. Not a schema migration: those also run in the CLI, whose environment lacks the daemon's
  variables. A realm that is on with the variable unset stops the daemon, naming it, as it did; one
  that is off drops the name.
- **Sign-in from the environment** (`src/auth/environment.ts`). `HOPPER_SIGN_IN_REALM_<NAME>_TYPE`
  sets up a realm; `HOPPER_SIGN_IN_REALM_<NAME>_<SETTING>` each of its settings, the field path in upper
  snake case (`claims.groups` → `CLAIMS_GROUPS`), so the variables follow the form's fields with no
  second list of names (the table of fields and their kinds — text, switch, words, list — is the one
  place a new setting is added); `HOPPER_SIGN_IN_LOCAL_ENABLED`, `HOPPER_SIGN_IN_NONE_ROLE` (`off` turns
  it off), `HOPPER_SIGN_IN_ADMIN_PASSWORD` (the password fallback's password when a start adds the
  account; neither logged nor stored but as its hash). Every value through `runtimeSecrets`, so
  `<variable>_FILE` works for each. Read at every start and **applied to the stored config** before the
  fallback and the load: each environment realm replaces the stored realm of its name in place (a
  password realm keeps its accounts) or is added at the end, in name order. Grafana's rule, the
  environment wins, so a deploy's manifests stay the truth; Settings marks those realms
  (`RealmView.environment`), and a change there lasts until the next start. Writing them into the
  database rather than overlaying them in memory keeps one sign-in config with one `version`, and
  leaves the realm in place if the variables go. Each environment realm is checked alone first, so a
  refusal names the variable, not `realms.3.issuer`; a refusal stops the daemon and writes nothing.
  `loadConfig` leaves `HOPPER_SIGN_IN_*` out of the leftover-variable warning.

**Residual risk, stated.** The database and its backups now hold the realms' secrets in clear: whoever
reads the database can use those realms' client registrations and the LDAP search account. Sealing
them would need a key from the runtime, which is the dependency the owner asked to drop for realms;
database access is already the instance's highest trust (the CLI holds it). No route answers a stored
secret: `GET /api/realms` names which are set, never their values.

### Behind an auth gateway (issue #215, 2026-10-06)

Owner request: the server must be able to run downstream of an auth boundary — for example Envoy
Gateway with OIDC plugged in. Tokens are obtained outside the hopper, at the gateway; the hopper only
introspects or validates them and runs no sign-in of its own in that setup. Related: #185. What that
settles, taken from the issue, not asked: a new realm type, so it sits in the ordered list with the
others, is managed in Settings → Sign-in, grants roles by the same role rules, and composes with them;
both checks the issue names (validate a JWT, introspect a token).

- **A third kind of realm: the gateway realm** (`type: gateway`, port `GatewayRealm` in
  `src/auth/realm.ts`, adapter `src/auth/gateway.ts`). Neither a form realm nor a redirect realm:
  it has no form, no flow, no callback. Settings: `issuer` (https, or http to loopback), `check`
  (`jwt` default, or `introspection`), `audience` (required for `jwt`; checked for `introspection`
  when set), `header` (default `authorization`, carrying `Bearer <token>`; any other header carries the
  token alone — oauth2-proxy's `x-forwarded-access-token`), `clientId` and `clientSecret` (stored since issue #216)
  (introspection only, both required), `claims` and `trustUnverifiedEmail` as for `oidc`, `roles`.
- **Libraries.** The issuer's discovery document through `openid-client` (on first use, retried after
  a failure, as for `oidc`). `jwt`: `jose` `jwtVerify` against `createRemoteJWKSet(jwks_uri)` — the
  signature, `iss` (the discovered issuer), `aud`, `exp`, `nbf`, 30 s clock tolerance. `introspection`:
  `openid-client` `tokenIntrospection`, the client authenticated with HTTP Basic; `active` must be
  `true`. `jose` was already in the tree under `openid-client`; it is now a direct dependency.
- **The exchange.** `POST /ui/auth/gateway` (no session, the sign-in rate limit, exact UI Origin like
  no sign-in and password sign-in): every gateway realm that is on checks the token on the request, in
  order; the first that accepts it decides (no role: no session, 403). None accepting: 403 with each
  realm's reason (no token, refused, not active, another audience); none accepting while an issuer
  could not be reached: 502 naming the realm. The identity is `{ realm, subject: sub, … }` from the
  claims, built as the oidc realm builds it (`claimsIdentity`). The answer is the usual
  `{ token, expiresAt, user }`: the gateway's token becomes an ordinary UI session, so the mutation
  guard (session header, exact Origin, role) is unchanged.
- **The UI** reads `signIn.gateway` (`SessionView`) and, logged out, takes the session by itself (as for
  no sign-in, tried first); the sign-in banner offers "Sign in through the gateway" to try again. The
  gateway realm is no sign-in button (`signIn.realms` is the redirect realms only) and has no callback
  URL in Settings.

**Residual risk, stated.** The token is the credential: whoever reaches the port with a valid token for
the audience signs in, through the gateway or not; deploy so only the gateway reaches the hopper. A
hopper session outlives the token and the gateway's own session until it expires, the realm changes or
the daemon restarts, as for every realm; logging out of the hopper does not log out of the gateway, and
the next visit takes a new session. With `introspection`, the issuer is asked once per exchange, not
per request.


### Session lifetime (issue #439, 2026-10-08)

Sessions ended too early: a fixed `HOPPER_UI_SESSION_HOURS` (12) set at creation, never extended, and only
changeable by a restart. What is settled, of the issue's options: the hopper's own sliding session, plus a
re-check of the gateway's token for a gateway realm's sessions:

- **The session is the hopper's own.** No realm keeps the provider's access, ID or refresh token for it: an
  OIDC realm reads who signed in and drops them, as before. Storing refresh tokens would be a fifth stored
  secret ("Secrets"), and only OIDC has a refresh grant (not GitHub's device flow, LDAP or SAML). The cost,
  accepted: a person revoked at an OIDC or SAML provider keeps a session until it is idle, reaches its
  maximum, or the sign-in config changes under it.
- **Sliding renewal plus an absolute maximum.** `ui_sessions` keeps `started_at`, `last_seen_at`,
  `checked_at` and, for the operator CLI's alone, `ends_at` (migration 27 replaced `expires_at`; live
  sessions stay, counted from the migration). A session ends at `last_seen_at + idleHours` or at
  `min(started_at + maxHours, ends_at)`, whichever is first. The Host guard's hook renews every request's
  session before anything reads it (`UiSessions.renew`), writing at most every `RENEW_EVERY_MS` (60 s, or a
  tenth of the idle timeout when that is shorter).
- **The lengths are a setting in the database**: the sign-in config's `sessions: { idleHours, maxHours }`
  (defaults 168 and 720, at most 8760, idle ≤ max), one pair for the instance, edited in Settings → Sign-in
  through the realms edit's `settings` action. They are read at each lookup, so a change applies to new and
  existing sessions without a restart. Per-realm lengths waited for a case that needs them.
  `HOPPER_UI_SESSION_HOURS` is not read (a leftover variable, warned at boot), and seeds nothing.
- **A gateway realm stays the authority.** Its session renews only when the forwarded token checks out
  again (`SignIn.checkGateway`) for the same realm and subject; refused → `refresh-refused`. An issuer out
  of reach (the check's 502) leaves the session as it is, unrenewed, until `GATEWAY_GRACE_MS` (5 minutes)
  after the last good check (`checked_at`) → `provider-unreachable`. A provider briefly down ends nothing.
- **Every end has a reason**: `expired-idle`, `expired-absolute`, `refresh-refused`, `provider-unreachable`,
  `realm-changed` (a reconcile), `logout` — logged, and the event `ui_session.ended { reason, realm }` in
  the session user's event log. Expired sessions no request names end in a sweep on lookup, at most once
  per renewal interval, so each still gets its event. A token no row holds is logged once per token; it has
  no user to record an event for.
- **The UI signs in again at once.** A refused call (a 403 without `needs`, or a 401 on a read that sent a
  session), or its own check of `GET /ui/api/session` every minute and when the page is shown again, sends
  it to sign-in with the session's realm (`ui/src/lib/reauth.ts`): the identity provider for an OIDC, SAML
  or redirecting GitHub realm, a reload through the gateway, else the landing page. The page it was on is
  kept in `localStorage` (`jh_return`) across the round trip and opened once signed in.

### The API door: a token reads as the user it signs in as (issue #255, 2026-10-06)

Owner request: a GitHub OIDC token that signs a person in to the UI must authenticate them against the
API too, as the same identity: one pipeline, two doors. What that settles, taken from the issue, not asked:

- **GitHub issues no OIDC token for a person.** Signing in with GitHub (issue #214) grants a GitHub token
  through the hopper's app, which GitHub's API vouches for (`GET /user`); it is no JWT and has no keys to
  check against. The JWTs a JWKS checks are an OIDC issuer's, which the hopper takes through a **gateway
  realm** (issue #215) — GitHub Actions' issuer among them, whose subject is a workflow, not a person. So
  the API door takes both, each through the check the UI door already makes.
- **One check, `SignIn.checkToken`** (`src/auth/index.ts`): the token in `Authorization: Bearer …`. A JWT
  goes to the gateway realms that are on (`checkGateway`, the same function `POST /ui/auth/gateway`
  calls: `jose` against the issuer's JWKS, `iss`, `aud`, `exp`); any other token to GitHub for the first
  GitHub realm that is on (`whoIs`, as `grantedTo` asks after a device or web sign-in; the identity built
  by the same `githubIdentity`). The role is `roleOf`, as for every sign-in. GitHub's answer is kept a
  minute per token hash (at most 1000), emptied when the sign-in config changes; a JWT is checked each time.
- **The HTTP edge** (`installTenancy`, `src/http/tenants.ts`): a session wins; else a read of `/api/` with
  `Authorization` is the API door. The identity reads as the user it is **linked** to
  (`Tenants.linked`); the door signs nobody in and provisions no user — a person signs in through the UI
  first. A GitHub identity reads only as the user whose **connected account** is that GitHub account
  (`connectedAccounts.get('github').subject`): disconnecting GitHub closes the door for its tokens. The
  Host guard lets a LAN or public `/api/` request with `Authorization` through to that check.
- **Answers.** 401: no token, a token every check refuses (the gateway realms' reasons, as the UI door
  gives them), a token GitHub does not accept, or an identity not linked (not tied to a connected
  GitHub account); 403: accepted, but the sign-in config grants no role; 502: the issuer or GitHub could
  not be asked. A token given and refused is refused on loopback too, where one user's hopper otherwise
  reads without a credential.
- **Reads only.** The token is no UI session: every `POST /ui/api/*` still needs one (AGENTS.md). The
  role still counts: the instance reads (`/api/users`, `/api/instance`, `/api/realms`) read it from the
  request (`roleOfRequest`), so a viewer's token is refused there as a viewer's session is.
- **Coherence, tested** (`test/integration/api-bearer.test.ts`): the same token reads as the user its UI
  sign-in made, only that user's work; the UI door's refusal reason is the API door's; turning the realm
  off or changing a rule closes both doors at once.

**Residual risk, stated.** A GitHub token revoked at GitHub reads for up to a minute more. Any GitHub
token of the account reads — the hopper's app's, the gh CLI's, a personal access token —: GitHub says
whose it is, not which app it is for. Reads only, and only as the connected account's user.

**Not built.** A GitHub Actions OIDC token reading as the person who started the workflow (its `actor_id`
mapped to a connected account): a gateway realm for Actions' issuer reads only as the identity its
`sub` names, linked like any other.


### Password fallback (issue #219, 2026-10-06)

Superseded by issue #237 (above): there is no password realm, and the first sign-in is the login code.

Owner request: "Password sign-in is the fallback. Right now the password realm starts with no
accounts, so the username and password form never appears, and the only ways in are a login code or a
link from an already signed-in browser. Requirement: the password fallback always exists." Related:
#216 (bootstrap with a random password, like Nexus, Jenkins and Argo). What that settles, taken from
the issue, not asked: the invariant is an **admin account in a password realm that is on** — a
fallback that cannot fix sign-in is not one — and the first one is made the way #216 names.

- **The invariant** — `hasPasswordFallback` (`src/auth/fallback.ts`, pure, on `StoredSignIn`).
- **At start** (`ensurePasswordFallback`, `src/main.ts`, before the sign-in config loads): a config
  without it gets it from `withPasswordFallback` — the account `admin` (`admin-2`, … when taken) in the
  first password realm, turned on, or in a new realm `password` ("Password") after the others; role
  admin; its identity linked to the default admin account (`IdentityLinks.replace`), so the sign-in is
  `admin`'s, not a new user's. Written against the version read, in one transaction with the link. Its password is 18
  random bytes, base64url, shown once in a start line (`console.warn`); only the argon2id hash is
  stored. Every start checks, so a config made without it by `hopper config set sign-in`, or by
  migration 20, gets it at the next start.
- **In Settings → Sign-in**: `POST /ui/api/realms` refuses (409) a change after which the config
  would not hold it, checked after the self-lockout guard: turning off or removing the last such
  realm, removing or demoting the last admin account in one.
- **The login code is unchanged**: still on by default, still the operator's way in from the host.

**Residual risk, stated.** The first password sits in the daemon's log until rotated: whoever reads
the journal (or the container's log) before the admin changes it can sign in as `admin`, role admin. That is
the Jenkins and Argo trade, and the same reach as `hopper login-code` (the host's operator). The form
is now always offered, so a public URL always answers password attempts; argon2id and the sign-in
rate limit bound them. The lockout guard for the acting session still applies; this guard is for
everyone else.

### Password accounts and realm forms (issue #200, 2026-10-05)

The password accounts are gone since issue #237 (above); the realm forms stay.

Owner request: the default sign-in did not work — a password realm needed `hopper password-hash` on
the host and its hash pasted into a realm's text (YAML, then JSON after #198). "There needs to be a
users table. Auth configs should not be YAML files. They need actual fields to fill out." Related:
#198 (no config files), #185, #167. What that settles, taken from the issue, not asked: a password
realm's accounts become a table an admin fills in the UI, with passwords the daemon hashes, and every
realm setting is a form field; nobody writes YAML or JSON to sign people in.

- **A table of accounts** (`password_accounts`: `realm`, `username`, `password_hash`, `role`). The
  config record `sign-in` keeps the realms, the login code and no sign-in, never an account.
  `InstanceStore.signInConfig` (`src/store/sign-in-config.ts`, port `SignInConfigRepository`) reads
  both as one value — each password realm with its accounts in `users`, the shape
  `loadSignInConfig` checks, so one zod schema still decides — and writes both in one transaction
  under `LOCK TABLE password_accounts`, the record by compare-and-swap, against one `version` (the
  sha-256 of what it reads).
- **Accounts in the UI.** `POST /ui/api/realms` gains `account` (add: username, password, role, and
  optionally `user` — the existing user it signs in as, linked in `user_identities` at once
  (`IdentityLinks.replace`); change: role and, when given, a new password) and `account-remove`. The
  password (8 characters or more) is hashed at the HTTP edge (`hashPassword`, argon2id); only the
  hash is stored or loaded. `GET /api/realms` shows each account's username, role and linked user,
  never a hash. An account's user is fixed once linked (a sign-in links it, as before): naming
  another is refused (400). A password realm with no account is not tried (one with an admin account
  always exists since issue #219: "Password fallback" above).
- **Fields, not JSON.** `save` takes the realm as an object (`realm: { name, label?, type, …settings }`),
  not a text entry; `GET /api/realms` answers each realm's `settings` (`RealmView.entry` is gone). The
  UI renders one form per realm type from a field list (`ui/src/model/realms.ts`: label, path, kind,
  the default as placeholder) and role rules as rows (role, what it matches, one value per line) with
  a default role. An empty field is left out, so the daemon's default applies.
- **Starts working.** Migration 20 (`src/store/migration-accounts.ts`) moves each password realm's
  `users` out of `sign-in` into rows; a hopper with no `sign-in` record gets one with the realm
  `password` ("Password") and no accounts; the start after it adds the account `admin` (issue #219,
  "Password fallback" above).
- **The CLI** keeps `hopper config … sign-in` for the record (the way back from a lockout) and refuses
  a record that carries accounts. `hopper password-hash` is gone, and with it the `read` dependency.

Where "Config in the database: no config files" says Settings edits a realm as JSON, this section holds.


### Realms (issue #185, 2026-10-05)

Owner request: authentication realms for sign-in, with OIDC, SAML and similar as realm types, the way
Sonatype Nexus or Jenkins handle it. What that settles, taken from both: a **realm** is one named way
of checking who signs in, of a **realm type**; the realms form an **ordered list**, each **on or off**;
an admin manages them **in the UI**, and a change applies **without a restart**. What the issue left
open was taken from the obvious reading, not asked: the types are the ones the hopper already had plus
LDAP, the one realm both Nexus and Jenkins ship that it lacked; the login code and no sign-in stay
outside the list (Nexus's anonymous access and its bootstrap admin are not realms either).

- **`auth.yaml`** — `realms:` replaces `providers:` and `password:`. Each entry: `name` (a URL path
  segment, fixed once made: identity links and the identity provider's callback URL hold it), `type`,
  `label`, `enabled` (default `true`), the type's settings, and `roles` (role rules; a password realm's
  accounts carry their role instead). Types: `password` (accounts with argon2id hashes), `ldap`, `oidc`,
  `github`, `saml`. Schema: `src/auth/config.ts`. A realm that is off must still be valid, but its
  secret variable is not read, so it can be set up before the variable exists.
- **Two kinds, one port each** (`src/auth/realm.ts`). A **form realm** (`password`, `ldap`) checks a
  username and password: `POST /ui/auth/password` tries every form realm that is on, **in order**, and
  the first that accepts the password decides (when it grants no role: no session — later realms are
  not asked). None accepting is 403 "wrong username or password"; none accepting while one could not be
  reached is **502 naming the realm**, never a false "wrong password". A **redirect realm** (`oidc`,
  `github`, `saml`) sends the browser to its identity provider (the flow below, unchanged); the sign-in
  buttons are the redirect realms that are on, in order.
- **LDAP** (`src/auth/ldap.ts`, `ldapts`): search, then bind — bind as `bindDn` (password from
  `bindPasswordEnv`) or anonymously, find exactly one entry `userFilter` (`{username}` escaped by the
  library's filter escape) names under `userBase`, bind as that entry with the password. An empty
  password is refused before any bind: a directory takes it as an anonymous bind. Identity: `subject` =
  `attributes.subject` (e.g. `entryUUID`, `objectGUID`) else the DN; `groups` = the entry's
  `attributes.groups` values (default `memberOf`, full DNs), plus a `groupSearch` (`filter` default
  `(member={dn})`, the group's `name` attribute) when set; the email counts as verified (the directory
  vouches for it). `ldaps://`, or `ldap://` with `startTls: true`; plain `ldap://` only to loopback. A
  fresh connection per sign-in, 10 s timeouts.
- **Managed in the UI** — Settings → Sign-in, admin only. `GET /api/realms` (an admin session, or
  loopback): `RealmsView` — each realm's entry as YAML, on or off, the callback (and SAML metadata) URL
  to register; local sign-in, no sign-in, the document version. `POST /ui/api/realms` (admin):
  `save` (add from a YAML entry, or replace by name — the name stays), `remove`, `move`, `enable`,
  `settings` (local sign-in, no sign-in), each against the `version` read. The edit is made on the YAML
  document (`src/auth/edit.ts`, comments kept), then **loaded with its secrets** — a document that would
  not load is refused with the load's own message, naming the field — then written if the version still
  holds (else 409), applied to the sign-in service (`SignIn.apply`), and applied to the stored sessions
  as a start would (`reconcile`). Journal line per change.
- **No self-lockout.** A change after which the acting session's identity would not be `admin` is
  refused (409), whatever kind: turning off or removing the realm one signed in with, demoting one's own
  account, turning off the login code while signed in with it. The CLI (`hopper config edit
  auth.yaml`) stays the way back, and needs a restart, as before.
- **Migration 18** (`src/store/migration-realms.ts`): a stored `auth.yaml`'s `password` section becomes
  the first realm, named `password` (label "Password"), and its `providers` follow in order, comments
  kept; `user_identities.provider` becomes `realm`, and every stored session's identity names `realm`.
  A password sign-in's identity was named `password` before, so its links and sessions keep working.
  `Identity.provider`, `SessionUser.provider` and `SessionView.signIn.providers` are `realm` and
  `realms` now; no shim.

**Residual risk, stated.** An admin can now change who signs in from the browser: an admin session is
as strong as the weakest realm that grants admin. The lockout guard protects the acting session only;
another admin's session can be ended by a change, by design (that is how someone is cut off). LDAP
group membership and an LDAP account's state are read at sign-in; a session outlives a change in the
directory until it expires, the realm changes, or the daemon restarts — as for the other realm types.
With several form realms, a wrong password costs every realm's check (the argon2 hash, the directory
round trips), so a timing difference can tell which realm knows a username; the rate limit bounds it.

### Before realms (issues #39, #53, 2026-10-04)

What follows is the sign-in as first built. Realms (above) renamed its identity providers and its
password sign-in section; where they differ, the section above holds.

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
| `admin` | + `queue-gate`, `plugins`, `rules-file`, `webhooks`, `machines`, `routing`, `device-link`, `update`, `plugin-store`, `users` (issue #158: every role acts inside the session's own user; `update`, `plugin-store` and `users` are the instance's) |

A live session whose role is short gets 403 `{ error, needs }` — the UI keeps the session and
toasts; any other 403 still means "log in again". The login code always gives `admin`. A provider's
`roles` (`src/auth/roles.ts`, pure): `admin` / `operator` / `viewer` each match on subjects,
usernames, emails, email domains or groups; the highest match wins; else `defaultRole`; else **no
session**. Only an email the provider vouches for is an Identity's `email`: OIDC needs
`email_verified: true` unless `trustUnverifiedEmail`; GitHub's primary verified email; SAML's
asserted one.

**The first GitHub admin** (issue #239): the first identity a GitHub realm signs in is `admin` before
any rule is read, for as long as that realm is on. The callback records it once — `githubAdmin` in the
config record `sign-in` (`src/auth/github-admin.ts`), written by compare-and-swap in one transaction —
and only while no record exists and no identity of a GitHub realm is linked to a user. The second
condition is the update path: a hopper with earlier GitHub sign-ins records nobody, so the update
promotes no one. It sits in the record, not in a realm's `roles`, because realms from the environment
replace the stored realm at every start; the top-level field survives that.

**Super admins** (issue #242): two tiers of admin. `superAdmins` in the record (realm and subject each;
absent: `[githubAdmin]`, so the first GitHub admin is the first super admin with no migration) lists
identities that are `admin` whatever their realm's rules, while that realm is on (`isSuperAdmin`,
`src/auth/index.ts`); not a UI role, a mark on an admin, answered as `SessionUser.superAdmin`. Two
changes ride `POST /ui/api/realms` (least role `admin`): `admin` adds an identity's subject to its realm's
`roles.admin.subjects` — any admin; `super-admin` adds it to `superAdmins`, with `transfer` taking the
acting identity out — only a super admin (403 otherwise). Both name someone who has signed in
(`IdentityLinks`, else 404). A regular admin's change that would change the super admins in effect —
turning off or removing their realm — is refused (403). The login code and no sign-in are never super
admin. `GET /api/realms` lists `people`: every linked identity with the role the config grants it now (by
a live session's identity when there is one, else by subject alone) and whether it is a super admin.

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
`{ kind, repo, branch, commit, installedAt }`, written by `scripts/write-install-json.ts`. `scripts/install.sh`
writes it (`kind: install`) from the clone's `origin`
and `HEAD`; the branch is `stable` unless `HOPPER_UPDATE_BRANCH` names another. An update writes
the new one, with the channel's branch. One without `kind` (from before issue #409) is an install.
No install.json (a checkout run with `npm start`, a clone without `origin`) → state
`unavailable` with the reason; nothing else changes.

**So does an image (issue #409).** Every build knows its repository, branch and commit, however it was built:
the `Dockerfile` takes them as build arguments (`HOPPER_REPO`, default the public repository; `HOPPER_BRANCH`,
default `stable`; `HOPPER_COMMIT`), writes `/app/install.json` (`kind: image`, `installedAt` the build time) and the
OCI labels `org.opencontainers.image.source` and `.revision`. `.github/workflows/image.yml` passes GitHub's;
`scripts/build-image.sh`, the local image build, passes the checkout's (`origin`, a GitHub ssh URL as https —
the image holds no ssh key; `HEAD`; `HOPPER_UPDATE_BRANCH` or `stable`) and tags `HOPPER_IMAGE` (default
`localhost/hopper`). A bare `docker build .` cannot see the commit (`.dockerignore` leaves out `.git`): its
install.json leaves the field out, never guessed. The check and the version history read an image's install.json as an
install's. **Apply** refuses an image: its files are not the hopper's to swap, and it is replaced by pulling or
rebuilding it, so the UI offers no Update now. A build whose install.json
lacks a field → `unavailable`, the reason naming the missing field.

**A container install is updated by its user (issue #494).** Auto-update does not apply to an image: the
updater reports `autoUpdate: false` for it whatever is stored, so a check never applies; a settings patch turning
it on is ignored, not stored; the UI shows no Auto-update switch, only the one-line reason. The update notice and
Settings → Version give the commands instead (`imageUpdate`, `ui/src/model/update.ts`): `HOPPER_IMAGE=` the
selected channel's tag in `.env` (the image tag is the channel; `latest` is `stable`), pull and recreate the
`hopper` service alone (`--no-deps`, so Postgres and the volumes are untouched; `--force-recreate`, which
podman-compose needs to take a newly pulled image), and the optional prune — for one **container tool** at a
time, Podman or Docker, the one this browser chose last (`localStorage` `jh_container_tool`, Podman until Docker
is chosen; issue #521): the hopper cannot see which tool runs it from inside the container, so the viewer picks.
When the running image's branch is not the selected channel, pulling the same tag can never clear the notice, so
it says to switch the image tag. `UpdateStatus.restartBlockers` is the restart-blocker count now, the one an apply
waits on; the commands show it, and ask to wait until it is zero.

**The notice is one line (issue #521).** Above the overview it holds the headline, *What's new*, *How to update*
(an image install) or *Update now* (an install), and Dismiss. What's new and How to update open below the line,
one at a time and closed by default; the commands, the restart-blocker note and the tag mismatch live behind How
to update, as they do in Settings → Version, never as a standing block.

**Detecting.** A bare mirror at `<data dir>/update/repo.git`, fetched from install.json's `repo` on
every check — the git CLI, never prompting (`GIT_TERMINAL_PROMPT=0`, ssh `BatchMode=yes`, and
only the user's ssh config: `-F ~/.ssh/config`, since the unit's `PrivateTmp` puts the daemon in a
user namespace where root-owned `/etc/ssh` files show as owned by nobody and ssh refuses them), so any
git URL the daemon's user can fetch works: GitHub by ssh or https, another host, a local path. A
check runs 10 s after start, then every `HOPPER_UPDATE_CHECK_MS` (default 60000), and from the UI's
Check now. Checking cannot be turned off (issue #177): `0` used to mean "only when asked", and one
hopper left with it set offered nothing merged after it; now `0` (or less) is the default minute, with a
warning in the log. One minute, not fifteen (issue #177): a change merged to the
tracked branch is not shipped until the running hopper offers it, and a 15-minute check left merged work
unoffered for up to that long; a fetch that brings nothing is one round trip. The **update channel** decides the target: `dev`, `beta` or `stable`, the head
of the branch of that name (issues #282, #423). With no channel set, it is the branch install.json names
when that is a channel, else `stable`. An update is
**available** when the installed commit does not contain the target (an install ahead of it, e.g.
from a feature branch, is `current`) — or when install.json names another
channel's branch and the target is not the installed commit: moving from `dev` to `stable` goes back
to `stable`'s head, though the `dev` install contains it (its What's new is then empty; the notice says
"move to the stable channel").

**Channels and promotion (issues #282, #423).** `dev` is the repository's default branch: every pull
request, a job's included, merges there. `beta` is promoted from `dev`, and `stable` from `beta`, each by
a maintainer with `scripts/promote.sh beta|stable [commit]`: a fast-forward to a commit the less steady
branch already has, whose image built there (`docs/deploy.md` "Update channels and promotion" says when). A
hopper moved to a steadier channel can run an older build on a store a newer one migrated, so a store
migration leaves a store the build before it still runs on (AGENTS.md "Persisted state is the user's"). A hopper on `dev` gets every change first; one on `stable` gets only what ran on
`beta`, so a change that breaks is caught before it reaches every hopper. Each of the three branches has
the image tag of its name; the Pages site is published from `stable`. Until issue #423 the channels were
`dev`, `beta`, `main` and `release` (the newest `v<semver>` tag, of which none was published): store
migration 26 sets a hopper on `main` or `release` to `stable`, and `main` was moved once to the commit that
brought it to `stable`, so a hopper on an older version reaches it by following `main` once. **What's new** (issue #104): the bullets of `WHATS-NEW.md`
at the target that `WHATS-NEW.md` at the installed commit lacks, newest first (`whatsNew`; all of
them when the installed commit has no such file) — plain words for people who use the hopper,
written by hand in the change that makes them true (AGENTS.md "What's new"); `src/update/whats-new.ts`.
Commit subjects, hashes and issue numbers are never shown: a merge list is the change's plumbing,
not what changed for its users. **In this
version** (issue #165): the newest 5 bullets of the install's own `WHATS-NEW.md` (`installedWhatsNew`;
`install.sh` and the image copy the file), read once at start — shown whether or not an update
exists, and when self-update is unavailable.
**Version history** (issue #246): `GET /api/update/history`, Settings → Version history — the versions
the installed commit is made of, newest first: each commit on the tracked branch's first-parent line
that added `WHATS-NEW.md` bullets (a merged pull request is one version), with its commit date and
those bullets (`GitMirror.added`). Read from the mirror, so it needs no state of its own and counts an
install by `install.sh` the same as an applied update; a mirror without the installed commit is
checked first. Computed once per installed commit. No install.json, or one lacking a field → none, with the reason. The answer
always carries `build`: what install.json does say (issue #409), shown above the list with the version, every
missing field as `unknown`, and the reason as a short note — never an error in place of the page.
`update.available` is appended once per target, with `changes`: how many commits it adds (the log
line too; never the UI).

**Applying, in flight.** `POST /ui/api/update { action: "apply" }` answers at once; then:

1. The target's tree (`git archive`) is unpacked to `<data dir>/update/source`.
2. The **next install** `<install>.next` is built by the target's own `scripts/install.sh` in
   **build-only mode** (`HOPPER_INSTALL_INTO=<dir>` + `_REPO`, `_BRANCH`, `_COMMIT`): UI bundle,
   production dependencies, install.json — no service, unit or config touched; a UI bundle that fails the UI bundle check ("UI rework") fails the build. Log:
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
("Update available", or the channel it moves to), "What's new" (the bullets), Update now. The header's
version (a bordered button with an info icon, the installed commit from `sm` up) shows on every screen
and opens the Version and updates panel at any time (issue #165): version, installed, installed on,
newest, last check, Check now, Update now, auto-update, channel (`dev` / `beta` / `stable`, each with what it pulls), the
update's notes, the installed version's notes. The same details are Settings → Version (`#settings/version`).
The two release-notes lists (issue #493) scroll with the page or sheet, never in a box of their own. With an
update pending, "Coming in the update · <ref> <commit>" comes first, in a tinted card, and "Already installed ·
<branch> <commit>" follows, muted; with none, the installed list alone reads "In this version · <branch>
<commit>". Each list shows its first five notes and a "Show all N" that opens the rest in place; the notice's
What's new uses the same list.

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
readable only by its one reader), `postgres` (no host port), `hopper` (built from the public repository,
or `HOPPER_SOURCE`). Settings and secrets come from an optional `.env` beside it. Since issue
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

**The container is not a machine (issue #141, replaces the paragraph above).** The container has
none of a machine's abilities — no repositories, no sign-ins of the jobs' own — yet registered itself
as the `local` machine. The image now sets `HOPPER_LOCAL_MACHINE=false`: the built-in instances list
no machine, and the boot removes every `local` instance from plugins.yaml `machines:` (one an earlier
boot of the container wrote), keeping every other line. The entrypoint that started the container's
herdr session is gone. The image keeps herdr's CLI: `herdr-claude` detects it before it runs jobs on
attached machines. A container install runs jobs on attached machines only. Since issue #359 the image
has no gh and no git credential helper for GitHub either: the container reads GitHub only through the
connected account, and a job gets its GitHub token from that connection (`GH_TOKEN`) on its machine.

**Built-in instances: no machine of its own (issue #259).** The hopper no longer registers its own
host as a machine by default. The plugins config the boot writes for a store that has none (a new
hopper's users, a user added later) is the built-in instances with `machines: []`, and its claude-cli
levels and claude-plan usage source name no machine: until one is picked they pick one as they run, or
say plainly that none can (issue #442, "A level that names no machine"). This machine is added like any other, as a `local` instance (the Plugins view's add, or
the Machines view). A config already written is never changed: an existing `local` instance stays,
and a section left out keeps its meaning (`builtinInstances` with `HOPPER_LOCAL_MACHINE`: `local`,
4 lanes, where this host may be a machine), which tenant migration 3 relied on.

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

**The image.** `.github/workflows/image.yml` builds the `Dockerfile` on every push to `dev`, `beta` or
`stable` (and by hand) and pushes `ghcr.io/henningfutrell/hopper`: the tag of the branch's name follows that
branch, `latest` follows `stable` (issue #423), `sha-<commit>` pins one build; `linux/amd64` and `linux/arm64` (QEMU; herdr ships both). A newer push never cancels a build
in progress: runs queue, and GitHub keeps only the newest pending one, so the last commit of a merge
stream is always published (issue #156: cancelling left `latest` hours behind). Each branch queues on its own. It logs in with the workflow's own
`GITHUB_TOKEN` (`packages: write`): no registry credential exists to keep or rotate. The package is
public, so a pull needs no sign-in. Nothing in the image is specific to one install: everything the
hopper keeps is in its database, its secrets come from the runtime ("Deployable", "Secrets").

**compose.yaml pulls it.** The `hopper` service is `image: ${HOPPER_IMAGE:-ghcr.io/henningfutrell/hopper:latest}`
— the full name, so Podman never asks which registry a short name means. No build: the first start is
a download. `HOPPER_SOURCE` is gone (no compatibility); an image built from a checkout is
`HOPPER_IMAGE=localhost/hopper`. Upgrade (since issue #494: `podman compose pull hopper && podman compose up -d --force-recreate --no-deps hopper`, then `podman image prune -f --filter label=org.opencontainers.image.title=hopper`; "Self-update" above) — the prune removes the replaced image, now untagged, and no other (issue #401: every upgrade left one behind; the `Dockerfile` labels a local build the same way the published one is labelled). Self-update
still does not apply to a container: since issue #409 its update check and version history do (above).

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
rolled-back append can leave a gap in `seq`: seq only rises. **A store newer than the build is refused**
(issue #527): when the instance schema's version, or a user schema's, is above what the build knows, the
migration stops before it changes anything and the daemon exits with `the database's instance schema is at
version <n>, newer than this build's <m>: a newer hopper migrated it. Run that release or a newer one again
…, or restore a backup of the database taken before it.` A build from before this check runs on such a store
regardless, so a migration still leaves a store the build before it runs on (AGENTS.md "Persisted state is the
user's"); store migration 28 brought back the `ui_sessions.expires_at` that 27 dropped, a session's absolute end
when made, which the build before 27 sweeps by and this build only writes, with defaults for the columns that
build does not know.

**Tests and local development** run against Postgres too: `npm test` starts a throwaway container
through `testcontainers` (vitest globalSetup, `test/support/postgres.ts`), each test in its own
schema; `HOPPER_TEST_POSTGRES_URL` points the suite at an existing database instead.

**A test run leaves nothing behind** (issue #401), on a pass, a failure or a crash. The first
globalSetup (`test/support/run.ts`) makes one run root, `jh-run-<pid>-*` in the tmpdir, and sets
`TMPDIR` to it, so every worker and every process a test starts makes its temp dirs inside it (the
throwaway HOME of `test/support/isolate.ts` too); it sets `HOPPER_TEST_RUN` to a fresh id, the run's
marker, which every process of the run inherits. Its teardown kills every process whose environment
(`/proc/<pid>/environ`, Linux only) carries the marker — SIGTERM, then SIGKILL — removes the run's
containers and removes the run root. Setup and teardown both sweep what a dead run left
(`test/support/sweep.ts`): run roots whose pid is dead, containers named `jh-<kind>-<pid>` (a test's
container names end in its pid) and containers labelled `hopper.test-pid=<pid>` (the Postgres) whose
pid is dead. A live pid's are never touched: they belong to a run still going. Older leftovers in the
tmpdir (`jh-test-home-*`, …) are not swept by name; another suite may own them. A unix socket path is
capped at 108 bytes, so a test that listens on a socket makes its dir in `/tmp`, not under the run root.

A local
hopper uses `deploy/compose.yaml`'s Postgres (optional: any Postgres it is given will do).

### Config documents

**Superseded by issue #198** ("Config in the database: no config files"): the documents are config
records — JSON values, no YAML — and `hopper config edit` is gone.

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

**Two kinds of secret (issue #451, refining issue #56).**

- **Credentials the hopper is given** for an outside service (a database password, an API key, a
  GitHub App's private key): they come from the runtime. The hopper's runtime can never be
  guaranteed, so it is given each one as an environment variable or a mounted secret file, and any
  secret source can feed it: a container's or orchestrator's secrets, a secrets manager, a service
  manager's credentials.
- **Secrets the hopper owns**: ones it makes or that are made for it (a webhook signing secret), and
  ones only it holds (a connected account's tokens). They are kept in the database **sealed** under
  the runtime's **master key**, `HOPPER_MASTER_KEY` ("Sealed in the database" below). Since issue #658 every one the
  hopper keeps for itself — a realm's own secrets too — is a **system secret** in the vault's system scope ("The
  vault's system scope").

A runtime secret named `NAME` is the variable `NAME`, or the file the variable `NAME_FILE` names
(`src/secrets/runtime.ts`, `runtimeSecrets`) — the `_FILE` convention container images use. Both set:
refused, naming both (never a silent choice). The file is read at each use, its one trailing newline
dropped, so a mounted secret the runtime rotates applies at once; an unreadable one is refused,
naming the variable.

Parts ask through `PluginContext.env(name)` / `DetectionKit.env(name)` (both `runtimeSecrets`;
`AppSeams.env` in tests). The variable is named by a command-bearing option, so a UI session cannot
redirect a credential:

| part | option (default) | was |
|------|------------------|-----|
| database | `HOPPER_DATABASE_URL` (it carries the password; also `_FILE`) | — |
| github-app source | `privateKeyEnv` (`GITHUB_APP_PRIVATE_KEY`; a PEM, real newlines or `\n` escapes) + `appId`, `slug` options | `appFile` → github-app.json + .pem |
| grokbot-routine notifier | `urlEnv`, `keyEnv` (`GROKBOT_WEBHOOK_URL`, `GROKBOT_WEBHOOK_KEY`) | `envFile` |
| gate-router | none since issue #657: the TypeSafe API key is the hopper's own, set on the Jev page and kept in the vault's system scope. A key the runtime still gives as `TYPESAFE_API_KEY` is imported once | `typesafeKeyFile`, `TYPESAFE_API_KEY` |
| anthropic-api escalation level | `apiKeyEnv` (`ANTHROPIC_API_KEY`) | — |
| webhook subscription | none since issue #451: the signing secret is the hopper's own, sealed in the database. A subscription from before keeps its `secretEnv` until a secret is stored for it | `secretEnv` (`WEBHOOK_SECRET_*`), inline `secret` (sealed), `secretFile` |
| realm (sign-in config) | none since issue #216: `clientSecret` (oidc, github, gateway) and `bindPassword` (ldap) are stored with the realm, set in the UI or by `HOPPER_SIGN_IN_REALM_<NAME>_*` (each also `_FILE`); a SAML `idpCert` is public and inline | `clientSecretEnv`, `bindPasswordEnv` (taken into the database once), `clientSecretFile`, `idpCertFile` |

The App's bot is `<slug>[bot]`, its page `https://github.com/apps/<slug>`. `create-github-app.sh`
writes the key (and webhook secret) as lines of an env file (`--secrets-file`, default the host
unit's `daemon.env`) and prints the `appId` and `slug` to set. The claude CLI signs in from its own
variable (`CLAUDE_CODE_OAUTH_TOKEN`) where its login state is not on the machine; it reads it itself, so
no `_FILE` form. A job's `GH_TOKEN` is not a runtime secret: the hopper hands it the connected account's
token (issue #214; the only GitHub credential of a job since issue #359). The github-gh source and its
`appKeyEnv` are removed (issue #359).

**What the hopper keeps:**

| kept | how |
|------|-----|
| a webhook subscription's signing secret | a system secret since issue #658 (`webhook.<id>.signing-secret`, the user's vault, sealed); `webhooks.secret_changed_at` says when it changed, `secret_sealed` (tenant migration 19, issue #451) is empty once moved. Typed in or made by the hopper; write-only ("Webhook signing secrets") |
| a webhook subscription from before issue #451 | its `secretEnv`, a variable's name (`secret_env`), read from the runtime under the user's secret prefix until a secret is stored for it, then cleared |
| UI session tokens, login codes | SHA-256 only (32 random bytes: no dictionary to try) — the hopper's own short-lived state; a hash is not a usable credential |
| password sign-in passwords | argon2id hashes in `password_accounts` ("Sign-in: realms", issue #200) — a verifier the daemon makes from the password an admin sets, never the password |
| a realm's own secrets | system secrets of the instance's vault since issue #658 (`sign-in.<realm>.<setting>`, sealed), out of the config record `sign-in` (in it in clear before #658, issue #216; and while the hopper is limited, issue #659, until the next start with the key) — setting up a realm still does not go through the runtime ("Realm secrets stored, sign-in from the environment"). Never answered by a route |
| a connected account's token | the access token GitHub granted the hopper's app and its refresh token: system secrets of the user's vault since issue #658 (`connected-account.github.access-token`, `….refresh-token`, sealed under `HOPPER_MASTER_KEY`); the row in `connected_accounts` (tenant migration 8, issue #214) keeps who and when. Read only by the hopper, answered by no route |

#### Sealed in the database

`src/secrets/sealer.ts` (issue #451). The **master key** `HOPPER_MASTER_KEY` (32 bytes, 64 hex digits or
base64) is the pepper. It never reaches the database, and it comes from the launch ("The master key" below).
Each value is sealed so:

- **its own key**: HKDF-SHA256 of the master key, a fresh 32-byte random salt, and the context (where the
  value is kept: `webhook:<subscription id>/signing-secret`). The master key is the pepper, the salt is
  per value; no two values share a key, and the master key is never used to encrypt directly;
- **AES-256-GCM** under that key, with a fresh 12-byte random nonce;
- **bound to its place**: the context is in the key derivation and in the authenticated data, so a
  sealed value copied to another row or another kind of secret does not open. The subscription id, not
  the user, so a fold of one user into another (issue #265) keeps it;
- **padded** to a block of 64 bytes (its length first), so the stored length does not show the secret's;
- **marked with the key id**: 16 hex digits of HMAC-SHA256(master key, a fixed label), a fingerprint
  that does not give the key.

`hs1.<key id>.<salt>.<nonce>.<ciphertext ‖ tag>`, base64url. A value that does not open throws
`SecretUnreadable` — no key, another key (naming the key id it was sealed under), altered, or moved — and
is never read as "no secret". The derived key and the plaintext buffers are zeroed after use (a
JavaScript string cannot be).

**Key rotation.** Give the new key as `HOPPER_MASTER_KEY` and the old one as `HOPPER_MASTER_KEY_PREVIOUS`
(one per line, or comma- or space-separated) and restart: each user's runtime seals every
webhook secret an older key sealed again under the new one (`resealAll`, logged as a count), keeping when
it last changed. Once the log says so, drop the old key. A previous key only opens. The token box's
`sealed:v1:` has no key id, but its GCM tag tells which key sealed a token: it opens under an older key too,
and the renewer's next look seals it under the new one (issue #514) — a rotation asks for no new GitHub
sign-in.

**No key, a wrong key.** A master key that is no key stops the daemon (fails closed). A wrong one stops it
too ("The master key" below). None while the database keeps secrets: the daemon starts limited; adding a
subscription or storing a secret answers 503 naming `HOPPER_MASTER_KEY`; a subscription with a stored secret
sends nothing, and its card, its test event and its deliveries say the stored secret cannot be opened.

#### The master key

Issue #659. The hopper runs in ephemeral containers, and a persistent volume cannot be assumed: a key kept in
a volume beside the container (the compose `secrets` volume's `token_key`, before) is lost with it, and every
secret it sealed with it. So the master key comes from the launch alone, as the variable `HOPPER_MASTER_KEY` —
never a file (`HOPPER_MASTER_KEY_FILE` is refused, naming the variable), never a volume. `src/secrets/master-key.ts`
resolves it once, at start, before any user's runtime; the parts read it through `withMasterKey`, and no child
process gets it (`src/executors/env.ts` drops every `HOPPER_MASTER_KEY*` and `HOPPER_TOKEN_KEY*` variable).

- **Fingerprint.** The instance settings keep `masterKeyFingerprint`: HMAC-SHA256 under the key of the fixed
  label `hopper master key fingerprint v1`, 64 hex digits; never the key. Each start compares it. A wrong key
  throws `MasterKeyMismatch` ("the master key does not match this database") and the daemon does not start;
  nothing in the database changes. A new key whose `HOPPER_MASTER_KEY_PREVIOUS` holds the recorded one is a
  rotation: its fingerprint is recorded. A database that keeps secrets but no fingerprint (from before) takes the
  key only when it seals some of them: a sealed value's key id, or a token the token box opens with it
  (`src/store/kept-secrets.ts`, every user's schema; a vault a KMS data key seals is left out).
- **First start.** No key, no fingerprint and no kept secret: the hopper makes a key, records its fingerprint, and
  shows the key once in the UI (`POST /ui/api/master-key` `reveal`, the hopper's admin alone, then 409). Never in the
  log (issue #685): a container's log goes to the host's journal and stays there. The start log says only where the key
  came from and its fingerprint (`master key: <how> (<source>), fingerprint <16 hex digits>`). The banner stays until the admin says it is saved (`saved`: `masterKeySaved`
  records the fingerprint saved). The key lives only in the process: the next start without it is limited.
- **Limited.** No key while a fingerprint or a kept secret exists: the daemon starts, says so loudly at start and
  in a banner (`GET /api/master-key` `source: missing`, its `problem` naming the key by its fingerprint), and keeps
  everything: no sealer, so nothing is sealed or opened; no token box, so no new GitHub grant is kept — a sign-in
  goes on without keeping its grant, Connect GitHub says the key is missing, and the renewer does not trade a
  refresh token it could not keep. Nothing is deleted, and no new secret is made in place of one it cannot open.
- **The old token key.** While `HOPPER_MASTER_KEY` is unset, `HOPPER_TOKEN_KEY` (or the file
  `HOPPER_TOKEN_KEY_FILE` names; a file that is not there is no key) is read to move an install: checked as a
  given key is, shown once in the UI to be saved, and the log says to give it as `HOPPER_MASTER_KEY`. Once that is set,
  the old key is not read, and the log says it can be removed. One that matches nothing kept: limited, saying so.
- **The vault container** (issue #586) reads the same `HOPPER_MASTER_KEY` (or the old token key) and checks it
  against the recorded fingerprint at each user's first request: a wrong key seals and opens nothing.
- **The log mask** (issue #685). The master key, or any part of it beyond its fingerprint, never goes to a log, an
  event, an error or the API; the one exception is `reveal` above, once, to the admin. Every line the daemon and the
  vault container write to stdout and stderr goes through the secret mask (`src/secrets/log-mask.ts`): the master key
  and its previous keys, held by value; GitHub tokens; and the key patterns (`maskKeys`): 32 bytes as 64 hex digits,
  or as base64 or base64url — the master key's forms, and those of every key the hopper makes. A `sha256:` digest is no
  key. `hopper master-key status` (operator CLI) answers `source`, `fingerprint` and `previous`, never the key.

The compose file makes no `token_key`, and Postgres sets the database password again at each start, so a lost
`secrets` volume costs nothing: a new one gets a new password, and the database keeps working. Recreating the
hopper anywhere with the same database and `HOPPER_MASTER_KEY` keeps every secret.

Carried, part 2 of issue #659: rotation as one operator command (UI, API and CLI) that seals every secret again
in one transaction and shows the new key once; an optional KMS as the master key's source; the `secrets` volume
out of the default compose file.

`HOPPER_SECRET_KEY` and the secret box of issue #55 stay gone: a leftover `HOPPER_SECRET_KEY` is a
leftover variable (boot warning; delete the line). A webhooks-document entry with an inline `secret` —
sealed or clear, from before — was refused at load, and is left out by migration 14 (issue #78).

**systemd credentials.** `LoadCredential=<name>:<path>` (or `LoadCredentialEncrypted=`) in a drop-in
for `hopper.service`, with `Environment=<NAME>_FILE=%d/<name>`: the secret never sits in
`daemon.env`.

**Residual risk, stated.** Whoever holds the hopper's runtime holds its secrets and the master key, and a
job on the hopper host runs as the daemon's user (it can read `daemon.env` or a readable mounted file, or the
daemon's environment through `/proc` as the same user).
The database and its backups hold no usable secret but the realms' own (issue #216): the sealed ones need
the master key, which is given at launch, never in the database or a volume. Keep it in a password manager,
apart from the database's backups: a database restored without it starts limited until the key is given. The
first start writes the key it made to the start log once: a log kept where others read it holds it. A secret is
in the daemon's memory while it signs or is sealed.

### Login codes

The daemon writes no login code file. A device link, or a new user's login link, mints a one-time code
into the database (`login_codes`: its SHA-256 and an expiry, 10 minutes; one code for all the links);
`POST /ui/login` takes it once. Nothing on the host mints one: `hopper login-code` and
`scripts/open-ui.sh` went with issue #238 ("No bootstrap login").

### Work dir

`HOPPER_WORK_DIR` (default `<system temp dir>/hopper`) holds scratch only: claude's working
directory for escalation level calls, each plugin's scratch dir, ssh control sockets, Jev's own
`gate-router-runs.jsonl` debug log (grok-bot-jev's run log, not the hopper's state), self-update's mirror and next
install. Losing it loses nothing the hopper needs; the host unit points it at the user's cache dir
(`%C/hopper`) so the update mirror survives restarts. Defaults that named one machine's layout are
gone: `jevSrc` has no default, and a job's work tree is its machine's (issue #361), the jobs
directory `~/hopper-jobs` by default, resolved on the job's machine (issue #323).

### Operator CLI

`src/cli.ts`, installed as `hopper` (`~/.local/bin/hopper` by install.sh,
`/usr/local/bin/hopper` in the image). It opens the daemon's database (`HOPPER_DATABASE_URL`),
so whoever runs it holds the database's credentials — the daemon's own trust, more than any UI
session's. Not an HTTP route, so the rule that every mutation goes through `POST /ui/api/*` is
about the daemon's surface; the CLI is beside it, like editing a file was.

- `config get|version <document>`; `config set <document> --if-version <version>` (stdin);
  `config edit <document>` ($EDITOR, written back against the version read). A document that would
  not load (plugins/webhooks/auth schema, rules size) is refused; a moved one is refused.
- Since issue #158: `users`, `user add <name>`, and `--user <id>` on `config`
  ("Users: one hopper, separate users"). Without `--user`, the one user; with none yet or several,
  refused, naming what to do (issue #238). `login-code` went with issue #238.
- Since issue #212: `user transfer <from> <to>` — `<to>` takes over `<from>`'s work (docs/sign-in.md).
  The daemon holds a session-level advisory lock per instance schema while it runs; the command
  takes it or refuses, because the daemon keeps a runtime per user and the command removes one.
- Since issue #307: `ssh-key [--user <id>]` — the public half of the user's ssh key (issue #293), the line a
  machine's `authorized_keys` takes; never the private half. None yet (the daemon mints it at its start):
  refused, saying so. `scripts/agent-boxes.sh` asks it where the hopper runs.
- `help` (also `--help`, `-h`): every command, exit 0 (`password-hash` went with issue #200). No command or an unknown
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
  configured for none). Self-update does not apply (an image is updated by
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

> **Superseded.** Since issue #214 the default is the connected account; since issue #359 the gh CLI
> path (the `github` instance, `enabled: auto`, gh login) is removed. The App of one's own stays
> (`github-app`). See "One way to GitHub as the user" at the end.

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
- **Not built, named only** (README "Connect GitHub"): a fine-grained personal access token pasted in,
  and a hosted relay App forwarding to many hoppers. Since issue #214 people sign in with GitHub
  through the hopper's GitHub App, and that connection is the default path ("Sign in with GitHub, and work
  through that connection"). Either would put a credential, or another party, where the hopper now has neither;
  neither is the path for a self-hosted hopper. Logging gh in from the UI was built in issue #138 and
  removed with the gh source in issue #359.

## Plugin store (issue #75, 2026-10-05)

Owner direction: there is a store to install plugins from. Code: `src/plugins/plugin-store.ts`
(the service), `src/plugins/plugin-store-catalogue.ts` (the catalogue, pure), `src/plugins/plugin-store-git.ts`
(the git CLI); routes `GET /api/plugin-store`, `POST /ui/api/plugin-store`; the UI's Plugins view.

**What a plugin store is.** A git repository (anything `git fetch` takes: ssh or https URL, a local
path), named by the **plugin store setting** (below). Its default branch's root holds the **store
catalogue** `plugin-store.yaml`:

```yaml
version: 1
plugins:
  - { id: echo-executor, role: executor, describe: Finishes every job at once with its prompt as the result, path: examples/plugins/executor/echo-executor }
```

`id` matches the custom-plugin id rule; `role` is a role; `path` is a relative directory inside the
repository (no `..`, not absolute); ids are unique; unknown keys are refused. This repository is a
plugin store: its `plugin-store.yaml` lists `examples/plugins/`.

**The default plugin store (issue #445, 2026-10-08).** Owner decision: the default is the static
Pages site. `scripts/build-plugin-store.sh` builds this repository's `plugin-store.yaml` and
`examples/plugins/` into a bare git repository, and `pages.yml` publishes it beside the site as
`https://henningfutrell.github.io/hopper/plugin-store.git` (`DEFAULT_PLUGIN_STORE`). `git fetch` reads a
repository served as plain files (git's "dumb" HTTP), so the store needs no server and the daemon reads it
as any other plugin store. Each build fetches the history already published and commits on top of it, and
adds no commit when nothing changed. A store install's `tree` therefore stays in the plugin store after
its plugin changes, and still restores on a fresh work dir. It is the stable version's, as the rest of
the site is.

**The plugin store setting (issue #445).** An instance setting, kept in the database beside the store
installs (`settings` key `pluginStore`, `PluginStoreSource`): `{ kind: 'default' }`, `{ kind: 'none' }`
or `{ kind: 'repo', repo }`. Never set means the default. An instance admin sets, changes or clears it
on the Plugin store card (`{ action: 'source', source }`). Saving reads the new plugin store at once, so
the catalogue, Install, Update and Restore follow it without a restart. A value starting with `-` is
refused, and `git fetch` gets it after `--`, so it is never read as an option.
`HOPPER_PLUGIN_STORE` is only a seed. While the setting was never set, it is copied in at start as
`{ kind: 'repo' }` and logged. This is the upgrade path for a hopper that relied on it. Once anything is
stored, a later start leaves the setting as it is, whatever the variable says.

**Who may set it.** Installing a plugin runs its code in the daemon (the import runs the module). This
was why the plugin store was once a process setting. Since issue #198, an admin edits command-bearing
options in the UI, so the same trust applies here: an instance admin may name the plugin store, as they
may name a command. The plugin store an admin names is trusted as the install itself is. No signature
check.

**Reading.** A bare mirror at `<work dir>/plugin-store/repo.git`; each read fetches the store's
`HEAD` (its default branch) with the update mirror's git environment (never prompts, ssh batch
mode). Read at start in the background (a slow or unreachable store never delays the boot), and on
`refresh`. A catalogue that cannot be fetched or parsed → state `error` with the reason; the last
good catalogue stays listed. When that catalogue was read from another plugin store (the setting
changed and the new one could not be read), the report names it (`from`), and nothing installs from
it: Install is refused (409) and the card offers none. No plugin store (set to none, or no default in
this build) → state `unavailable` with a `reason` that names the setting, never an environment
variable; the store installs are still listed (`listed: false`) so they can be removed.

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
runs. Several plugin stores. Pinning a store to a branch or tag other than its default branch. A
catalogue built into the release (no network).

**Report** `GET /api/plugin-store` (`PluginStoreReport`): `state` (`unavailable` + `reason`,
`ready`, `error` + `error`), the setting's `source`, the plugin store in use `repo`, `defaultRepo`,
`from` (above), `commit` and `checkedAt`, and per plugin the
catalogue entry with `installed` (`{ commit, installedAt, current }`) and `restartPending`. A store
install the catalogue no longer lists is still listed (`listed: false`), so it can be removed.
`POST /ui/api/plugin-store` (admin): `{ action: 'refresh' }`, `{ action: 'source', source }`, `{ action: 'install', id }`,
`{ action: 'remove', id }`; answers the new report. Edits run one at a time.

**UI.** The Plugins view's **Plugin store** card: the plugin store and where it comes from (the default,
set by an admin, or none), its commit and last read, Refresh; for an instance admin, a field to name a
git repository (Save), **Use the default**, and **None** (confirmed); per
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

## Sources view: one GitHub section (issue #160, 2026-10-05)

> **Superseded** by issues #254 and #359: the gh card and the gh login panel are gone; the section is the
> connected account's panel, plus an admin's `github-app` where one is set up.

Owner request: the Sources view showed three overlapping GitHub cards — gh logged in, a github source
that read `disabled` and `paused: GitHub App configured`, and the github-app source — with nothing
saying how they relate or which one is in use.

**Cause of the disabled/paused mix.** The sync loop reports a paused source with no active jobs as
state `disabled` (`src/sources/sync.ts`), and the card showed state, mode and the raw pause reason side
by side.

**As built.** The Sources view has one **GitHub** section. `ui/src/model/sources.ts`
(`sourcesView`, pure) takes the sources of kind `github` and `github-app` and gives each a use —
`in-use`, `paused` (from `detail.paused`, checked before state) or `disabled` (state `disabled` with no
pause: switched off in its options) — with the reason in plain words, and orders them in use, paused,
disabled. One sentence above the cards says which connection reads issues and how the other relates
(the GitHub App wins while it is set up; gh takes over otherwise). Each card names its connection
("through gh, as the logged-in GitHub user" / "through the GitHub App, as its bot") and, when not in
use, why. The gh login panel is titled **gh login** and sits last: it is not a source, it is who jobs
push as, whichever connection reads issues. Other job sources render after the section, as before.
No wire or daemon change.

**Verification:** `test/ui/sources.test.ts` (the model: order, reasons, the paused-reported-disabled
case, the summary sentences) and `test/ui/sources-view.test.ts` (the whole app in happy-dom against a
fake daemon: the section's order, the reasons, no raw pause text, no "GitHub (gh)" title).

## Cursor executor and machine defaults (issue #142, 2026-10-05)

Owner request: a machine (WSL) attached from the UI defaulted to herdr-claude, and some machine
defaults were not configurable; attaching assumed ssh with herdr and Claude Code. Cursor must be
supported; defaults must be configurable. Read as three changes; none breaks a document.

**The Cursor executor** — built-in executor plugin `cursor-agent` (`src/plugins/executor/cursor-agent/`,
`src/executors/print-agent.ts`, since issue #307 one of the print-mode agent executors); opt-in, not in the built-in instances.

| option | default | |
|---|---|---|
| `bin` | `cursor-agent` | Cursor's CLI agent on the job's machine (command-bearing) |
| `args` | `[--force, --trust]` | its own arguments: run tools without asking, trust the work tree (command-bearing) |
| `cwd` | `~` | the work tree of a job whose payload names none (command-bearing) |
| `sshBin` | `ssh` | the ssh client, for ssh targets (command-bearing) |

- **One turn is one print-mode run**: `sh -c 'mkdir -p <scratch> && printf "*\n" > <scratch>/.gitignore && ln -sfn <scratch> <temp link> && … && cd <cwd> && exec env <payload env> TMPDIR=<temp link> HOPPER_JOB_ID=<id> <bin> -p --output-format json --workspace <cwd> <args> [--model m] [--resume <chat>] -- <text>'`,
  through the machine's connection (`commandOn`: here, or POSIX-quoted over ssh with the hopper's key). The
  payload is herdr-claude's (`prompt`, `cwd`, `model`, `env`, `timeoutMs`; `cwd` resolved here and the same
  path there). The first turn's text is the prompt and `protocolFooter(cwd)`; a resumed turn's is the answer.
- **The answer** is Cursor's JSON result (`result`, `session_id`, `is_error`). Its last line is the marker:
  `HOPPER_DONE` → finished `{ machine, summary, chatId }`; `HOPPER_FAILED <reason>` → failed;
  `HOPPER_QUESTION` → question (`detectedBy: marker`); no marker → a status note (issue #163): its
  text is progress and the chat is resumed with the nudge, at most three in a row, then the job fails. A question saves `{ chatId, cwd }`; `resume` runs
  the next turn with `--resume <chatId>`. A non-zero exit, an error result, no JSON or no chat id fails the
  job with what Cursor said.
- **Where it runs**: this machine and ssh targets, with or without herdr. A container target (no agent,
  issue #58) and a client target (serves herdr only) are refused with the reason.
- **Not idempotent, nothing to reattach**: the process ends with its turn, so a restart fails a running job
  and never runs the agent twice; a job on a question resumes its chat after a restart. Cancel kills the client process.
- **Detection** is `which` only and always `available`: absent here, its detail says jobs run only on
  machines that have it (a WSL or server target may have Cursor where the hopper's host has none).
- **Credentials**: Cursor signs in on each machine (`cursor-agent login`, or `CURSOR_API_KEY` in that
  machine's environment). The hopper holds no Cursor credential ("Secrets").
- **Not built**: Cursor in a herdr pane. herdr starts `--kind cursor`, but the screen protocol parses
  Claude Code's TUI ("Turn anchor (B1)"); print mode needs no screen parsing and ends with each turn.
  Visible panes for Cursor would be another executor with its own screen protocol.

**An ssh target without herdr** — `ssh` option `herdr` (default `true`, command-bearing). With `false` the
probe is `true` over ssh (`probeSsh`), the snapshot has no `herdr`, and herdr-claude refuses the machine
(`it runs no herdr`): without that refusal the job would run in this machine's herdr. Attaching from the UI
sets it from the executors chosen: herdr is looked for (`resolveSshTarget({ herdr: true })`) only when one
of them is an instance of `herdr-claude`; otherwise only the pinned host key is resolved and the connection
made once, and the entry carries `herdr: false` and no `herdrBin`. A document without the option keeps
herdr: no migration.

**Machine defaults** — plugins.yaml `machineDefaults: { lanes?, executors? }` (strict; `lanes` ≥ 1). A field
left out is the `ssh` plugin's own default (one lane, `[herdr-claude]`), so an absent section changes nothing.
`GET /api/machines/config` carries `defaults` (resolved). `POST /ui/api/machines` takes `lanes` and
`executors` as optional: left out, the defaults. `POST /ui/api/machines/defaults { lanes, executors, version }`
(admin) replaces the section (Document API, comments kept), refusing an executor that is not a configured
instance (400) and a stale version (409). The Machines view shows them ("a new machine: …"), edits them
(**Defaults**), and starts the Add form from them. They seed new machines only: a machine already attached
keeps its own lanes and executors, and a hand-written instance without them still takes the plugin's
defaults.

**Not built: attaching a docker or client target from the UI.** Both need setup the daemon cannot do
(a container started by its script and let through the socket proxy; the client installed on the target
and its token in the daemon's runtime), so they stay `scripts/` plus `hopper config edit plugins.yaml`.

### Shipped plugins are switched on in the UI (issue #142, owner decision 2026-10-05)

Owner, on the first cut of this issue: plugins.yaml editing cannot be how users get a plugin. **Users
never edit plugins.yaml**: for now the shipped plugins are enabled and disabled in the UI; installing
plugins from a store URL is a separate issue.

- **The switch.** The Plugins view lists every **shipped plugin** (built-in) of a list role but
  `machine-source` (attached in the Machines view) and, since issue #444, `escalation-level` (edited in
  Question gates alone) with a switch. On sends `POST /ui/api/plugins`
  `{ action: 'add', role, plugin: <id>, name: <id> }` (the plugin's defaults); off sends
  `{ action: 'remove', name: <its one instance> }`. Blocked, with the reason, when the plugin is not
  available here (its detection reason: `needs-setup` for one whose options have no defaults), when
  another instance already has its id as name, or when it has several instances (remove them in its
  role block). The existing add, remove and options edits are unchanged; no new route.
- **Executors are live.** The executor role follows plugins.yaml like the machine sources
  (`applyExecutorSpecs`: an unchanged instance kept, a new or changed one built, a removed one dropped;
  logged). `/api/plugins` `executors` is `{ instances }`, never pending. The daemon's registry reads the
  host's executors on every lookup, so a job routed to a just-enabled executor runs; `/api/health`
  `executors` is current. A running job keeps the executor object it started with; a resume or
  reattach looks the name up again.
- **Removal while in use.** Removing an executor is refused (409, naming the jobs) while a job that has
  not ended (`queued`, `held`, `claimed`, `running`, `waiting_answer`) names it — the machine rule,
  extended (`inUse(role, name)`). The other refusals (named by a job source, routing rule or machine;
  the last executor) stand.
- **Still restart roles**: job sources, usage sources, notifiers. Switching one shows `changed —
  restart pending`, and the UI has no restart. *Superseded by issue #356: they are live too.*
- **Docs** give the UI path (README "Cursor's agent"); no user step says `hopper config edit`.


## Users: one hopper, separate users (issue #158, 2026-10-05)

Owner decision: several people use one hopper, and **each user is fundamentally separate**. A user's
jobs, questions, events, decisions, lanes, job sources, machines, executors, escalation levels, rules
document, routing, queue gate, usage sources, webhook subscriptions and credentials are their own,
never visible to or touchable by another user. The **instance** is what they share: the daemon
process and its port, sign-in (`auth.yaml`), the plugin store and its installs, self-update. No API
keeps its old shape (no shims, every caller changed); persisted state migrates without loss: an
install from before holds one user's work, and it becomes the first user's — `owner` until issue
#220, the **default admin account** `admin` since ("The default admin account" below).

### Store: an instance schema and one user schema per user

- **Instance schema** — the schema `HOPPER_DATABASE_URL` names (`public`, or its `?schema=`):
  `schema_version`, `users (id, name UNIQUE, created_at, work_dir, secret_prefix)`,
  `user_identities (provider, subject, user_id)`, `ui_sessions` and `login_codes` (each with
  `user_id`), `config_documents` (only `auth.yaml`), `settings` (only `updateChannel`, `autoUpdate`,
  `pluginInstalls`).
- **User schema** — `u_<id>` when the instance schema is `public`, else `<instance schema>_u_<id>`
  (tests run each in a schema of their own; this keeps them apart). It holds the tenant tables as
  they were at instance version 16: jobs, lanes, decisions, events, webhooks, deliveries, questions,
  `settings` (`routerMode`), `config_documents` (`plugins.yaml`, `rules.md`) — and its own
  `schema_version` on the **tenant track** (`src/store/tenant-migrations.ts`): version 1 is those
  tables exactly; a later tenant migration appends there and runs as each user store opens.
- **Instance migration 17** creates `users` and `user_identities`, the user `owner` (`work_dir` and
  `secret_prefix` empty), its user schema, and **moves** every tenant table into it with
  `ALTER TABLE … SET SCHEMA` — the owned sequences and indexes move with the table, so `seq`
  continues where it was. The `plugins.yaml` and `rules.md` documents and the `routerMode` setting
  move to the user schema's own tables; the tenant `schema_version` is recorded at 1. `ui_sessions`
  and `login_codes` gain `user_id` (default `owner`); every identity seen in a stored UI session is
  linked to `owner`. A fresh store runs BASE → … → 17 the same way, so it starts with the user
  `owner`. One transaction: a failure leaves version 16 as it was.
- **Ports** — `InstanceStore` (`users`, `identities`, `uiSessions`, `loginCodes`, `documents` —
  `auth.yaml` —, `settings` — the instance's —, `userStore(user)`, `tx`, `close`) and `UserStore`
  (the store shape from before, without UI sessions and login codes; its `documents` hold
  `plugins.yaml` and `rules.md`, its `settings` the user's settings). `userStore(user)` opens one more
  connection whose `search_path` is the user schema (the `?schema=` mechanism), and runs the tenant
  track. `openInstanceStore` replaces `openStore`.

### The default admin account (issue #220, 2026-10-06; a new hopper has none since issue #238)

Owner decision: no built-in `owner` account. Like Nexus, Argo CD and Grafana, every hopper has a
**default admin account**, the user `admin` (`ADMIN_ID`, `src/domain/users.ts`), and it is the one
account that receives everything: the work dir itself, an empty secret prefix (the daemon's variables
as they are), the herdr session `hopper`, and every default — no sign-in, `hopper login-code` and the
operator CLI without `--user`, the password fallback's account, the instance's own events and plugin
report (`UserRepository.admin()`, `Runtimes.admin()`).

- **Instance migration 21** (`src/store/migration-admin.ts`) gives the user `owner` the id `admin`: the
  row keeps its place, created date, work dir and secret prefix; its name `owner` becomes `admin`; its
  identity links, UI sessions and login codes name `admin`; its user schema is renamed
  (`ALTER SCHEMA … RENAME`, every table, sequence and index with it). `owner` is gone. A user already
  called `admin` moves aside first — id `admin_2` (schema renamed the same way, its work dir and secret
  prefix kept), name `Admin 2` — so nothing of theirs is lost. `ui_sessions.user_id` and
  `login_codes.user_id` lose their default: each row names its user. One transaction.
- **Sign-in.** Every way the owner signed in now signs in as `admin`: its login codes, sessions and
  linked identities. The password fallback's account `admin` (issue #219, "Password sign-in is the
  fallback") was linked to `owner`, so it signs in as `admin`; a fresh hopper's start links it to
  `admin` directly. The default admin account is then complete: the user `admin`, its password
  account `admin` (first password shown once at start), and the login code.
- **Not an account: the question stage.** *Owner* stays the glossary's word for the last stage of the
  question gates — whichever user's job asked — never a user.

### The leftover default admin account (issue #265, 2026-10-06)

Owner request: on the Users page of a hopper from before there are still two users — the one from
before GitHub sign-in (`admin`) and the admin who signed in with GitHub. The earlier one is a leftover
and no longer applicable: remove it, and whatever is still tied to it belongs to a real user account,
consistent with #220. Related: #212, #239.

Inputs: since #238 a new hopper has no `admin`, but one from before keeps it with its work, and the
first GitHub admin's sign-in makes a user of their own beside it (#239 records who that is,
`githubAdmin`). #238 left the move to the operator: `hopper user transfer admin <user>`, with the
daemon stopped — refused once that user holds work of its own, which a GitHub sign-in's sources give it
within minutes.

- **At start, before any user's runtime** (`src/users/leftover-admin.ts`, `foldLeftoverAdmin`, from
  `startApp`): when the user `admin` exists and the recorded first GitHub admin's identity is linked to
  another user, `admin` is **folded** into that user, the real account, and the log says so. Nothing
  happens while no GitHub admin is recorded, when they sign in as `admin` itself (a transfer done
  before), or on a hopper with no `admin`. Every start checks, so a first GitHub sign-in after the
  update is folded at the start after it. Not an instance migration: who the real user is comes from
  sign-in, which a migration of a store nobody signed in to cannot know, and the operator CLI opens the
  same store while a daemon runs.
- **The fold** (`UserRepository.fold(from, into)`, `src/store/users.ts`; the rows in
  `src/store/fold-user.ts`), one transaction, both user schemas first on the latest tenant version. As
  #220 did for `owner` and #212's transfer does, the record that ran the hopper stays: `admin`'s row —
  its place, created date, work dir, secret prefix — and its user schema, renamed, take the real user's
  id and name, so `admin`'s machines (their herdr sessions), lanes and running jobs go on untouched and
  the user's id, schema name and sign-ins are the real user's. The real user's own work moves in:
  jobs, questions, decisions, events, webhooks after `admin`'s, in their order, new rows numbered on;
  their deliveries with their subscription, naming their event by its new seq (the dispatcher reads it
  by seq); lanes, a webhook's name, settings (the queue gate) and config records `admin` already holds
  stay `admin`'s, the rest join; the plugins config gains the sections and the executors, job sources,
  machines, usage sources and notifiers only the real user named (escalation levels and routing are
  ordered chains: `admin`'s whole); the connected account is the real user's — their own GitHub
  connection, granted at their sign-in. Identity links, UI sessions and login codes of either name the
  real user (no sign-in's identity, linked to `admin` by migration 24, with them). The real user's own
  row and schema are dropped. A job of each for the same source key is kept twice: the job source reads
  the newest.

**Residual risk, stated.** The real user's running jobs on a lane `admin` also had lose that lane, and
the start's recovery treats them as it does any job whose lane is gone. The real user's own work dir
(`users/<id>`: their `gh` and `claude` logins) is no longer theirs: the kept record's work dir is the
work dir itself, with the daemon's own logins, which `admin`'s sources used; the GitHub connection jobs
work through is the connected account, which moves. Secrets read under the real user's prefix are read
under the empty prefix from then on.

### User runtime

`startApp` (`src/main.ts`) is the instance: it opens the instance store, loads `auth.yaml`, sign-in,
the plugin store, the updater and the HTTP server, then starts one **user runtime** per user
(`src/users/runtime.ts`, `startUserRuntime`): everything main built before — plugins.yaml ensured,
plugin host, target pool, executors, question service, engine, job source sync, webhook dispatcher,
notifiers, failure log — over that user's store. A user added while the daemon runs gets its runtime
at once. `App.user(id)` returns a runtime's parts (store, engine, sources, plugins) for tests; `stop`
stops every runtime, then the instance.

- **User work dir** — `HOPPER_WORK_DIR` joined with the user's `work_dir`: `''` for `admin` (its ssh
  control dir, client sockets, plugin scratch stay where they were), `users/<id>` for a user added
  later. The store installs and the update mirror stay in the work dir itself: they are the instance's.
- **Secrets** — a user's runtime reads secret `NAME` as `<secret_prefix>NAME` (and
  `<secret_prefix>NAME_FILE`), through the same `runtimeSecrets`. `admin`'s prefix is empty (nothing
  changes for an install from before); a user added later gets `HOPPER_USER_<ID>_` (id upper-cased),
  so one user's plugins.yaml can never name another user's variable. The instance's own secrets
  (`HOPPER_DATABASE_URL`, `auth.yaml`'s `clientSecretEnv`) keep their names.
- **Credentials of the CLIs** — for a user with a work dir of their own, every process their parts
  start on this machine (`gh` in a job's pane, `claude` in herdr-claude panes,
  in claude-cli escalation levels, in the usage sources, `cursor-agent`, a command job, the herdr CLI)
  starts with `GH_CONFIG_DIR=<user work dir>/gh` and `CLAUDE_CONFIG_DIR=<user work dir>/claude`
  added. The runtime builds that environment once (`userProcessEnv`) and hands it to the parts as
  `PluginContext.processEnv` and the detection kit's environment, never `process.env` directly. A
  herdr pane gets it through the tab's environment (`createTab` `env`). `admin`'s environment is the
  daemon's, unchanged. On an attached machine the target's own login applies, as before.
- **herdr session** — every user's jobs run in the supervised `hopper` session, the herdr-claude
  plugin's default `session`; no user gets a session of its own (issue #261). The built-in
  herdr-claude instance names no session, and a start that finds the `hopper-<id>` session an earlier
  version wrote on a herdr-claude instance removes it (`ensurePluginsConfig`). Panes are one tab per
  job, so users' jobs share the session without touching each other's panes.
- **Instance parts** — store installs are the instance's: after an install or removal every user's
  plugin host rescans. The update's restart blockers are the running jobs of every user. The
  instance's events (`update.*`, `plugin.installed`, `plugin.removed`) are appended to every user's
  event log, so each user's UI and webhook subscriptions see them.

### HTTP

- A UI session belongs to a user (`ui_sessions.user_id`). Every tenant route — `/api/*` except the
  instance routes below, `/api/events/stream`, and the tenant `POST /ui/api/*` mutations — reads and
  changes the user runtime of the request's user: the session's user; else, for a **loopback request
  without a session**, the one user while the hopper has only one, and nobody (401) once it has more
  (issue #221, "What an admin sees" below; the `x-hopper-user` header that named any user is gone). A
  LAN or public request without a session stays refused (401). A question, job or webhook id of another user is
  simply not there: 404.
- Instance routes: sign-in, `GET /api/update` + `POST /ui/api/update`, `GET /api/plugin-store` +
  `POST /ui/api/plugin-store`, `GET /api/users` + `POST /ui/api/users`, the docs. UI roles keep their
  meaning (viewer < operator < admin) but act only inside the session's own user; the instance
  mutations need `admin`.
- `GET /api/users` (an admin session, or loopback): `{ users: [{ id, name, createdAt }] }` — nothing
  of a user's own data. `POST /ui/api/users` (admin) `{ action: 'add', name }` creates a user (its
  schema, its plugins.yaml, its runtime) and answers `{ user, links }`: a one-time login link per UI
  origin (`http://<host>/#login=<code>`, the public URL too), minted for the new user, to hand over;
  no links when local sign-in is off.
- `GET /ui/api/session` `user` is `{ id, name, role, provider, identity }`: the user the session acts
  for, its role, and who signed in (`identity`: the name the provider gave). The SSE stream carries the
  session user's events, deliveries and source statuses only.

### Sign-in maps an identity to a user

`user_identities` links (provider, subject) to a user. A password, OIDC, GitHub or SAML sign-in
whose identity is linked signs in as that user; an unlinked identity that a role rule grants a role
gets a **new user** — named from the identity's username, else name, else email, else subject, made
unique — and the link (`provisionUser`). A login code carries its user (`login_codes.user_id`):
`hopper login-code [--user <id>]` (default `admin`), a device link mints one for the session's own
user, a new user's login link for that user. No sign-in (`none`) is `admin`. Stored sessions are
reconciled with `auth.yaml` at start as before; their user stays.

**Residual risk, stated.** An identity that signed in before the migration only through sessions
that had expired is not linked; its next sign-in provisions a new, empty user. `hopper login-code`
(default `admin`) always reaches `admin`. An admin of any user can add users and update the daemon:
instance mutations are not owner-only. Two users' `local` machines run on the same host side by side,
each with its own lanes. As before, every local account of the host reads the GET API on loopback
without a session — only while the hopper has one user (issue #221). Jobs
of every user run as the daemon's account: one user's job on the hopper host can read files another
user's job wrote there; the separation is the hopper's, not the operating system's.
A user added later starts every process of theirs (gh, claude, the herdr server and its panes, commands)
from the machine's variables only (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`, `TERM`,
`TZ`, `TMPDIR`, `XDG_RUNTIME_DIR`, `LC_*`) plus their CLI config dirs (`userProcessEnv`,
`src/executors/env.ts`): never the daemon's environment, which holds admin's runtime secrets and the
database URL. Admin's processes keep the daemon's environment. This closes the easy read, not the
account: a later user's job can still read the daemon account's files. A user who needs a boundary
the operating system enforces runs their jobs on a machine of their own (an ssh, client or container target).

### UI

The top bar shows the session's user in the **user menu** (issue #666): one button, the user's initials, labelled with the
name and role, the identity that signed in on hover. It opens a menu (Radix `DropdownMenu`: keyboard, outside tap and
Escape close it) with the name and role, the theme, the device link and, last and set apart, Sign out. Sign out needs a
second tap, and asks again each time the menu opens. Every target is at least 44 px. On a phone the bar holds only the
logo, the version badge with its channel, the connection dot and that button, so no control sits next to Sign out.

**Who you are, and sign-in first (issue #167).** The top bar says who you are at every width: the
session's user and role, in the user menu. `GET /ui/api/session` answers, logged out, `viewing: { id, name }` — the user a
read without a session reads (loopback on a one-user hopper: that user; absent with several users and on
a LAN or public request) — and `signIn.required`, true while the instance has more than one user.
**Logged out, the page is only the landing page (issue #213)**, however many users: `load` stops after
the session read (no `/api/` read, no event stream) and the page shows the hopper's name and the ways to
sign in (`ui/src/app/landing.tsx`) — a button per realm, the gateway, no sign-in; never `open-ui.sh` or a
login code box (issue #247), and with none of those on, that sign-in with GitHub is not set up yet — no
navigation, no view, no read-only notice, no top bar. Until the
session is read the page renders nothing (`sessionRead` in the store), so the app never shows before the
landing page; a daemon that cannot be reached shows the landing page with that error. A JSON sign-in
(password, no sign-in, gateway) or a logout reloads the page; a 403 on a mutation drops it to the
landing page. The UI no longer reads `viewing`. With several users the API agrees (issue #221): a
loopback read without a session reads no user's work, so neither a browser nor a process on the host
reads one user's work without that user's session.
Settings gains a **Users** section (admin only, as `GET /api/users`): the list, and **Add user**, which
shows the one-time login link the daemon answers to copy and hand over; since issue #221 also the
instance totals (admin) and **Change your password** (everyone signed in with a password account).

### Operator CLI

`hopper users` lists the users (id, name, created); `hopper user add <name>` creates one (schema,
plugins.yaml) — a running daemon starts its runtime when it next lists users, at once for one added
from the UI; `--user <id>` on `login-code` and `config` (a user's `plugins.yaml` and `rules.md`;
`auth.yaml` is the instance's, and refuses `--user`).

### Not built

Removing a user; moving an identity between users; per-user plugin installs (installs are the
instance's by decision). A client target of a user added later is attached with
`HOPPER_WORK_DIR=<work dir>/users/<id> scripts/attach-client.sh …` (its relay socket is in that
user's work dir) and its token variable under the user's prefix; the script does not take a user.

## What an admin sees (issue #221, 2026-10-06)

Owner decision: one organization runs one hopper for many users, and **users are locked away from each
other and from admins**. An admin must not see a user's sensitive information; an admin gets totals
across users instead. Inputs, from a read-only audit of `main` at `072b329`: the UI role `admin` is one
role over the instance and the session's own user, with no limit on whose work an admin's sign-in
powers reach; a loopback request without a session read any user's work (`x-hopper-user`); every user
shares one database login.

### The line

| Side | What | Who reads it |
|------|------|--------------|
| **A user's own — sensitive** | jobs (payload, prompt, title, source item, result, failure), questions and answers, events, decisions, lanes and what runs in them, job sources, machines and their ssh names, executors, escalation levels, the rules record, routing, the queue gate and order, usage sources and their accounts (email, plan, usage), webhook subscriptions and deliveries, the `plugins` record and every option in it, every CLI's config in the user work dir, the user's secret variables, the event stream, the user schema | that user's own sessions only — never an admin of the instance, never a request without a session once there is more than one user |
| **The instance's** | the users list (id, name, when added), the sign-in config (realms, password accounts and the user each signs in as, role rules — never a hash), the plugin store and its installs, self-update and its status, the instance schema | an admin (`GET /api/users`, `/api/realms`: the instance admin only since issue #240; `/api/plugin-store`, `/api/update`); loopback without a session reads them as before |
| **Instance totals** | users; jobs not ended by status (`queued`, `held`, `claimed`, `running`, `waiting_answer`); open questions; lanes open and busy; jobs ended in the last 24 hours by how they ended (issue #241); usage readings summed per unit and usage window, with how many readings each sum holds (issue #241) — summed over every user | the instance admin (`GET /api/instance`, Settings → Users; issue #240); never one user's share, nothing named — no account, source or machine |

What crosses from a user's side to the instance's is a **count**, never a name or an id. The instance's
own events (`update.*`, `plugin.installed`, `plugin.removed`) go to every user's event log, so they
carry nothing of any one user: the update's restart blockers read `waiting for <n> running job(s)`,
never the jobs (they named `job <id> (executor <name>)` of any user before).

### The seams that enforce it

- **Whose request it is** (`src/http/tenants.ts`). A session reads its own user. A loopback request
  without a session reads the one user only while the hopper has one user — a one-user install reads
  as before — and no user's work once there are more: 401. No header names a user. `GET /api/health`
  then answers the instance's part only (`ok`, `version`, `uptimeS`): install and self-update probe it.
- **Sign-in is the instance's, and gives an admin no way in** (`src/http/realms.ts`). An admin changes
  realms, accounts and roles, but no change made from an admin's session may hand that admin a
  credential that signs in as another user (409, never 403: the UI reads a 403 as a dead session):
  - no password set on an account that signs in as another user; its role may change;
  - no account added under the name of an account that signed in as another user and was removed (the
    link of realm and username to that user stays, so it would sign in as them);
  - an account is linked (`user`) only to the acting admin's own user; an account nobody signed in
    with yet gets a user of its own at its first sign-in;
  - **no sign-in** signs everyone in as `admin`: it stays off while the hopper has more than one user,
    and no user is added while it is on.
- **A user owns their password** (`POST /ui/api/password`, any role). The account the session signed in
  with takes a new password, the current one checked first (400 when wrong; 409 for a session that did
  not sign in with a password account); every other session of that account ends. A password an admin
  set for a new account stops being one the admin knows once its user changes it, and a session the
  admin opened with it ends.
- **The instance totals** (`src/http/instance.ts`, `GET /api/instance`): admin, or loopback without a
  session.

### What an admin does (issue #241)

The admin's job, stated once: **the admin manages the instance's settings, reads usage across users as
totals, and never reads another user's sensitive data.** Each part maps to the table above:

- **Instance settings** — the rows of "The instance's": users (add), the sign-in config, the plugin store,
  self-update. Every instance mutation needs the UI role `admin`.
- **Usage across users** — the instance totals. Usage is two things here: the jobs the users ran (in
  flight now, ended in the last 24 hours by how they ended) and the usage readings of every user's usage
  sources, summed per unit and usage window. A sum of `%` readings is read as a share of the summed limit
  (two accounts at 40% and 50% of 100 read 45%). Nothing names a reading's account, source or machine.
- **No other user's sensitive data** — "A user's own" above, enforced by the seams above.

### Residual risk, stated

- **The operator of the host is not an admin.** Whoever holds the database credentials (the operator
  CLI, `hopper login-code --user <id>`, `hopper config --user`) or the daemon's account reads every
  user's work: every user shares one database login, and every user's jobs run as the daemon's account
  ("Users: one hopper, separate users", Residual risk). The line above is the hopper's, drawn between
  UI sessions; it binds what an admin does through the hopper, not what the host's operator does
  outside it. A database login per user is not built.
- **An admin who controls identity can still become an identity.** An OIDC, GitHub, SAML, LDAP or gateway realm
  is the admin's to point at an identity provider; an admin who points a realm at a provider they
  control, and makes it answer with a subject a user's identity is linked to, signs in as that user.
  Not closed: realm settings are the admin's job, and the hopper cannot tell a provider move from an
  impersonation. The log records every sign-in change and every session started, with its user.
- **A new user's login link** passes through the admin who added the user. It signs in once: an admin
  who uses it leaves the user without it, which the user notices; the session the admin opened lasts
  until it expires.
- **A password the admin set** stays known to the admin until its user changes it.
- **A total over few users is close to one user's share.** With two users, an admin who is one of them
  reads the other's in-flight and ended jobs and usage by subtraction. Totals carry no names, ids or
  accounts; the counts themselves are what an admin is meant to read (issue #241).

## Queue gate (issue #159, 2026-10-05)

Before: anyone who could label an issue `hopper` (by an allowlisted author) started a job that took a
lane at once; nothing let the user see the queue and order it, turn work away, or limit how much came
in; and several hoppers watching one GitHub had no way to say which one takes an issue.

**Every new job waits at the gate.** Intake (`SourceHost.ingest`) creates the job `accepted: false`.
The decider holds it `awaiting acceptance` (step 5) until it is **accepted** — by the **pre-sort** or by
the user — or **rejected**. A job stored before the gate has no `accepted` field and counts as
accepted: no migration, no queue changed. Approving (the router's) never passes the gate.

**The pre-sort** is the queue sorter over the unaccepted jobs: its `sort` is their order, and an
optional `reject(entries) → { jobId, reason }[]` turns jobs away (the "ordering/rejecting model" — any
queue-sorter plugin; the built-ins only order). The slot checks a reject answer like a sort: anything
but `{ jobId, reason }` of the given jobs, or a throw, rejects nothing and is logged once.

**The gate** is a user setting (`settings` row `queueGate`, absent → `auto-accept`, no limit):
- `auto-accept` — before each Decision (`autoAccept`, `src/engine/queue-gate.ts`, after the stranded
  lanes are freed and before the inputs are read) the pre-sort is applied: what it rejects ends
  `rejected` (`by: pre-sort`), the rest are accepted in its order — at most `autoAcceptPerHour`
  (the throttle; null: none) counted over the `job.accepted { by: pre-sort }` events of the last hour.
  Past the limit a job waits for the user. With the default, nothing changes for a user who never
  opens the Queue view: a job is accepted in the Decision that would have started it.
- `review` — nothing is accepted by itself.

**The user order.** `POST /ui/api/queue/order { jobIds }` (operator): those waiting jobs, first to last,
get `userRank` 0..n-1; an unaccepted one among them is accepted (`by: user`); a waiting job ranked
before and not named loses its rank; `queue.ordered`. An unknown or not-waiting job → 409, one named
twice → 400. The queue order (`queue-order.ts`) is the sorter's order with the user order applied inside
each effective priority: the places the sorter gives one priority's jobs go to its ranked accepted jobs
first, by rank, then to the rest in the sorter's order — the decider is unchanged (step 6 follows the queue
order). Issue #461: the user order once came before the sorter's outright, so a ranked low-priority job
started ahead of higher-priority ones; and since Accept posts the whole accepted queue as the user order,
one Accept froze every job then waiting at its place, ahead of any job accepted or reprioritized later. A
lane that frees now takes the highest-priority job that fits its machine, oldest first among equals (with
the `priority` sorter); to run a job sooner, raise its priority. The Queue view moves a job among the jobs
of its own priority only.

**Reject.** `POST /ui/api/jobs/:id/reject` (operator) on a waiting job (accepted or not; anything else
→ 409): status `rejected`, a terminal status — ended, kept, never run — with `error` the reason
(`rejected by the user`, or the pre-sort's); `job.rejected`. Its source is told like any end (report
kind `rejected`): on GitHub the claim label goes and `hopper:rejected` is added, the issue stays open,
discovery skips it while the label is set, and removing the label offers it again as a re-run. A
rejected job is neutralized, not deleted.

**Accept pre-sort.** `POST /ui/api/queue/accept-presort` (operator) applies the pre-sort now, in either
mode and without the throttle.

**Several hoppers** (`hopperName`, an option of both GitHub sources, editable in the UI). An issue
labelled `hopper@<name>` is addressed: only the hopper whose source has that name takes it; an issue
addressed to no hopper goes to any, and the first claim wins (another hopper's `hopper:claimed` is
skipped, as before). A source with no name takes no addressed issue. Residual: two hoppers that both
take unaddressed issues can both claim one discovered in the same poll; address the issue to settle it.

**Read.** `/api/queue` adds `gate` and `presort` (`{ sorter, jobIds, reject }` over the unaccepted
waiting jobs); `waiting` is in the queue order, user order first. Events: `job.accepted { by }`,
`job.rejected { by, reason }`, `queue.ordered { jobIds }`, `queue.gate_changed { from, to }` — each wakes
the engine.

**UI.** A Queue view: the gate (mode buttons, the hourly limit; admin), then two columns — **Pre-sorted**
(unaccepted jobs in the pre-sort's order, each marked with the pre-sort's rejection if any; Accept moves
a job to the end of the user order, Accept pre-sort takes them all, Reject) and **Your order** (accepted
waiting jobs in queue order; up, down, to the top — within the job's priority —, Reject). Columns stack below `lg`. The Overview's
Waiting panel links an unaccepted job to it. Since issue #201 the gate names the queue sorter that makes the pre-sort, with a **Set up the
sorter** link to Settings → Routing, and the Queue nav entry carries a badge counting the jobs waiting on
the pre-sort (`awaitingSort`, `ui/src/model/queue.ts`); the Routing view's Queue sorter panel says it is
the pre-sort and links back.

## Config in the database: no config files (issue #198, 2026-10-05)

Owner direction: the hopper does not do files for config — no YAML and no other config file. Config lives
in the database, every setting is editable in the UI, and nothing can be set only in a file. Before, the
config documents were YAML and markdown texts in the database (`plugins.yaml`, `auth.yaml`, `rules.md`),
and the command-bearing options of a plugin could be set only with `hopper config edit plugins.yaml`.

- **Config records.** Table `config (name, value, updated_at)`: each a JSON value (`ConfigRecords` port,
  `src/store/config.ts`), replaced whole against its `version` — the sha-256 of its JSON, or `missing`
  — by compare-and-swap, as the documents were. A user's `plugins` (the plugins config, the same shape
  as before) and `rules` (a text); the instance's `sign-in` (the sign-in config). `UserStore.config` and
  `InstanceStore.config` replace `.documents`. The 5 s version watch is unchanged.
- **Migrations.** Instance migration 19 and tenant migration 4 (`src/store/migration-config.ts`): each
  YAML document becomes its value, `rules.md` its text, and `config_documents` is dropped. Every value
  comes across; YAML comments do not (JSON has none). A YAML document that does not parse stops the
  migration with the reason and changes nothing — the daemon does not start until it is fixed in the
  `config_documents` table — rather than being dropped: persisted state is the user's.
- **Every option in the UI.** The Plugins view edits every option of an instance, command-bearing ones
  too (marked "runs a command"); `POST /ui/api/plugins` `options` no longer refuses a changed
  command-bearing value. Admin only, as every plugins edit already was. The `.meta({ commandBearing: true })`
  mark stays in the JSON Schema: it says what an option is, and the UI shows it.
- **Sign-in realms as JSON.** Settings → Sign-in edits a realm's entry as JSON (`RealmView.entry`,
  `POST /ui/api/realms` `save.entry`); YAML is refused.
- **An edit can mend.** A plugins edit checks only the result: a stored plugins config that does not
  load (one migrated as it was) is mended by any edit that leaves it valid, instead of being refused.
- **The CLI.** `hopper config get|version|set <record>` (`plugins`, `rules`, `sign-in`) reads and
  replaces a record as JSON, for scripts and for mending a sign-in config that locks everyone out;
  `hopper config edit` (a temporary file in `$EDITOR`) is gone, and nano with it from the image. The
  install writes the starter rules as a JSON string.
- **Wire.** `PluginsReport.config` has no `document`, `source` is `stored` or `defaults`; `RulesView`,
  `RoutingReport` and `MachinesConfig` have no `document`.
- **Scripts.** `attach-machine.sh`, `attach-client.sh` and `container-target.sh` print how to attach the
  machine in the UI (Plugins → Machine sources) and the options to set, instead of YAML to paste.

**Residual risk, accepted by the owner.** Issue #6 kept command-bearing options out of the UI because a
UI session is readable by jobs running with `--dangerously-skip-permissions` ("UI session and
mutations"): a job holding an admin session can now set an executor's `bin`, `args` or `cwd`, a level's
`sshBin`, or where a credential is sent, and so run its own commands at the next job or question. What
still stands: only an admin session edits plugins; every edit is logged (`plugins config edited in the
UI`); the options are validated by each plugin's schema.

**Not changed.** Process settings stay environment variables (`HOPPER_*`), and secrets come from the
runtime (`NAME` or `NAME_FILE`): the database URL is needed before the database, and a secret is never
stored ("Secrets"). Attaching an ssh machine from the Machines view still offers the `Host` aliases of
the machine's own `~/.ssh/config` — ssh's file, not the hopper's; its `ssh` option is editable in Plugins.
The plugin store's catalogue `plugin-store.yaml` is a file of the store's repository, not config.

**Verification.** `test/store/config.test.ts`, `test/store/migration-19.test.ts`,
`test/store/tenant-migration-4.test.ts`, `test/integration/plugins-edit.test.ts` (a command-bearing
option edited from the UI), `test/ui/plugins.test.ts`, `test/auth/edit.test.ts`, `test/cli.test.ts`.

## No router mode (issue #211, 2026-10-06)

Owner decision: the router is the queue manager, and its advice is applied. The router mode
(`shadow`: advice recorded, never applied; `active`: advice holds and reorders jobs) was a
leftover from measuring Jev before trusting it, so it is gone, and `active` is the only behaviour.

- **Decider.** Step 3's verdict is always applied: a job with no advice yet waits (`awaiting router
  advice`); `ask_human`, `stop_retry` and `reuse_cache` hold it until it is approved; `chat_only` and
  `run_deterministic` add `routerCheapBoost`. `DecisionInputs` and `Decision` carry no mode;
  `effectivePriority(job, policy)`. A Divergence still records what the advice changed.
- **Gone:** `HOPPER_ROUTER_MODE` (now an unread variable in `leftoverEnv`), the `routerMode` setting,
  `POST /ui/api/router-mode`, `routerMode` in `/api/health`, `mode` in `/api/router`, the router's
  `ctx.routerMode()` (`RoleContext.router` adds nothing), the top bar's mode button, the Routing
  view's shadow/active buttons, the mode badge on a Decision.
- **Events.** `job.prioritized` v3 `{ advice, statusAtAdvice }` and `decision.made` v3 drop the
  mode; `router.mode_changed` is retired. v2 of both and `router.mode_changed` v1 stay readable
  (`src/events/legacy.ts`).
- **Persisted state.** Tenant migration 7 deletes the `routerMode` setting. Stored Decisions keep
  their `routerMode` field as history; nothing reads it.
- **Jev** is told `mode: active` by the gate router's shim: the hopper honours its advice.
- **Admission is by advice.** A Decision claims every job advised by then, so a burst of jobs may
  start over a few Decisions as the advice arrives, never held for a lane that is free.

## Sign in with GitHub, and work through that connection (issue #214, 2026-10-06)

Owner request (the issue's current text, which replaces its first wording): the hopper is a mediator
between GitHub and the user's devices, so for now GitHub is how users sign in and how the hopper works for
them. Users sign in with GitHub by GitHub's device flow through a GitHub App (not a plain OAuth app); that
same connection is what jobs work through — intake comes from the user's GitHub, and what is done through
it acts as that user, with GitHub marking the hopper's app on it. Only the app's public client id ships:
no private key, nothing secret. SSO, SAML and the like may sit at the edges (#185, #215), but inside the
hopper each user connects with their GitHub. The app-as-itself GitHub App source stays, only as something
an admin sets up with their own app for particular environments. Owner direction on the PR: a fresh
hopper shows GitHub sign-in without an admin adding a realm, so the first person to sign in with GitHub
can become admin (#239); GitLab is out of this change (back burner); no password user realm inside the
hopper (#237 removed it; nothing here relies on it). Context: intake stopped without a word when the one
shared GitHub App job source was removed in the UI.

**The hopper's app** (`src/connected-accounts/hopper-app.ts`): one GitHub App (device flow on, user-token
expiration off), registered once. `SHIPPED_APPS` holds its public client id and slug (for its install
link): the `hopper-qm` app, device flow on, **public** since issue #352 — any GitHub account or
organization installs it and signs in through it. The device flow (RFC 8628) needs no secret, so none is distributed. The environment may name
another app or a GitHub Enterprise: `HOPPER_GITHUB_URL` (API at `<url>/api/v3`), `HOPPER_GITHUB_CLIENT_ID`,
`HOPPER_GITHUB_APP_SLUG`. A GitHub App asks for no scopes: what its user tokens may do is the app's
permissions cut down to what the user may do, on the repositories it is installed on. See "The hopper's
app, for everyone" for the permissions and why each.

**The github realm is a device realm** (`src/auth/index.ts`, `src/auth/config.ts`): neither a form nor a
redirect realm. Settings: label, on/off, role rules; nothing of an app, no secret (the app is the
instance's). Flow, no cookies, the same binding idea as the redirect realms:

1. **Sign in with GitHub** keeps a random binding in memory and posts `POST /ui/auth/<name>/device {
   binding }` (any UI origin; rate-limited with the other sign-in routes). The hopper asks GitHub for a
   device code with the client id alone (`device-flow.ts`, `@octokit/oauth-methods` as a GitHub App,
   which reads GitHub's pending answers — HTTP 200 with an `error` — that a plain RFC client takes for
   failures) and answers `{ flow, userCode, verificationUri, expiresAt }`. It waits for GitHub in the
   background.
2. The page shows the code and the link and polls `POST /ui/auth/device/poll { flow, binding }` every 2 s
   (not rate-limited: a flow id and a binding nobody else has are needed to get anything).
3. Approved: the hopper asks GitHub who the token belongs to (`identity.ts`: `GET /user`, and the
   primary verified email from `GET /user/emails` when the app may read it) — subject the numeric id,
   username the login, groups none. **The first person to sign in with GitHub becomes admin** (#239,
   `claimGithubAdmin`, as the redirect realm did before); everyone else gets what the realm's role rules
   grant. No role: the poll answers 403 and nothing is kept. A role: the poll answers the session (`{
   state: 'signed-in', token, expiresAt, user }`) once, the identity signs in as its linked user (or a
   new one), and the token GitHub granted becomes that user's **connected account**
   (`ConnectedAccounts.adopt`). Denied or expired: 403 with the reason. A flow ends when its code expires.

**Every hopper offers it.** Migration 23 gives a hopper with no github realm one — `{ name: 'github',
label: 'GitHub', type: 'github' }`, after its realms, no role rules — so a fresh hopper shows **Sign in
with GitHub** at once and its first GitHub sign-in becomes admin. It also strips a stored github realm made
for an OAuth app of its own (`clientId`, `clientSecret`, `webUrl`, `apiUrl`) down to name, label, on/off
and role rules; `src/auth/github.ts` (the OAuth web flow) is gone. Teams as groups are not read (a GitHub
App user token reads teams only with organization members permission).

**Connected account** (`src/connected-accounts/service.ts`, the `ConnectedAccounts` port): a user's GitHub
account, in the user schema's `connected_accounts` (tenant migration 8): account, subject, access token,
its expiry if any, when. Every answer carries facts only, never a token.
- **From sign-in**, as above; **from Sources** for a user signed in at the edge (SSO, SAML, a gateway):
  **Connect GitHub** (`POST /ui/api/connected-accounts { action: 'connect', provider }`, admin of the
  session's own user) runs the same device flow and keeps the account; the identity is then linked to the
  user under every github realm (`linkIdentity`, `src/main.ts`), so signing in with it later lands in the
  same user; an identity already linked to another user stays there (logged). `cancel` ends a waiting
  code; `disconnect` forgets the account and token (it does not revoke the grant at GitHub — that needs
  the client secret; the person revokes it at https://github.com/settings/applications).
- **Install status**: `GET /api/connected-accounts` gives `installUrl` (the app's install page) and
  `installations` (`GET /user/installations`: the accounts the app is installed on that the user sees).
  The Sources panel says where and links to install.
- **Tokens** (issue #358; how they are kept alive since issue #441: "Keeping the connection"): a GitHub
  App's user tokens expire after 8 h, with a refresh token (6 months). Both are kept with the account
  (`refreshToken`, `refreshTokenExpiresAt`), from the device flow, the web flow and a GitHub sign-in alike,
  with the flow that granted them (`grantedBy`). The renewer renews the pair ahead of expiry whether or
  not anything asks, and on a 401 (the account API makes the call once more with the new token).
  **Expired**: GitHub refusing the refresh token itself (`bad_refresh_token`) with no newer pair stored, a
  401 with no refresh token, or a token past its expiry with no live refresh token ends the sign-in: kept on the record (`ended`), the account reads
  `state: 'expired'` with why — never `connected` — offers no login (so a gh source with `enabled: auto`
  runs again), its source pauses with `GitHub's sign-in expired: Sources → Connect GitHub again`, and
  `connected_account.expired { provider, account, reason }` is recorded once, which the notifiers send.
  A report, a run again, an intake action or a close of its jobs says the same, never that GitHub is not
  connected (issue #518). Connecting again replaces the record. **Cannot renew** (issue #518): a token that
  expires with no refresh token beside it reads `connected` while it lives, with `unrenewable` (why) and
  `expiresAt`; the panel says it cannot renew and when it ends, and offers Connect GitHub again (signed in
  with GitHub: sign out and in again).

**Intake** (`job-source/github-account`; a built-in instance, added to every existing plugins config by
tenant migration 8, since job sources are a restart role): the GitHub source logic (`createGitHubSource`,
mode `account`) over the account's token — `src/sources/github/account/api.ts` (the App adapter's REST and
GraphQL calls; its issue search is gone since issue #359) — rebuilt when the account changes (`createAccountSource`,
`src/sources/compose.ts`). It takes the issues assigned to the connected account (issue #387). Which repositories
it lists are the user's **job repositories**, chosen in Sources ("Job repositories", issue #321); none
chosen, none listed. A connect or disconnect syncs the source at once. **Not connected is said out loud**: the source is paused with `GitHub is not
connected: Sources → Connect GitHub`, and `GET /api/accounts` carries the same problem. (The gh source
paused while an account was connected; it is removed by issue #359.)

**Jobs act through it** (`JobSource.credentials`, `ExecutionContext.credentials`): when a job of the
connected account starts, the engine asks its source for its credentials and keeps them on the job's
machine, where every renewal rewrites them ("Keeping the connection", issue #441): `gh` in the job (pull
requests, issue reads) reads the account's token from its config dir there, acts as the user, and GitHub
shows the hopper's app on it. Never stored on the job or its payload. A machine whose connection keeps no
files runs the job with `GH_TOKEN`, the token as it is at its start.

**The app-as-itself source** (`github-app`, an admin's own GitHub App and its private key) is no longer a
built-in instance: an admin adds it in Plugins where it suits; existing configs keep theirs.

| dir | owns | must not import |
|-----|------|-----------------|
| `src/connected-accounts/` | the hopper's app (`hopper-app.ts`), the device flow (`device-flow.ts`), the web flow (`web-flow.ts`, issue #258), who a token belongs to and where the app is installed (`identity.ts`), a user's connected account (`service.ts`), its renewal (`renewal.ts`, `renewer.ts`) and its tokens at rest (`at-rest.ts`, issue #441) | engine, http, store, plugins, decider |
| `src/sources/github/account/` | the issue port over a connected GitHub account's token | engine, http, store, plugins |

**Residual risk, stated.** Tokens are in the database sealed under `HOPPER_MASTER_KEY` since issue #441; with no
key the hopper keeps none (issue #659), and only a row from before #441 is in clear until the renewer seals it. A token reaches what the user may do on the repositories the app
is installed on. A job's token is in a file of its own on its machine (mode 600), and in its pane's
environment only where that file cannot be kept; any process of the daemon's account on that machine can read it. The
command and Cursor executors run without it (their variables would sit in a long-lived argv): not built.
Until someone signs in with GitHub, whoever reaches the UI first and signs in with GitHub becomes admin:
sign in yourself before you expose the hopper (#239). GitHub Enterprise's GraphQL (`<url>/api/graphql`)
is not reached by `HOPPER_GITHUB_URL`: completion checks there fail as a permanent error. Commits are
pushed with the machine's own git credentials unless its git uses gh's credential helper. GitLab: not
built (back burner).

**Verification:** `test/integration/sign-in-device.test.ts` (the real daemon, store and HTTP edge against a
fake GitHub on loopback, `test/support/fake-forges.ts`: a fresh hopper offers it; the code asked for with
the client id and no secret; the first person becomes admin and their connection is kept; the next gets
the rules' role, or none and nothing kept; the first admin stays admin after a restart; a hopper with
earlier GitHub sign-ins makes nobody admin; another browser or site refused),
`test/integration/connected-accounts.test.ts` (connecting from Sources, where the app is installed, intake
and labels through the account's token, a job running with `GH_TOKEN` that is never stored, disconnect, a
denied code, users apart), `test/store/migration-23.test.ts`, `test/store/tenant-migration-8.test.ts`,
`test/ui/sign-in-device.test.ts`, `test/ui/sources.test.ts`, `test/ui/sources-view.test.ts`.

## Keeping the connection (issue #441, 2026-10-08)

A connection made through the hopper's GitHub App had to be made again within about a day. GitHub App user
tokens last 8 hours and come with a refresh token good for about 6 months, so one connection can last
months, renewed by the hopper alone. #358 renewed only when something asked for a token, not atomically
across processes, and ended the connection on any refusal; and GitHub invalidates both the refresh token
and the access token it came with the moment the refresh token is used, so every renewal cut off the jobs
already running. (The live hopper had no `connected_account.expired` event when this was built: its
connection then came from a GitHub sign-in that adopted a new grant.)

**The renewer** (`src/connected-accounts/renewer.ts`). It looks at the account every `RENEW_EVERY_MS`
(60 s) and at the runtime's start, and renews the token once `RENEW_AHEAD_MS` (an hour) or less of it is
left, whether or not anything asked for one; a hopper that was down past the 8 hours renews at start with
the stored refresh token. `token()` renews the same way when it is asked first, and `renew(refused)` after
a 401. One renewal:
1. in this process, one at a time per account (`renewing`);
2. across processes on one database — an old and a new container overlapping, another runtime — the
   account's **advisory lock** (`pg_try_advisory_lock(hashtext('hopper connected account ' ||
   current_schema() || ' ' || provider))`, `ConnectedAccountRepository.lock`), session-level, so a crashed
   process lets it go; waited for up to 30 s, polling, and given up for now when the stored refresh token
   changes meanwhile (another process renewed: its pair is used);
3. under the lock the row is read again: a pair another process rotated is used, and GitHub is not called;
4. GitHub's answer is kept at once, before anything else awaits — `swap(provider, refreshToken, next)`: one
   transaction, the row `FOR UPDATE`, written only while its refresh token is still the one used (a
   compare-and-swap). A crash can only lose a rotation in the time between GitHub's answer reaching the
   process and that synchronous write; tested by reading the row from another connection at the first
   moment anything else could run.

**What ends it, and what does not.** The sign-in ends only when GitHub refuses the refresh token itself
(`bad_refresh_token`: used, revoked, expired, or the app's authorization removed) and the row, read again,
holds no newer pair — an older hopper that takes no lock may have rotated it first, and then that pair is
used, once — or when the refresh token is past its own expiry. Everything else is a **renewal trouble**,
never an end: GitHub not answering, a 5xx, a rate limit, the lock held too long, GitHub refusing the app's
own credentials (`incorrect_client_credentials`, `invalid_client`, `unauthorized_client`), or a grant this
hopper cannot renew as it is set up. It is logged, shown on the account (`ConnectedAccountStatus.renewal`,
the Sources panel's **could not be renewed yet**), and tried again after 30 s, 1, 2, 5, 10, then every 15
minutes (`RETRY_MS`); an ask before then gets the current token while it is still good, else the trouble
as an error. An ended connection reads `expired` (never `connected`), is told once
(`connected_account.expired`, which the notifiers send), pauses its source, and asks to connect again in
the Sources panel and in the header, on every screen (`detail.expired` on the source's status).

**A browser grant** (the web flow, #258) renews only with the app's client secret; a device flow grant
without it. The account keeps which flow granted it (`grantedBy`); a web flow grant in a runtime with no
`HOPPER_GITHUB_CLIENT_SECRET` is not sent to GitHub at all (`RenewalBlocked`): a renewal trouble naming the
variable, renewed once it is set. A grant kept before #441 has no `grantedBy` and renews as #358 did.

**At rest** (`src/connected-accounts/at-rest.ts`, `src/secrets/token-box.ts`). The access and refresh
tokens are sealed with AES-256-GCM (node:crypto) under the runtime's `HOPPER_MASTER_KEY` (32 bytes, 64 hex
digits or base64), `sealed:v1:` + base64url(nonce ‖ tag ‖ ciphertext). The key comes from the launch
("The master key", issue #659). A key that is no key stops the runtime (fails closed); no key (limited) keeps
no new token, never one in clear. A row kept in clear from before #441 is sealed by the renewer's next look. A
sealed row the runtime cannot open (no key, another key) reads `unreadable` with what to do — never
connected, never ended (issue #514, "One grant per connection"). Everything a renewal needs is in Postgres and the runtime's key, so a fresh container on the
same database and secrets carries on without a new sign-in.

**Running jobs** (`src/engine/credentials.ts`). A job's source answers its credentials as `files` (kept
in the job's **credentials dir**, `<scratch>/credentials`, on its machine), `paths` (variables pointing
there) and `env` (the token as it is now). The executor asks with the job's scratch dir
(`ExecutionContext.credentials(scratch, makeWorkTree)`); the engine records the dir on the job
(`credentialsDir`), writes the files through the machine's own connection — this machine's shell, ssh, or a
client target's `POST /credential` (`src/client/credential.ts`: a fixed script, the content on stdin, the
file replaced whole, mode 600, only under `…/.hopper-scratch/<job id>/credentials`, never making a work
tree that is not there unless it is the jobs dir) — and answers the variables. For GitHub: `gh/hosts.yml`
with the token under the host, and `GH_CONFIG_DIR` pointing at it; `gh` reads it at each run, and so does
gh's git credential helper. After every renewal (`onRenewed` → `engine.renewCredentials()`), each job in
flight with a `credentialsDir` has its files rewritten; a machine that cannot be reached is logged and
keeps the files it has until the next renewal reaches it. A machine whose connection keeps no files (an
executor with no machine shell) runs the job with `env` — `GH_TOKEN` as at its start — and says so in its
progress. The reap removes the credentials dir whatever else it keeps.

**Hopper sessions are not bound to the token** while the connection lives: a token renewing or failing to
renew for a reason that may pass never ends a hopper UI session; its lifetime is #439's. A connection that
**ends** ends the sessions signed in with GitHub (issue #513, "A GitHub sign-in ends with its connection").

**Verification:** `test/connected-accounts/rotation.test.ts` (real Postgres, two connections to one user
schema as two processes, the real renewal over HTTP to the fake GitHub, a fake clock: renewed by the
scheduler with nothing asking; renewed at start after 10 hours down; two processes at once, one GitHub
call, both with the new pair; the pair stored before anything else runs; `bad_refresh_token` after an
older process rotated, recovered; a revocation ends it, told once; 5xx and network errors end nothing and
back off; a web flow grant with no secret is not sent; sealed at rest, a fresh process with the key carries
on, another key reads unreadable), `test/integration/connected-account-renewal.test.ts` (a running job's
credential file on its machine rewritten with the renewed token, GitHub refusing the one it started with),
`test/client/machine-shell.test.ts` (the credential script on this machine and a client target),
`test/secrets/token-box.test.ts`, `test/ui/sources-view.test.ts` (the header prompt, the renewal trouble),
`test/scripts/compose.test.ts`, `test/integration/unit-file.test.ts`.

## One grant per connection (issue #514, 2026-10-08)

#441 keeps one hopper's connection alive on one database. It did not keep it alive beside other hoppers on
the same GitHub App and GitHub user: GitHub keeps at most **ten tokens per user, app and scope**, and making
an eleventh revokes an older one — one never used first, else the least recently used — whoever holds it.
Every device flow connect, web flow connect and sign-in with GitHub makes a new grant; a renewal rotates
inside one grant and makes none. Before #514 a disconnect only deleted the row, and a connect or a sign-in
over a live connection overwrote it: the grant left behind kept its place among the ten for its six months.
A burst of short-lived containers connecting as the same user could so revoke a healthy hopper's refresh
token, and it read "sign-in expired" while its renewer was fine.

GitHub's limits, which the hopper cannot change: a user token lasts 8 hours (`expires_in` 28800); a refresh
token about 6 months (`refresh_token_expires_in` 15897600), used once, each renewal giving a new one with a
fresh 6 months; ten tokens per user, app and scope, and at most ten made per hour (the hourly limit asks to
sign in again; it revokes nothing). An installation token (1 hour) acts as the app, not as the person: no
stand-in for the connection.

**Revoke what is replaced or dropped** (`src/connected-accounts/revocation.ts`). Before a new grant is kept
over a live one — `keep`, from Connect in Sources or from a sign-in with GitHub (`adopt`) — and before a
disconnect deletes the row, the stored grant's access token and refresh token are revoked at GitHub:
`POST /credentials/revoke` (through @octokit/request), which takes both kinds of token, needs no
authentication and no client secret (the hopper's app ships none), and makes GitHub email the account's
owner that they were revoked. Both tokens, so nothing of the grant is left (D3). Not when the stored grant
ended (GitHub holds it no more), not a token the new grant keeps, and not a row that cannot be opened (logged:
the grant is left alive, its tokens unknown). Best effort: GitHub refusing or not answering within 10 s
(`REVOKE_TIMEOUT_MS`) is logged — the grant then counts toward the ten until it expires — and the new pair is
kept, or the row deleted, all the same. It runs with no renewal of the account under way
(`Renewer.exclusive`: the in-process renewal settled, the account's advisory lock taken as a renewal takes
it), so the grant revoked is the one stored, and a renewal in another process never sees its refresh token
refused before the new pair is there.

**Connect again only when it ended.** The Sources panel offers *Connect GitHub again* only for an `expired`
connection (GitHub refused the refresh token itself, or it is past its own expiry). A **renewal trouble**
reads connected, with its reason, and is tried again (#441). A 401 on a call says GitHub refused the token;
the renewer decides whether the sign-in ended, the message no longer says to connect again. A connection
sealed under a key the runtime does not give reads **`unreadable`** (`ConnectedAccountStatus`): its source
pauses saying to give the hopper the key it was sealed under, as `HOPPER_MASTER_KEY` or as
`HOPPER_MASTER_KEY_PREVIOUS` beside a new one; it is not expired, so the header asks nothing and no session
ends (#513); the panel offers only *Forget this connection*, after which Connect is offered. A key rotation
asks for no new sign-in: the token box opens under `HOPPER_MASTER_KEY_PREVIOUS` and the renewer seals again
under the new key.

**Sharing one app and one user** (D1, D2: conservative — the shipped public app stays shared; the
operational rule below, nothing enforced in code). A hopper holds **one** grant per connected account, so
the budget is: hoppers connected as one GitHub user on one app, plus any short-lived instance connected as
that user, at most ten — fewer leaves room for a person's own reconnects (each revokes the grant it
replaces, so it does not add to the count). The hopper cannot see how many grants GitHub holds for the user
(no GitHub API answers it), so the count is the operator's to keep. A verify, test or CI container must not
connect as a person whose hoppers matter on the hopper's app: give it its own GitHub App
(`HOPPER_GITHUB_CLIENT_ID`) or its own GitHub user, or let it run with no connection (an internal-only
network, as the verifications of a release do); one that connected anyway uses *Stop working through
GitHub* before it is removed, which revokes its grant. `docs/deploy.md` "GitHub sign-in" says the same.

**Not done, and why.**
- **Renewing a hopper's place in GitHub's least-recently-used order** (D5: an authenticated call such as
  `GET /user` after each renewal): no evidence that eviction by use order hits healthy hoppers; the jobs
  and sources of a connected hopper call GitHub with its token all day. Settles when a live revocation is
  traced to that order.
- **A "grants in use" warning in Sources** (D4): the hopper sees only its own grant; a count it cannot
  read would be a guess. Settles if GitHub answers the count, or repeated `bad_refresh_token` soon after
  connects elsewhere becomes a pattern worth naming.
- **One GitHub App per durable hopper** (D1): an install may already name its own app
  (`HOPPER_GITHUB_CLIENT_ID`, `HOPPER_GITHUB_APP_SLUG`, docs/deploy.md); the shipped app stays one.

**Verification:** `test/connected-accounts/grants.test.ts` (real Postgres, the real revocation and renewal
over HTTP to a fake GitHub that keeps at most ten grants per user and revokes the least recently used:
connecting again revokes the old pair before the new one is stored; a sign-in over a live grant revokes it,
the same grant handed over again does not; disconnect revokes then deletes, and GitHub failing deletes all
the same and logs it; twelve reconnects on one hopper leave another hopper's grant alive, renewed hours
later, and fail without the revocation; another key reads `unreadable`, names `HOPPER_MASTER_KEY_PREVIOUS`,
is not expired and revokes nothing; the old key as `HOPPER_MASTER_KEY_PREVIOUS` opens it and the next look
seals it under the new key), `test/integration/grant-hygiene.test.ts` (the daemon: *Stop working through
GitHub* revokes at GitHub, unauthenticated; an unreadable connection pauses its source with what to do and
no `expired`), `test/secrets/token-box.test.ts`, `test/ui/sources-view.test.ts` (no Connect, no header
prompt for `unreadable`), and #441's `test/connected-accounts/rotation.test.ts` unchanged but for the state's
name (renewal trouble still ends nothing).

## The hopper's app, for everyone (issue #352, 2026-10-07)

Owner request: the hopper's app could be used only by the account that registered it; other people
installing the hopper need it too. Make it public, keep its permissions to the least the hopper needs (an
outside person sees and grants them), give a clear install path from the UI and the install docs, make a
hopper work for an account that is not the app's owner (job repositories, #321), and document an admin's
own app as the alternative (#214).

**Public.** The app's *Advanced → Make public* is done on GitHub, not in code: `GET
https://api.github.com/apps/hopper-qm` answers without authentication, which GitHub does only for a public
app, and its install page (`https://github.com/apps/hopper-qm/installations/new`) lets any account or
organization install it. Nothing in the hopper names the owner: the client id and the slug are the app's,
and installations, repositories and the identity come from the signed-in person's own token
(`GET /user/installations`, `GET /user/installations/<id>/repositories`, `GET /user`).

**Permissions, the least the hopper needs** (as GitHub reports them for the app; no events, no webhook —
the hopper pulls):

| permission | level | why |
|---|---|---|
| Issues | read and write | issues are the jobs: read them, set the `hopper:*` labels, reopen one for Run again (#354) |
| Pull requests | read and write | a job opens its pull request; completion checks read the pull request that closes an issue |
| Contents | read and write | a job pushes its branch with its token (`GH_TOKEN`) where its git uses gh's credential helper (else the machine's own git credentials push) |
| Metadata | read | required by GitHub for any repository permission |

Not asked for, and what that costs: **Workflows** (a job cannot push a change to `.github/workflows/`;
GitHub refuses that push), **organization Projects** (a `projects` priority on an organization board
reads nothing through the hopper's app; user Projects are not readable by any GitHub App), **Email
addresses** (the identity has no email; role rules match subjects and usernames). An admin who needs any
of these runs their own app (below). The design section above listed Projects and Email addresses as the
app's: it never had them.

**Install path.** Before an installation: Sources says the app reaches no repository and links to its
install page (#253). With installations: each says the repositories it reaches, **what it may do there**
(`AppInstallation.permissions`, GitHub's installation answer, in words: "It may: read and write contents,
issues, pull requests; read metadata."), and a link to choose its repositories; under them a quiet link
**Add the app to another account or organization** (the install page, where GitHub asks which account and
which repositories) — not a nudge to install it again. On GitHub's install page the person picks *All
repositories* or *Only select repositories*; the hopper then lists those, and the person ticks the job
repositories (#321). An organization owner installs it for the organization (or approves a member's
request); the member then sees that installation too.

**An admin's own app instead** (#214): `docs/sign-in.md` "Running your own GitHub App instead of the
hopper's" — the same permissions, *Any account* or *Only on this account* as the admin wants, and
`HOPPER_GITHUB_CLIENT_ID` / `HOPPER_GITHUB_APP_SLUG`. The `github-app` job source (an app acting as its
own bot) is a different thing (README "A GitHub App of your own").

**Verification:** `test/integration/connected-accounts.test.ts` (a connected account — not the app's
owner — sees each installation with its repositories and permissions, on its own account and an
organization's), `test/ui/sources-view.test.ts` (what it may do, the link to add it to another account).
Live: the app answers unauthenticated as public, with the four permissions above and no events.

## A pleasing sign-in page; GitHub by browser redirect when possible (issue #258, 2026-10-06)

Owner request: the sign-in page is not aesthetically pleasing — make it pleasing, use a better layout, maybe
a compelling background; the device code layout is poor (all left justified for no reason). Auth flow, owner
decision on the issue: **browser redirect when possible, device flow as fallback.** What that settles, taken
from GitHub's documentation, not asked: a GitHub App's web flow exchanges its code only with the app's
client secret, PKCE or not, and a callback must match one registered on the app (no port or host
wildcards). So "when possible" is: the runtime gives the app's client secret, and the browser is on the
sign-in origin (whose callback the operator registers); a LAN name, a phone or a hopper without the secret
gets the device code. Not this issue: whether a new hopper registers itself (#259).

- **The page** (`ui/src/app/landing.tsx`, `index.css` "landing"; its layout since issue #266, below): one centred card over a backdrop in the
  logo's teal — slow aurora light, a dot grid fading toward the edges, the logo's silhouette, grain and a
  vignette; pure CSS, nothing fetched, still for reduced motion; always dark. The card: the logo, the name,
  one line of what the hopper is, then the ways to sign in in groups — GitHub first as one large button,
  then after one "or" rule the redirect realms, the gateway, the LDAP form and no sign-in, full width.
- **The device code** (`ui/src/components/device-code.tsx`, the landing page and Sources' Connect GitHub):
  centred around the code — large, monospaced, a copy button beside it; **Open GitHub** (a new tab; the press
  copies the code too) and the address in short under it; what it waits for and how long the code lasts;
  Cancel.
- **The browser redirect** (`src/connected-accounts/web-flow.ts`, `src/auth/index.ts`): with
  `HOPPER_GITHUB_CLIENT_SECRET` (or its `_FILE`), read from the runtime at each use and checked at start (a
  bad one stops it), a GitHub realm is also a redirect realm on the sign-in origin. The session's
  `signIn.devices` entry carries `redirect: true`; the button then goes `/ui/auth/<name>/start` → GitHub's
  `/login/oauth/authorize` (client id, callback `<origin>/ui/auth/<name>/callback`, the flow id as state, an
  S256 PKCE challenge) → the callback exchanges the code with the secret and the verifier (openid-client, the
  endpoints named, GitHub being no OpenID provider) → who the token belongs to, the first GitHub admin and
  the role rules exactly as the device code's (`grantedTo`, shared) → a ticket that also holds the
  connection → `POST /ui/auth/complete` with the binding, whose session's user gets the connected account.
  **Use a code instead** under the button starts the device code. Without the secret nothing changes:
  `/start` for a GitHub realm answers 404, and the device code is the way in.
- **The pages the daemon writes** (`src/http/ui/sign-in.ts`: signing in, cannot sign in) take the same look.

**Residual risk, stated.** The client secret sits in the daemon's environment or a mounted file, as the
database URL does; whoever reads it can exchange codes as the hopper's app (not mint them: the person still
approves at GitHub). The hopper's own app ships without it, so a hopper on it signs in by code until its
operator holds the secret and registers the callback.

**Verification:** `test/integration/sign-in-github-redirect.test.ts` (the real daemon against a fake GitHub
with the web flow: with the secret, to GitHub with client id, callback, state and PKCE challenge and back as
the first admin with the account connected, the exchange with secret and verifier, the secret in no answer;
without it no redirect and the device code; a denial; another browser's binding refused),
`test/ui/sign-in-device.test.ts` (the redirect button, Use a code instead, the centred code panel with copy
and Open GitHub, Cancel), `test/integration/unit-file.test.ts` (the secret is read without a warning and kept
in no config).

## The sign-in page as a page, not a lone card (issue #266, 2026-10-06)

Owner request, after issue #258: make the sign-in page pleasing to look at, with a better layout and a
compelling background; centre the device code; browser redirect when possible, the device code as
fallback. The last two shipped with #258 (the code panel centred; GitHub's web flow with PKCE on the
sign-in origin when the runtime gives the app's client secret, the device code otherwise, a LAN name or a
phone always the code) and stay as they are. This change is the layout and the backdrop.

- **Two columns on a wide screen** (`ui/src/app/landing.tsx`, `lg` and up): on the left a panel
  (`data-landing-showcase`) says what the hopper does — a line naming it, the headline "Your GitHub
  issues, worked on your machines." in white fading to the logo's teal, one sentence, and three steps
  joined by a line: **Label an issue**, **It runs on your machine**, **Review the pull request**. On the
  right the sign-in card (`data-landing-card`), unchanged inside, its subtitle "Sign in to see your
  jobs." since the panel carries the headline. Narrower, the panel is not shown and the card stands alone,
  centred, with the headline as its subtitle as before.
- **The backdrop** (`index.css` "landing"): the aurora, dot grid, grain and vignette stay; the logo's
  silhouette is gone, and in its place lanes: six faint lines across the page, tilted a little, each with a
  job — a short bright streak in teal or violet — going along it at its own pace. Still for reduced motion
  (each streak stops part way along); pure CSS, nothing fetched.

**Verification:** `test/ui/signed-out-landing.test.ts` (the card beside the panel, its headline and the
three steps, the lanes; the card not inside the panel), `test/ui/sign-in-device.test.ts` (unchanged: the
redirect button, the centred code panel), and the built page drawn in a headless browser against a fake
daemon at desktop and phone width: GitHub alone, every way to sign in, and the device code.

## Sources: signed in with GitHub, one GitHub piece (issue #254, 2026-10-06)

> Since issue #359 there is no gh source or gh login panel to hide: the connected account's panel is the
> GitHub section whether connected or not. The text below is what #254 built.

Owner request: after signing in with GitHub through the hopper's app (#214), Sources still showed the
overlapping GitHub pieces — the **gh login** panel (logged out), the `github` card (gh, paused because a
GitHub account is connected) and the `github-account` card beside the **GitHub account** panel. Signing in
with GitHub is the connection, and jobs work through it; the app-as-itself source (`github-app`) is only for
an admin's own GitHub App in particular environments, not a built-in beside the user's connection.

**As built** (`ui/src/model/sources.ts`, `ui/src/views/sources.tsx`, `ui/src/views/connected-account.tsx`,
`ui/src/views/source-sync.tsx`; no wire or daemon change):
- The connected account's source (`github-account`) is the connection itself: its sync (seen, created,
  active, last and next sync, errors, assignee and label) is shown inside the **GitHub account** panel while
  connected, never as a card of its own.
- **Connected** (that source neither paused nor switched off): the gh source and the **gh login** panel are
  not shown, and the summary says issues are read, and jobs work, through the GitHub connection. A job gets
  the account's token as `GH_TOKEN` (#214), so gh login on the host is not what jobs push as.
- The `github-app` source is shown only where an admin set up an app: not while it is paused with `no GitHub
  App configured`; a set-up app that is broken (another pause reason) or in use stays, connected or not.
- Not connected: gh and gh login show as before (#160), with the summary pointing at Connect GitHub.
The instances stay in the plugins config (Settings → Plugins shows and edits them); only Sources stops
listing what is not a connection.

**Verification:** `test/ui/sources.test.ts` (the model: connected shows no gh, gh login or unset app; an
admin's app in use stays; a broken app stays; not connected) and `test/ui/sources-view.test.ts` (the whole
app against a fake daemon, signed in with GitHub: the section holds only the GitHub account panel with its
source's sync; no gh login, gh card or github-app).

**A gh source that cannot run (issue #320, 2026-10-06; moot since issue #359, which removed the gh source
and every `github-gh` instance).** A source the host cannot build (unknown plugin,
invalid options — e.g. an older plugins config whose `github` instance names no `authors`) is reported
with its plugin's id as its kind (`src/users/runtime.ts` `splitSources`): `github-gh`, not `github`. The
model counted only kind `github` as gh, so that source fell through to the other sources and showed as a
card in error beside the GitHub connection. The model now counts kind `github-gh` as gh too: connected, it
is not shown and neither is its error; not connected, it is the gh connection, with its error, not a card
of its own. The instance stays in the plugins config. Verification: `test/ui/sources.test.ts` (#320 cases).

## Job rules (issue #172, 2026-10-06)

Owner direction: the hopper's rules must be editable, not baked in; what the hopper relies on to read a
job back stays deterministic. Before, every job's footer was a constant: the publishing rule, the work
tree, parallel work, the protocol.

- **The record.** A user's config record `job-rules` (`src/job-rules/`), a text of at most 16 KiB. It
  leads every job's footer. While none is saved, a job gets the **default job rules** — the publishing
  rule and the parallel-work rule, the text the footer had (and, since issue #571, the writing style; since issue #569, the formatting). A saved empty text gives none. No migration:
  a missing record is the default.
- **What stays fixed.** The work tree line (the executor sets up that tree and its scratch dir) and the
  protocol lines (the markers `screen.ts` reads, the last line the turn anchor) follow the job rules
  and are not edited; nor is the status-note nudge. Neither are the risk rules ("Question gates"): code,
  so nothing can weaken them.
- **When it applies.** The engine reads the record as each job starts and hands it to the executor
  (`ExecutionContext.jobRules`); herdr-claude and cursor-agent put it in the footer
  (`protocolFooter(cwd, jobRules)`). A running job keeps what it started with; the next job gets an
  edit, without a restart. An executor given none uses the default.
- **Editing.** Settings → Job rules: the text, edited whole against its version
  (`GET /api/job-rules`, `POST /ui/api/job-rules`, admin), with the default one click away and the
  fixed lines shown read-only. `hopper config set job-rules` from the CLI.
- **The publishing rule.** AGENTS.md "GitHub text is neutral" holds through the default job rules; the
  owner may now change it, as they may any job rule.

**Verification.** `test/job-rules/job-rules.test.ts`, `test/herdr/screen.test.ts`,
`test/herdr/executor-run.test.ts`, `test/adapters/cursor-executor.test.ts`,
`test/integration/job-rules.test.ts` (a saved edit reaches the next job), `test/cli.test.ts`,
`test/ui/job-rules-panel.test.ts`.

## Sources: Sign out for a GitHub sign-in, not Disconnect (issue #322, 2026-10-06)

Owner request: the **GitHub account** panel in Sources offered **Disconnect** on the connected account,
which for a person signed in with GitHub is their hopper sign-in, so the label read like an optional
integration. The sign-in must not be shown as something to disconnect; a way to stop using GitHub for jobs
without ending the session, if kept, must be its own, explicitly labelled action.

**As built** (`ui/src/views/connected-account.tsx`, `useSignedInWith` in `ui/src/store/selectors.ts`; no
wire or daemon change):
- **Signed in with GitHub** — the session's realm (`SessionUser.realm`) is one of the GitHub realms on
  (`signIn.devices`): the panel says *Signed in with GitHub as …* and offers **Sign out** (the header's
  logout, `POST /ui/api/logout`). No disconnect. To stop taking jobs from GitHub while signed in, it points
  at Settings → Plugins, where the `github-account` job source is switched off — what already exists, so no
  second control.
- **Signed in another way** (the login code, SSO, SAML, a gateway), where the account was connected from
  Sources: **Stop working through GitHub** (`disconnect`, unchanged) forgets the account and its token; its
  title says the sign-in stays.
- `POST /ui/api/connected-accounts` keeps `disconnect` as before; only the panel stops offering it to a
  GitHub sign-in.

**Verification:** `test/ui/sources-view.test.ts` (signed in with GitHub: *Signed in with GitHub as*, the one
button **Sign out**, which posts `/ui/api/logout` and never `connected-accounts`; signed in with the login
code: the one button **Stop working through GitHub**, which posts `disconnect` and keeps the session).

## Job repositories (issue #321, 2026-10-06)

Owner request: once GitHub is connected, Sources lists every repository the account reaches (dozens) and
treated all of them as in scope for jobs, with no way to narrow it. The person must choose which
repositories jobs may use, change the choice later without disconnecting, and see how many are chosen of
how many are available.

**As built:**
- **The choice is the user's setting**, `jobRepositories:<provider>` in the user schema's `settings`
  (`UserSettingsRepository.getJobRepositories`/`setJobRepositories`), not an option of the
  `github-account` source: job sources are a restart role, so an option would apply only at the next
  restart. It outlives a disconnect (the token is the connection's; the choice is the person's).
- **None chosen, no job.** The connected account's source lists only the job repositories, repo by repo
  (`listOpenIssues`), never a search over all the account reaches; with none chosen it is paused with `no
  repositories chosen for jobs: Sources → GitHub account → choose them`, and still checks and reports its
  own active jobs. It reads the choice at each sync (`ConnectedAccountTokens.jobRepositories`) and is
  rebuilt when the choice changes, as when the account does.
- **Choosing.** `POST /ui/api/connected-accounts` `{ action: 'choose', provider, repositories }` (admin;
  each an `owner/repo`, the whole list, duplicates dropped) stores it and syncs the source at once; the
  answer and `GET /api/connected-accounts` carry `jobRepositories` on a connected account.
- **Sources** (`ui/src/views/connected-account.tsx`): every repository the app reaches, under its
  installation (#253), with a box each; a filter, **Choose shown** / **Clear shown** for what the filter
  shows, `N of M repositories chosen for jobs`, a warning while none is chosen, and **Save**. A chosen
  repository the app no longer reaches stays listed, marked so, to be cleared.
- **What a job acts on.** A job comes only from an issue in a job repository. Its `GH_TOKEN` is the
  account's token, which GitHub bounds by the repositories the hopper's app is installed on; the hopper
  does not narrow a token further.
- **Migration** (tenant 10, `src/store/migration-job-repositories.ts`): `repos` a `github-account`
  instance named become the job repositories; `repos` and `owners` leave its options. Owners name no
  repository, so they choose none. A hopper whose account source named neither takes no new job until
  repositories are chosen — the request: never every repository by default.

**Verification:** `test/integration/connected-accounts.test.ts` (none chosen: paused and no job, no
search; chosen: only those repositories' issues become jobs; changed while connected; kept across a
disconnect; refusals), `test/store/tenant-migration-10.test.ts`, `test/ui/sources-view.test.ts` (count,
filter, Choose shown, Save sends the whole list, an unreached chosen repository).

## Default work trees per machine and per repository (issue #324, 2026-10-07)

**Superseded in part by issue #361** ("Per-machine work trees"): the source's `repoPaths` and
`defaultCwd` and the executor's `cwd` are gone, and a routing rule's work tree needs its machine.

Owner request: default job directories set per machine and per repository, with a fallback, resolved on
the machine that runs the job, never in the hopper's own home; a repository routed to the right machine
and tree; the chosen machine and directory shown on the job's lane; a misconfigured directory failing at
once. Resolving on the target (#323), refusing the home (#314) and failing an unusable work tree at once
(#323) were already built; this adds the per-machine default and routing a repository to a path.

**As built:**
- **A machine's work tree.** The machine-source plugins `local`, `ssh` and `client` take an optional
  `workTree` (an absolute path or one under `~`, which is that machine's home): the default work tree of
  jobs there that name none of their own. Command-bearing, edited in the Plugins view's options form like
  any machine option. Not on `docker`: a container target runs only `command` jobs, which take no work
  tree. It reaches the executor on the lane's `MachineSnapshot.workTree`.
- **A routing rule's work tree.** `set.workTree` on a routing rule is the job's own work tree, so a rule
  routes a repository (or any match) to a machine and a path there:
  `{ match: { repo: owner/app }, set: { machine: laptop, workTree: ~/code/app } }`. It is recorded in
  `spec.routedBy.set` (additive in `job.queued`, still v1) and shown on the job ("routed by …: machine
  laptop, work tree ~/code/app"). Edited in the Routing view.
- **The order.** The executor (`resolvePayload`, `src/executors/herdr/payload.ts`; herdr-claude and
  the print agents — cursor-agent, codex, opencode, omp) takes the first that is set: the job's own `cwd` — a routing rule's `workTree`, else its
  repository's `repoPaths` entry, else one the item came with —, then the lane's machine's `workTree`,
  then the payload's `defaultCwd` (its source's), then the executor's own `cwd`. Then `workTreeOn`
  resolves `~` on that machine and refuses its home, as before.
- **The source's default is a default.** A GitHub source puts `cwd` in the payload only for a repository
  in `repoPaths`, and its `defaultCwd` as the payload's `defaultCwd`; before, it put `defaultCwd` in
  `cwd`, which no machine could override. `SourceItem.cwd` and `SourceItem.defaultCwd` are both optional
  for a plugin's job source. Jobs queued before keep the `cwd` they were given; no migration.
- **Choosing the machine** stays the decider's: a routing rule's machine pin, the machine's executors,
  lanes, budgets and online state. The work tree follows the machine chosen; it never picks one.
- **Shown.** The lane running the job shows its resolved work tree (`job.workTree`, issue #166) beside
  the machine; a refusal names the work tree and the machine.

**Verification:** `test/herdr/executor-machine.test.ts` (the order: the machine's over the source's and
the executor's, the job's own over the machine's, the machine's resolved on it, a machine work tree that
is its home failing before any tab), `test/herdr/payload-default-cwd.test.ts`,
`test/sources/github-discover.test.ts` (`cwd` only from `repoPaths`), `test/routing/rules.test.ts`,
`test/integration/routing.test.ts` (a rule's work tree on the job and in `routedBy`),
`test/plugins/machine-targets.test.ts`, `test/adapters/ssh-machine.test.ts`,
`test/adapters/machine-usage.test.ts`, `test/ui/routing.test.ts`.


## Every setting applies without a restart (issue #356, 2026-10-07)

Owner request: every setting saved in the UI applies without restarting the hopper; a running job is
never ended by a config save; `restart pending` goes, or stays only for what truly cannot change in a
running process, listed here. In a container deployment a restart recreates the process and can end
running jobs' panes (issue #350), so a restart is no way to apply a setting.

**As built:**
- **No restart role is left.** The job sources, usage sources and notifiers follow the plugins config
  live, as the executors (issue #142) and machine sources (issue #18) already did: `followSpecs`
  (`src/plugins/source-slots.ts`) keeps each unchanged instance (same spec), builds a new or changed one,
  and retires what the config no longer names. `RestartRoleStatus` and its `pending` are gone:
  `/api/plugins` `jobSources`, `usageSources` and `notifiers` are `{ instances }`, like `executors`.
- **Job sources.** The host tells the user runtime of each change (`jobSourcesChanged`); the sync loop
  takes the sources as they are now (`SourceSync.setSources`, `src/sources/sync-slots.ts`). A new source
  is synced at once. A changed one (same name, new instance — its `defaultCwd`, `repoPaths`,
  `completion`, authors, …) takes over the slot: its counts and its jobs are kept, and from its next sync
  it pulls, checks and reports through the new instance. Options read at intake (`defaultCwd`,
  `repoPaths`, `model`, priority) apply to the next job, and to a waiting job that has not started on
  the next sync (issue #375). Completion
  is judged when a job ends, so a running job is judged by the source as it is then. A removed source
  pulls nothing more: it stays, paused as `removed from the plugins config`, checks and reports its own
  jobs until each has ended and its end is reported, then goes. No job is cancelled or failed for it.
  The engine asks the sync loop for a job's source (`notComplete`, `credentials`), so a removed source
  still answers for its own running jobs.
- **Usage sources.** The engine reads the host's usage sources at each Decision and each usage read
  (`EngineContext.usage` is a function). A removed or replaced instance is stopped (its `stop()`).
- **Notifiers.** One built after the event feed started is started with that feed at once; one no
  longer named, or replaced, is stopped (its `stop()` settles in-flight work). After the notifiers are
  stopped at shutdown, a change starts none.
- **Running jobs are not interrupted.** No plugins edit ends a job: executors and machines already
  refused removal while a job needs them (issues #142, #18); a job source, usage source or notifier change
  never touches a job.
- **The UI says when.** A save answers once the change is in place; the toast says `applied at <time>`,
  and Settings → Plugins shows `applied <time>` (`config.loadedAt`). The `changed — restart pending` badge
  and the per-instance `restart pending` state are gone; an instance not built yet shows `applying`.

**What is live elsewhere** (each with its own test): escalation levels, the router and the queue sorter
(swapped between calls), executors (issue #142), machines (issue #18), routing rules (read at each
intake), job rules (read at each job start), the rules file of the question gates (read per question),
webhook subscriptions (rows read per delivery), sign-in and realms (loaded before they are stored).

**What still needs a restart** — none of it is a setting saved in the UI:
- the process environment: `HOPPER_PORT` and the listen address, `HOPPER_LAN_PEERS`, the public URL,
  `HOPPER_DATABASE_URL`, `HOPPER_WORK_DIR`, `HOPPER_PLUGIN_DIR` and every other `HOPPER_*` variable
  (`src/config.ts`), and secrets a deployment mounts at start;
- new code: a plugin from the plugin store reinstalled over one already loaded keeps its first code
  until restart (`restartPending` in the plugin store's report; Node caches imports), and an update of
  the hopper itself ("Self-update"). An update that keeps running jobs running in a container deployment
  is out of scope here.

**Verification:** `test/integration/live-settings.test.ts` (a job source switched on in the UI pulls the
next job; an options change applies to the next one; a usage source changed and removed; a notifier added
tells of the next human question; job sources, usage sources and notifiers changed around a running job,
which keeps running), `test/sources/sync-live.test.ts`, `test/plugins/host-sources.test.ts`,
`test/plugins/host-usage-live.test.ts`, `test/plugins/host-notifiers.test.ts`, `test/ui/plugins.test.ts`;
the other settings: `test/integration/escalation-levels-edit.test.ts`, `executors.test.ts`,
`machines-edit.test.ts`, `routing.test.ts`, `job-rules.test.ts`, `question-gates.test.ts`,
`webhooks-edit.test.ts`, `realms-edit.test.ts`.

## One way to GitHub as the user: the connected account (issue #359, 2026-10-07)

Owner decision: the hopper reads GitHub as the user only through the GitHub account of the signed-in
user, the **connected account** (#214) — connected at GitHub sign-in or from Sources → Connect GitHub.
Two ways to GitHub stay: that connection, and an admin's own GitHub App (`github-app`, posting as its
bot, unchanged).

**Removed, no compatibility path:**
- the `github-gh` job source (the gh CLI as the owner; the built-in instance `github` with `enabled: auto`;
  its options `owners`, `bin`, `appKeyEnv`; its pause while a GitHub account was connected or a GitHub App
  key was set; its search over `owners`);
- gh login from the UI (#138: the Sources panel, `GET /api/gh-login`, `POST /ui/api/gh-login`, the
  `GhLogin` port);
- gh and its git credential helper in the image: the container is not a machine (#141), jobs run on
  attached machines, which may still have gh for a job's own use;
- `whoami` and `searchOpenIssues` on the `GitHubApi` port: discovery never searches. It lists the app's
  installed repos or the account's job repositories (#321), repo by repo.

**As built:**
- **Built-in job sources** of a fresh hopper: `{ name: 'github-account', plugin: 'github-account' }` only
  (`builtinInstances`).
- **A job's GitHub token** for its own git or gh use comes from that same connection (`GH_TOKEN`, as jobs
  of the connected account already got it, #214).
- **No connection, no fallback.** Not connected: the `github-account` source is paused with `GitHub is
  not connected: Sources → Connect GitHub`. Its sign-in ended (issue #358: the token expired with nothing
  to renew it, or GitHub refused the renewal): `ConnectedAccountStatus` reads `expired`, the source is
  paused with `GitHub's sign-in expired: Sources → Connect GitHub again`, and the Sources GitHub panel
  shows **sign-in expired** and **Connect GitHub again** (the device flow). Before issue #359 an expired
  account let the gh source run again; now nothing falls back to another credential.
- **Sources** has one GitHub section: the connected account's panel with its source's sync, and beside
  it an admin's `github-app` where one is set up. No gh card, no gh login panel.
- **Migration** (tenant 14, `src/store/migration-no-gh-source.ts`): every `github-gh` instance leaves the
  plugins config's `jobSources`; the `repos` of the first one become the user's job repositories when none
  are chosen yet; a config left without a `github-account` instance gets one. Every other instance stays.

**Kept:** per-user CLI config dirs (`GH_CONFIG_DIR`, `CLAUDE_CONFIG_DIR` for a user added later, "User
runtime"); gh on machines and agent boxes for a job's own use.

**Verification:** `test/integration/github-connection.test.ts` (not connected and expired: paused with
the message, no job, no other credential), `test/store/tenant-migration-14.test.ts`,
`test/plugins/builtin-instances.test.ts`, `test/sources/github-discover.test.ts` (no search),
`test/ui/sources.test.ts`, `test/ui/sources-view.test.ts`.

## Usage history (issue #385, 2026-10-07)

Owner request: a usage-over-time graph on the Overview, and usage history recorded so it has data. Before,
a usage source reported its current reading only; nothing was kept.

**Recording.** Each user runtime runs a **recorder** (`src/usage/history.ts`): every minute it polls every
usage source of the user — the live set (issue #356) — and keeps each reading as a **usage sample** in the
user schema (tenant migration 15, `usage_samples`: `at` as `TIMESTAMPTZ`, source, machine, usage window,
used, limit, unit, `resetsAt`, informational, account identity; unique per source, machine, usage window
and `at`). A source answers `poll` from its last read until it reads again, so the uniqueness keeps one
sample per read: samples arrive at each source's own poll interval, whatever the recorder's minute. A
failing, offline or stale source returns no readings and adds nothing. Recording starts when the runtime
starts, independent of the graph. The fold of a user into another (#265) moves the samples like any table.

**History retention.** The user setting `historyRetentionDays` (default 90, 1-3650), set from the Usage
view (`POST /ui/api/usage-history/retention`, admin). The recorder prunes past it every hour; the route
prunes at once. Pruned, not downsampled: at a 10-minute read, four accounts of three windows for 90 days
are about 160 000 rows, which the step queries aggregate in SQL.

**The usage graph** (`GET /api/usage/history`, a tenant read). The **graph range** (a preset ending now —
`24h`, `3d`, `7d`, `30d` — or a custom `from`–`to`) and the **graph step** (`15m`, `1h`, `6h`, `1d`, `1w`)
are asked in the query or, absent, are the user's saved **usage graph view** (`usageGraphView` setting,
default `7d` per `1h`; `POST /ui/api/usage-history/view`, any role: it is the viewer's own choice). `tz`
(minutes east of UTC) puts day and week steps at the viewer's midnight, weeks from Monday. The store
answers per line (source, machine, usage window):
- **points**: per graph step (`date_bin`), the highest share of the limit used in it (`used / limit`, so
  every unit plots on one 0-100% axis). The peak, not the mean: a budget is about how close it came.
- **gaps**: stretches with no sample longer than 3 × the line's usual spacing (median, at least 5 min) —
  the same 3 intervals after which `polled.ts` calls a reading stale. The UI breaks a line between two
  points only where a gap lies between them; empty steps without a gap (a source reading less often than
  the step) join, so a slow source is not drawn as broken.
- **resets**: where a sample's `resetsAt` is later than the previous sample's by more than a minute, at the
  earlier `resetsAt`: the moment the window rolled over. A drop to 0 then reads as a reset, not lost data.
- **account**: the identity of the newest sample's account in the range.

**UI.** The overview panel *Usage over time* (`usageHistory`, full row, after Usage;
`ui/src/views/overview/usage-history.tsx` over `ui/src/components/usage-graph-card.tsx`,
`ui/src/charts/usage-history.tsx`, model `ui/src/model/usage-history.ts`). One line per series, drawn as
the KPI cards' sparklines (monotone 1.5 px stroke over a gradient fill fading down). The legend names each
line `<account> · <window>` (no account: the source, and its machine); the lines of one account share a
colour; session solid, week dashed, informational dotted and hidden until shown — four accounts show eight
lines. Clicking a legend entry toggles its line (per page view). Hover: a rule and every shown line's value
in that step. Range tabs and a step select apply at once and are saved for the user.

**Privacy (issues #221, #241).** The samples live in the user schema; `GET /api/usage/history` reads the
request's user only. The instance admin reads `GET /api/instance/usage-history`: each user's lines summed
per unit, usage window and graph step (summed used over summed limit, and how many lines each point sums),
nothing named — no account, source, machine or user. Shown in Settings → Users beside the instance
totals. The few-users residual risk of "What an admin sees" applies to it as to the totals.

**Live (issue #356).** The retention is read at every prune; the view at every read. Nothing restarts.

**Verification:** `test/store/usage-history.test.ts` (once per read, per-step peak, gaps, resets, range,
prune, settings), `test/integration/usage-history.test.ts` (default 7 days per hour, query vs saved view,
a viewer saves their view and cannot set the retention, retention prunes at once, survives a restart,
per-user privacy, instance totals with nothing named), `test/ui/usage-history.test.ts` (eight lines for
four accounts, colour per account, dash per window, gaps, hover, legend, totals as lines).

## Usage graph: one series per account, zoomable, live (issue #502, 2026-10-08)

Owner request: one graph of usage over time for every account, combined across every machine, a week by
default at a coarse step, zoomable down to hourly, live. Supersedes, in "Usage history" above, the line per
source and machine, the step select and custom range, the `7d` per `1h` default, and the 60 s poll as the only refresh.

**One line per account and usage window.** The store names each sample's account (`acct`): the identity it
was read for; else the newest identity its source and machine named in the range (read before the source
knew it); else the source's name (a source that never names its account stays its own line). Every reading
of one account — whichever machine and claude-plan instance read it — makes one line per usage window and
unit: per graph step the highest share of the limit used, not the sum, because two machines on one plan read
the same quota. A gap is a stretch where no machine read the account (the spacing is over the account's
merged samples); a reset is found per source and machine, then named once per account and minute.
`UsageSeries` carries `account` and no `source` or `machineId`; the legend names `<account> · <window>`, never a
machine. The instance totals sum per account too, so an account on two machines counts once.

**Open points, decided in the job.** Windows: kept both, a solid session and dashed week line per account in
one colour (informational dotted, hidden until shown), so a per-window throttle stays visible. Whose accounts:
each user sees their own (privacy of #221/#241 unchanged); the admin's summed graph in Settings → Users stays.
Grain: per day at the week. Controls: the range presets stay (the saved choice); the step select and the custom
range are gone, replaced by zoom.

**The graph step follows the stretch** (`graphStepFor`, `src/domain/usage-history.ts`): an hour up to 2 days, 6
hours up to 4, a day up to 60, else a week. The query takes `range` or `from`/`to`, no `step`. The saved view is
`{ range }`; the store still writes the step that range gets beside it, because the build before reads it ("A
migration leaves a store the build before it still runs on"), and reads a record of the build before as its range.

**Zoom** (UI only, per page view, never saved): buttons (×½, ×2 about the middle), a pinch, Ctrl/⌘ + scroll (a
trackpad pinch; a plain scroll stays the page's), and a drag across a stretch (mouse or one finger; the graph is
`touch-action: pan-y`, so a vertical swipe still scrolls). A pinch or a scroll draws its stretch at once and reads
the history once it ends (`ui/src/hooks/use-graph-zoom.ts`). Limits (`zoomed`, `selected`, `ui/src/model/usage-history.ts`):
at least 3 hours, never past now, never wider than the history retention. Reset returns to the saved range. Points
sit at the middle of their step and the lines are clipped to the plot.

**Live.** The recorder tells listeners how many samples a record kept; the SSE stream sends `usage.recorded`
(`{ added }`, no id) to that user's stream, and both graphs read again on it. The 60 s poll stays for the
admin's totals (other users' samples) and a dropped stream.

**Verification:** `test/store/usage-history.test.ts` (two machines one series, the higher reading; a sample
before the account was known; gaps only where no machine read; one reset across machines; gaps and resets the
same at every step; totals count an account once; the saved view and the build before's record),
`test/integration/usage-history.test.ts` (default a week per day; the step for each stretch; `usage.recorded` on
the stream), `test/ui/usage-history.test.ts` (lines per account, the step for a range, zoom in to hourly and back
to the week, the time under the pointer kept, limits, a drag; segments broken at every step).

## Intake by label and assignee; reject as the user's own record (issue #387, 2026-10-07)

Owner direction: anyone can file an issue, and filing it must not decide whether it runs. Supersedes every
statement above that an issue's **author** decides intake ("Authors outside the allowlist are never acted
on", the eligibility line of "Discovery", the `authors` option in every config example). The design study
behind it, with the owner decisions it leaves open, is `docs/assignment.md` (issue #388).

**Intake.** A user's GitHub source takes an issue when it is open, carries the source label, and is
**assigned** to the user's connected GitHub account (`isAssignedTo`, logins compared without case) — every
other rule of "Discovery" stands (`hopper:done` / `hopper:failed` / `hopper:backburner` / `hopper:rejected`,
`hopper@<name>`, claimed without a local job). Who filed it does not matter. `github-account` matches the
login it acts as; `github-app` matches the user's connected GitHub account too (a bot cannot be assigned),
and is paused while none is connected (`NO_ASSIGNEE`). The assignee is read at every sync, so connecting
or changing the account applies at once (#356). A job records the login it was taken for
(`JobSourceRef.assignee`); jobs taken before have none.

**`authors` is gone** from both GitHub sources: the schema, the Plugins form, `describe()` (it shows
`assignee` instead), and the bot check. An instance still carrying `authors` loads with it dropped
(`withoutAuthors`); tenant migration 16 (`src/store/migration-no-authors.ts`) removes it from the stored
plugins config.

**Comments in the job's context** are the assignee's own, never the app bot's or a hopper-marked one
(`contextComments`; header `only the assignee's, …`). Nothing on an issue answers a question — questions
are answered in the UI — so no allowlist decides answers.

**Reject.** `POST /ui/api/jobs/:id/reject` takes an optional `{ reason }` (≤ 500 characters): the job ends
`rejected` with it as its error and in `job.rejected` (none: `rejected by the user`). Offered on every
waiting job in the Queue view and in the Overview's Waiting list, in a dialog with the reason field. On
GitHub the rejection writes nothing: the claim label goes, no `hopper:rejected`, no comment, never a close
and no unassignment (D1 and D9 of `docs/assignment.md` are open). A shared label would turn the issue away
for every user and every hopper on the repo. Instead the source asks the host which items' newest job was
rejected (`JobSourceContext.rejections`: when, and for which assignee) and skips such an issue until its
newest `assigned` event for that login is later than the rejection (`GitHubApi.assignedAt`, one events
read per rejected issue per sync); such an issue shows `rejected by you: not taken until assigned to you again` in the source's intake outcomes (issue #440).
**Run again** now takes a rejected job too: the issue is queued at once. A rejection recorded before this
change (no assignee) leaves the issue to its `hopper:rejected` label, as before: removing it offers the
issue again.

**Unassignment** (`check()`, `assignmentDrift`), for jobs with an assignee only:

| the issue is no longer assigned to the job's account | |
|---|---|
| job waiting (queued, held, awaiting acceptance) | cancelled, reason `unassigned`: it leaves the queue |
| job started (claimed, running, on a question, operator-led) | runs on, **flagged**: signal `unassigned` → `sourceState.sync.unassignedAt`, `job.unassigned { assignee }` once. The UI shows "No longer assigned to you on GitHub. Stop it, or let it finish." on the job's lane or row, beside its stop button |
| a flagged job's issue assigned to it again | signal `reassigned` → the flag is cleared, `job.reassigned { assignee }` |

A job taken before this change (no assignee) is never cancelled or flagged for having none: in-flight
work survives the update. The label rules are unchanged (label removed still cancels, D3 open).

**Not built here** (follow-ups of `docs/assignment.md`): the author trust gate, comment context by repo
permission, one claim per issue across users of one hopper, unassign on reject, dismissing a locked entry on
unassignment, intake reasons for every skipped issue, `job.needs_decision`.

**Verification:** `test/integration/github-assignment.test.ts` (the acceptance: any author, assigned →
a job on the next sync; unassigned or unlabelled → none; reject with and without a reason, not taken again
until reassigned, Run again; unassigned while waiting and while running), `test/sources/github-discover.test.ts`,
`test/sources/github-check.test.ts`, `test/sources/github-context.test.ts`, `test/sources/github-app.test.ts`,
`test/sources/config.test.ts`, `test/store/tenant-migration-16.test.ts`, `test/ui/assignment.test.ts`,
`test/ui/ended-rerun.test.ts`.

## Operator actions from the CLI (issue #374, 2026-10-07)

A script or assistant acting for the user read everything through `GET /api/*`, but every operator action
needed a UI session, so it either scripted a human sign-in or wrote rows behind the daemon's back. The
issue offered two ways: a scoped API token that may mutate, or CLI commands. The CLI is taken. A
mutating token would be a second door beside the UI session, against the rule that every mutation is
`POST /ui/api/*` behind one (AGENTS.md); the API door stays reads only ("The API door"). The CLI already
holds the database's credentials, the daemon's own trust, so acting from it widens nothing.

- **Commands** (`src/cli-operator.ts`): `hopper job accept|reject|rerun <id>` (`reject --reason <text>`),
  `hopper queue order <id>...`, `hopper queue gate <auto-accept|review> [--per-hour <n>|none]` (without
  `--per-hour` the throttle stays), `hopper question list [--reason <reason>]` (issue #679: the open questions, each with why it came to a person), `hopper question answer <id> <text>`, `hopper question close|dismiss <id>`.
  `--user <id>` as on `config` (default the one user). Each prints the daemon's answer as JSON.
- **Through the daemon, never around it.** Each command is the UI's own route on the running daemon, so its
  checks, its events (`job.accepted` by `user`, `queue.gate_changed`, `question.answered` by `human`, …) and
  its runtime (the source told; an answer typed into a waiting pane) are the click's. Accept is the Queue
  view's Accept: the accepted waiting jobs in queue order, then the job, posted as the user order.
- **The session.** The CLI mints a UI session in the database (`ui_sessions`, only the token's hash stored)
  for the one call, with the least role the route names (operator; admin for the queue gate), and drops it
  after, whatever the answer. It lives five minutes at most. Its identity's realm is `cli`, which no sign-in
  config names, so a reconcile drops a leftover.
- **Where.** `--url`, else `HOPPER_URL`, else `http://127.0.0.1:<HOPPER_PORT, default 4790>`; the `Origin` sent
  is the URL's own, so it passes the guard as the UI on that origin does. Inside the container the default
  reaches the daemon.
- **Answers.** The daemon's 4xx is a refusal: its message, exit 2. No daemon at the URL, or a 5xx: exit 1.

**Residual risk, stated.** Whoever can run the CLI with the database's credentials can act as any user; that
was already true of `config set` and of the database itself.

**Not built.** A mutating API token (see above); cancel, approve, operator-led and dismiss of a locked entry
from the CLI — no caller yet.

## Failures from the operator CLI (issue #623, 2026-10-10)

A false recurring problem held new jobs, and only a signed-in UI session could release it or close a hand-off.
An operator or an assistant on the host could not unblock the queue. The Failures actions are now operator CLI
commands, on the same footing as issue #374's.

- **Commands** (`src/cli-operator.ts`):
  - `hopper problem list` (the open problems), `release <id>`, `resolve <id> [--note <text>]`;
  - `hopper handoff list` (the open hand-offs), `continue <id> [--note]`, `fixed <id> [--note]`,
    `done-by-hand <id> [--note] [--link <url>]`, `wont-do <id> --note <why>`;
  - `hopper failure list` (the open failures), `retry <id>`;
  - issue #637: `hopper prs` (the Pull requests list, `GET /api/pull-requests`), `hopper yolo <owner/repo> on|off|default`
    (admin; `POST /ui/api/yolo-mode` with `repos`) and `hopper backfill done-check` (`POST /ui/api/backfill/done-check`).
    `--json` is taken by every command and changes nothing: the answer is JSON.
  A list is `GET /api/failures`, narrowed; each other command is the UI's own `POST /ui/api/failures/*`. The
  verbs are the glossary's words: the issue asked for `settle`, `done`, `run-again` and `clear`, but `settle` would
  be a second word for resolve and `clear` already names the `cleared` end of a hand-off.
- **One path.** The UI and the CLI call the same route and the same `Failures` method, so the events, the
  write-back to the source (the one comment and the end label on GitHub) and the runs again are the same.
- **No new door.** The API keeps one way to mutate: a UI session. The CLI mints one in the database for the call
  (issue #374), so the operator's credential is the database's. A mutating operator token or an operator socket
  would be a second door; neither is built.
- **Who acted** (the **acting person**). Each person's action on Failures keeps who and the way in its event:
  `person` (the session's identity name; `operator CLI` for the CLI) and `via` (`ui`, or `cli` when the session's
  realm is `cli`). On `failure.resolved` (with the `note`), the new `failure.released`, `handoff.closed` (and
  `via` on the hand-off's resolution) and `job.rerun` (a failure's Retry, a hand-off's Run again or Continue in a
  new job). Additive fields: the event versions stay. The check's resolution and the assessor's runs again carry
  none.
- **A note on a problem.** `POST /ui/api/failures/problems/:id/resolve` takes an optional `{ note }`, kept in
  `failure.resolved`; the UI sends none.

**Not built.** A `failure dismiss`: the UI has no such action on a failure record. A failure ends when its job
runs again, its hand-off is resolved (`handoff wont-do` ends it with no more work), or its job finishes.

Tests: `test/integration/operator-cli.test.ts`.

## Reserved lanes (issue #372, 2026-10-07)

Reported: every lane of a machine was taken by jobs that could run on any machine, while a job a
routing rule had pinned to it (work only that machine can do) waited for one to free. With long jobs it
would wait hours while other machines had free lanes. Nothing in placement kept room for the jobs that
can only run there.

Three ways were offered: a per-machine count of reserved lanes, a placement rule that sends unpinned
jobs elsewhere while pinned demand exists, or requeueing an unpinned job off the machine. Built the
first: it is the smallest, it is per machine, and it needs no job moved once placed. The second would
make one job's placement read every other job's pin; the third would stop work already begun.

**As built:**
- **`reservedLanes`**, an optional option of every machine-source plugin (`local`, `ssh`, `docker`,
  `client`; a whole number ≥ 0, not command-bearing), reaches the decider on
  `MachineSnapshot.reservedLanes`. Edited in the Plugins view's options form like any machine option;
  the machine's card in the Machines view says how many it keeps.
- **The decider (step 7).** A job is pinned to a machine when `pinOf(job)` names it (its
  `spec.machineId`, or for a resuming job the machine holding its pane). A job not pinned to `m` may
  take a lane there only while `unpinned(m) < max(0, cap(m) - reservedLanes(m))`, where `unpinned(m)`
  counts the lanes busy or draining with jobs not pinned to `m` — a lane whose job is not among the
  inputs counts as unpinned, so the reserve stays free — plus this Decision's starts of such jobs.
  Pinned jobs may use every lane. The room an unpinned job sees on `m` is that smaller figure, so it
  goes to a machine with more room for it first. It counts against the **lane cap**, not `maxLanes`:
  past a usage soft limit the reserve stays whole and unpinned jobs give way first.
- **At or above the cap**, only jobs pinned to the machine run there.
- **Wait reason.** An unpinned job with room on its machine save the reserved lanes waits with
  `waiting for a lane: machine m keeps R of its N lanes for jobs pinned to it, the other K are in use`.
- A running job is never moved: the reserve applies to new starts. Absent or 0, placement is as before.

**Verification:** `test/decider/reserved.test.ts` (cap less the reserve, the wait reason, a pinned job
takes a reserved lane, pinned jobs use every lane, pinned lanes do not count against unpinned ones,
unpinned jobs go elsewhere first, a reserve at the cap), `test/plugins/machine-targets.test.ts`,
`test/plugins/host-sources.test.ts`, `test/adapters/ssh-machine.test.ts`,
`test/adapters/machine-usage.test.ts`, `test/ui/machines.test.ts` (`reservedText`).

## Leak prevention: scope, sweep, shared dependencies (issue #410, 2026-10-08)

Follow-up to issue #401. Owner request: reap a job by its process scope, not only by its environment;
reap after a crash; give job worktrees shared dependencies; reap print-agent jobs; hold new claims on a
low disk; every threshold a setting that applies without a restart.

**As built** (each part in "Work tree" and "A machine's disk"):
- **The job's scope**: a herdr-claude pane shell, and each print-agent turn, runs in the transient systemd
  user scope `hopper-job-<job id>` where the machine has a user manager; the reap stops it.
- **The reap through the machine's connection**: this machine, ssh, or a client target's `POST /reap`;
  never keys to a pane. A job whose pane is gone is still reaped.
- **The sweep**: at startup after recovery, then on each machine every `reapEveryMinutes` (default 10), the
  scopes and processes of known jobs that are not live are stopped, and an ended job's scratch dir is
  removed once `scratchMaxAgeHours` old (default 24), or at once while its work was kept and is now pushed
  (`job.work_removed`).
- **Shared dependencies**: a job worktree's `node_modules` links to the dependencies installed once per
  lockfile in `<work tree>/.hopper-scratch/deps/<hash>` (herdr-claude option `sharedDependencies`).
- **Print agents**: their own scratch dir, a scope per turn, the reap at the end.
- **A low disk holds new claims** on that machine, by its `diskLowBelowGiB` / `diskLowBelowPercent`.

**Settings, live**: `reapEveryMinutes`, `scratchMaxAgeHours`, `diskLowBelowGiB`, `diskLowBelowPercent` are
plain options of the `local`, `ssh` and `client` machine sources, read at every list or sweep;
`sharedDependencies` an option of herdr-claude, read when a job starts. Machines and executors follow the
plugins config live ("Every setting applies without a restart").

**Not done, by choice**: a worktree per issue reused across runs (`worktrees/<repo>-<issue>`, branch
`hopper/<issue>`), as the issue sketched: issue #379 (merged first) gives each job its own worktree in its
scratch dir, which the reap and the sweep already own; reuse across runs would need a second lifetime for
it. A Windows client has no `sh`: its reap and survey answer an error and the job is left to its pane's
close, as before.

**Verification:** `test/client/reap.test.ts` (the reap and the survey for real: a scope stopped with a
process that cleared its environment and left its session, where systemd runs; a `node_modules` link no
work of the job's), `test/client/machine-shell.test.ts` (this machine and a real client target's `/reap` and
`/survey`, refusals, 401), `test/herdr/executor-scope.test.ts`, `test/herdr/executor-resume.test.ts`
(the reap never through the pane; a pane gone), `test/herdr/shared-deps.test.ts` (for real with a stand-in
npm: four jobs at once, one install), `test/herdr/executor-job-worktree.test.ts`,
`test/adapters/print-agent-executors.test.ts` (a print-agent job leaves nothing behind),
`test/engine/sweep.test.ts`, `test/integration/sweep-restart.test.ts` (a hopper stopped mid-job and
started again: the job's leftover process stopped, a stranger's not), `test/decider/disk-low.test.ts`,
`test/plugins/machine-targets.test.ts`.

## Intake outcomes, claim holders and the intake migration (issue #440, 2026-10-08)

Owner report: one job ran where a full queue was expected. Dispatch was not the cause: of 16 open labelled
issues, 14 were on the backburner and one had a stale claim and no assignee — and intake said nothing about
any of them. Owner decisions (2026-10-08): M1 (c), M2 holder label + own stale claims released + legacy
claims released once by the migration + one-click release, M3 leave the labels and show the reason, M4 keep
the job repositories and suggest the others, M5 nothing to do (tenant migration 16 already removed
`authors`, so no trusted accounts can be seeded from it).

**As built:**
- **Intake outcomes.** `discoverIssues` gives every open labelled issue it lists one outcome (`IntakeOutcome`,
  `src/domain/intake.ts`): taken, or one reason — `done, but the issue is still open`, `failed: …`,
  `rejected: …`, `on the backburner`, `addressed to another hopper`, `not assigned to you` (action `assign`),
  `claimed by another hopper` / `… (no holder recorded)` (action `release`), `claimed by another user of this
  hopper`, `claimed with no job here (stale); releasing it failed: …`, `rejected by you: …`. The first
  matching reason wins, in that order. `JobSource.intake()` answers them; the sync loop adds each taken
  issue's `jobId` and puts the list in `SourceStatus.detail.intake` (none while paused). Sources lists them,
  not-taken first, with **Assign to me**, **Assign all to me** and **Release claim**
  (`POST /ui/api/sources/:name/intake { kind, keys }`, operator; only on items the last sync offered that
  action for; the source syncs at once).
- **Claim holders.** A claim adds `hopper:held-by:<id>` beside `hopper:claimed`; the end of the job, a
  cancel, a rejection and Run again remove both. The id is the user's **claim holder** id: 12 random hex
  characters made on first use (`UserSettingsRepository.claimHolder`), naming no person or machine. A claimed
  issue with no local job: this user's own holder label → stale, released (`source.claim_released`,
  `by: hopper`) and taken in the same sync; another holder → respected (or, when another user of this hopper
  has a job for it — `UserRuntimeOptions.otherUsersKnow` — `claimed by another user of this hopper`, no
  release offered). A new install has a new id, so its predecessor's claims read as another hopper's: the
  user releases them in Sources.
- **The intake migration.** Once per source (`intakeMigration:<source>` in the user's settings), on the first
  sync that lists every repo of its scope: a claim with no holder label and no job in any user of this hopper
  is released (`by: migration`); labelled issues not assigned to the user are listed. The record
  (`detail.intakeMigration`) and `source.intake_migrated { changes }` say what it did; a second run is a
  no-op, across restarts. Nothing to restart: it runs on the first sync of the updated daemon.
- **Repos outside the job repositories.** A connected account's source lists `GET /issues?filter=assigned`
  (one listing, not a search, at most every 10 minutes, `OUTSIDE_EVERY_MS`) and shows the repos outside its
  job repositories with issues it would take there (`detail.outsideRepos`). Sources offers **Add to job
  repositories** (the existing `choose`, admin). Never added by itself; the no-search rule of issue #321
  stands for intake. The app source has no user to list for, so it shows none.
- **Why a lane is idle.** Each Decision's lane plan carries `idle` when the machine leaves lanes unused
  (`idleReason`, `src/decider/lanes.ts`): its lane count is 0, offline, home not known, disk low, usage pacing
  (lane cap below its lanes), reserved lanes, waiting jobs that cannot run there, every waiting job held (the
  queue gate is `awaiting acceptance`), or no job waiting. The Overview's idle lanes and empty lane slots show
  it. A waiting job already said why (`holdReason`, `waitReason`). `decision.made` v3 gains the optional
  field; v1 and v2 keep their old lane plan (`legacyLanePlan`).
- **GitHub writes.** Assign to me is the second kind of issue write besides labels and Run again's reopen; it
  is the user's act from Sources, never the hopper's own.

## Per-machine work trees (issue #361, 2026-10-08)

Owner request: jobs failed when routed to a machine that did not have the configured work tree — four
jobs went to an agent box while the host's lanes were full, carried the host-only path the GitHub source
set, and failed the scratch check within seconds. Each machine has its own work tree, set in the UI; the
hopper provisions it on the machine itself (directory, the job's repository, scratch, trust) with no
manual setup; a path valid on one machine never reaches another; the router never picks a machine whose
work tree cannot be made usable — the job stays queued, with why, never failed; ephemeral agent boxes
work the same way. Configured on the machine, as the issue recommended: the work tree belongs to the
machine; a routing rule may still override it per repository, on the machine it names. The issue's word
"workspace" is the glossary's **machine work tree** (herdr's own workspaces are something else).

**As built:**
- **The work tree is the machine's.** `resolvePayload` (`src/executors/herdr/payload.ts`, herdr-claude
  and the print agents): the job's own `cwd` — only a routing rule's, which pins the job to the rule's
  machine — applies only on the machine the job is pinned to (`spec.machineId`); anywhere else the
  lane's machine's `workTree`; absent, the jobs directory. No other path exists: the GitHub sources'
  `repoPaths` and `defaultCwd` and the herdr-claude and print agent executors' `cwd` are gone
  (`SourceItem.cwd`/`defaultCwd` and `SpecFromConfig.defaultCwd` too), because none of them names a
  machine. A routing rule's `workTree` without `machine` is refused (`src/routing/`, and the Routing view
  says so first).
- **Set in the Machines view.** An attached machine's Edit form has a `work tree` field (ssh and client
  targets; a container target runs commands only and has none), this machine's Edit form too; empty
  removes the option. The machine panel shows the work tree (the jobs directory when none is set) and
  its work tree problem.
- **Made on the machine when it is probed.** The probe that finds a machine online (at attach, then
  every 30 s) makes its work tree there and says what is wrong — `MachineSnapshot.workTreeProblem`:
  - this machine: `createLocalMachineSource` makes it in the background (`src/client/work-tree.ts`
    `makeWorkTree`: `mkdir -p`, writable, never the home or above it), at most once per 30 s;
  - an ssh target (an agent box is one): in the same ssh call that asks its home and its disk
    (`probeSsh`), a shell `mkdir -p` and a write check, `~` as `"$HOME"` there; the answer's last line
    says made or not. A box made again from its image, with an empty home, has its work tree again at
    the first probe after attach;
  - a client target running the hopper's client release: `POST /work-tree {workTree}` on its link
    (`src/client/server.ts`, signed like every call), answered `{workTreeProblem?}`. The call is in a new
    client file (`work-tree.ts`), so the release id changes and the release keeper loads it onto every
    client first; a client on another release is not asked.
  A probe that cannot run the check (the client call fails) reports that as the problem.
- **Never routed there.** The decider (`src/decider/assign.ts`, `workTreeHolds`) takes a machine with a
  work tree problem for no new job, as a machine whose disk is low. A job no other machine can take is
  held — `no machine running executor <x> has a usable work tree: <m>: <problem>`, or `pinned machine
  <m>: <problem>` — and starts once a probe finds the work tree usable or another machine has room; a job
  that waits for the other machines' lanes says that. A job already running there keeps its lane, and a
  job resuming there returns to its pane. The hold reason is the job's `holdReason`, shown in the UI;
  the attached machine's log line says it takes no new job and why.
- **The repository, at each start** (`src/executors/herdr/job-worktree.ts`). A work tree that is the top
  of a git repository — a checkout the owner keeps, as before — is used as it is: no clone is put in it,
  and each job gets its own worktree of it ("Each job its own git worktree"). Any other work tree (the
  jobs directory, a fresh box's) gets the job's repository when the job has one (a GitHub issue's,
  `job.source.repo`): the job worktree command fetches the **checkout** `<work tree>/<name>`, whose
  `origin` must be that repository, or clones it there from `https://github.com/<owner/name>.git` the
  first time (into `<name>.hopper-clone-<pid>`, then moved in, so two jobs cloning at once leave one),
  and makes the job's worktree of it, `<work tree>/.hopper-scratch/<job id>/<name>`. Git takes github.com
  credentials from `GH_TOKEN` when the pane has it, else from `gh auth git-credential` (the job's
  credentials dir, issue #441), through `GIT_CONFIG_*` variables naming a helper: the token is never on
  a command line. `GIT_TERMINAL_PROMPT=0`: git never waits for a person. A checkout of another
  repository under that name, or a refused clone, fails the job at once with what git said. With
  `jobWorktrees` off, the checkout is fetched or cloned and the job runs in the work tree. The print
  agents run the same command, worktrees off, before their first turn, its output on stderr.
- **Scratch and trust.** The scratch dir is made first, as before; the machine's work tree is made by the
  scratch command too (`mkdir -p`), a routing rule's never. Claude's folder-trust dialog for the job
  worktree is accepted at startup (`trustWorkdir`, default on) — on a fresh box too; no trust is written
  into any file of Claude's, which running Claude processes also write.
- **Migration.** Tenant migration 18 (`src/store/migration-machine-work-trees.ts`): the path jobs fell
  back to (the first job source's `defaultCwd`, else the first work tree executor's `cwd`) becomes the
  `workTree` of each `local`, `ssh` and `client` machine that has none — not when it is the jobs
  directory, the default — so every job runs where it ran before; a `repoPaths` entry that is not that
  path becomes a routing rule `{ name: '<source> <repo>', match: { source, repo }, set: { machine,
  workTree } }` after the existing rules when there is exactly one such machine, else it is dropped; a
  routing rule's `workTree` without a machine gets the one machine there is, else loses the work tree (a
  rule left setting nothing goes); every executor `cwd` and source `repoPaths`/`defaultCwd` goes. Stored
  jobs lose `defaultCwd`, and `cwd` unless a rule set it with the machine the job is pinned to; their
  `fromConfig` follows. A machine that got a path it does not have is then held off by its probe, with
  why, instead of failing jobs: fix its work tree in Machines. The build before runs on the migrated
  store: it reads a machine's `workTree` (issue #324) and defaults the gone options.

**Residual.** A failure at start (a clone refused for credentials, a disk filled since the probe) still
fails that job with what the shell said: the probe checks that the work tree can be made and written,
not that every repository can be cloned there. A work tree a routing rule names is not probed (only the
machine's own is); a missing one fails the job at start, as a misconfigured path should (issue #324).

**Verification:** `test/herdr/machine-work-tree.test.ts` (the machine's work tree, the jobs directory,
a job's own path only on its pinned machine, made wherever it is, the job's repository named to the job
worktree command), `test/herdr/job-worktree.test.ts` (against real git: a clone into a plain work tree
and its job worktree, a fetch of an existing checkout, a checkout of another repository refused, a work
tree that is a repository left without a clone), `test/decider/work-tree.test.ts`,
`test/adapters/ssh-machine.test.ts` (`probeSsh` makes the work tree, the jobs directory by default,
one that cannot be made, the home), `test/adapters/machine-usage.test.ts` (this machine),
`test/adapters/client-transport.test.ts` (the client's `/work-tree`), `test/store/tenant-migration-18.test.ts`,
`test/integration/attached-machines.test.ts` (held with why through the real composition root, then run
once the probe finds it usable), `test/routing/rules.test.ts`, `test/ui/machines.test.ts`,
`test/ui/routing.test.ts`, `test/sources/config.test.ts`.

## Webhook signing secrets (issue #451, 2026-10-08)

Owner request: a webhook subscription's signing secret is made by the hopper's operator for the hopper,
so the hopper stores and manages it, instead of the form naming a runtime variable. Held to current
practice for secrets at rest: a key per value (salted), a master key outside the database (the pepper),
authenticated encryption bound to the value's place, and a key id for rotation.

- **Entered in the UI.** `add` takes `secret` (typed in: 32 to 4096 printable ASCII characters, no
  spaces) or none, and then the hopper makes one (32 random bytes, 64 hex digits). `add` no longer takes
  `secretEnv`, from the UI or anywhere: no route names a variable for a subscription.
- **Encrypted at rest** under the master key ("Sealed in the database"): the subscription id is the
  context. Stored in `webhooks.secret_sealed` with `secret_changed_at` (tenant migration 19). Never in
  clear, never logged (an audit line names the subscription and how it changed: typed in, made by the
  hopper, replaced, rotated), never in an event, never answered.
- **Write-only.** `GET /api/webhooks` and every answer carry `secretChangedAt` only. The actions are
  `replace` (`{ action, name, secret }`) and `rotate` (`{ action, name }`: the hopper makes one).
  A secret the hopper made is answered once, as `generatedSecret`, in the answer to the edit that made
  it; the UI shows it in a box to copy and never puts it in its store. Every answer of the route is
  `cache-control: no-store`. `remove` deletes the row, and the sealed secret with it.
- **Applies without a restart.** The dispatcher opens the stored secret at each delivery (and each test
  event), so a new, replaced or rotated secret signs from the next one (issue #356).
- **Subscriptions from before (M1).** A row with `secret_env` and no stored secret keeps reading that
  variable under the user's secret prefix, exactly as before; its card says "secret from runtime variable
  X: replace to store it in hopper". Storing a secret (replace or rotate) clears `secret_env`: it is no
  longer read, and the variable can be removed from the runtime. Nothing is imported from the runtime on
  its own (M2 not taken): the operator decides when each moves.
- **The key.** The master key of issue #441, not a second one: one runtime value to keep, which the
  compose install and `install.sh` already make. Its derivations are separated by context, so the
  connected account's tokens and the webhook secrets never share a key. Rotation, missing and wrong keys:
  "Sealed in the database".
- **Messages.** `secretProblem` (on `GET /api/webhooks`), a test event's `detail` and a delivery's
  `lastError` say: a runtime variable not set (`WEBHOOK_SECRET_X is not set`), no secret set (`replace
  or rotate it`), or the stored secret cannot be opened (no key: `HOPPER_MASTER_KEY is not set`; another
  key: the key id it was sealed under; altered or moved).
- **One key for every user.** Each user's secrets are in their own schema; the per-user secret prefix is
  no longer needed for a stored secret (it stays for a subscription from before).

Carried, not in this change (the issue's audit, rows 2–10): the Grok Bot routine's URL and key, the
anthropic-api and TypeSafe API keys, the GitHub App's private key, the realms' secrets (sealed and
write-only), client machine keys, the hopper's ssh and link keys, and moving the connected account's
tokens onto the sealer (a key id, so its key can rotate; and never kept in clear without a key).

## Logins (issue #476, 2026-10-08)

A machine or agent that waits on a sign-in — a CLI printing a device code to enter at a URL — is handled
apart from the questions. The action is always the same (open the URL, enter the code before it expires),
so no escalation level can act on it, and a question about it either climbed to nobody or stalled the job
until its timeout. A **login** (glossary) goes to its **login kind**; `device_code` is the first.

- **Raised.** A herdr-claude job ends its turn with `HOPPER_AUTH_PENDING` and the field lines (the
  protocol line in "Phase 2"; marker table there) while the command waits in the background. A print-mode
  run — an agent CLI under the codex, opencode, omp or cursor-agent executor, or an escalation level's
  `claude -p` — is watched as its output comes (`run-output.ts`): a device code a CLI the hopper knows
  prints (`recognise.ts`: gh, codex; each tested on its real output) is reported while the run waits.
  A client target's herdr job is a herdr job; there is no client-to-hopper message of its own yet.
- **Never a question.** A login opens no question and reaches no escalation level. An escalation level's
  run that waits on one reports it with the question (`questionId`, the level as `run`); the run ending
  in an error still climbs the question, as any error does.
- **The logins** (`src/logins/service.ts`, the `RunLogins` port). One open login per job (or question)
  and prompt: a report with the same tool, the same code, or (no code) the same URL is that login (issue
  #567). The same code again changes nothing — no event, its expiry kept from when it was first shown —, so
  a device-flow script that polls, or a job that reports its login again each time it checks on it, is one
  login however often; a new code updates it (`auth.pending` again, same `loginId`, `renewed: true`), never
  a duplicate. The run asks `check` on each poll for what the user did: wait, a new code, cancelled, fail,
  or `ended` (it ended with nothing to tell: the run stops waiting on it).
- **Login signals** (issue #567, `src/logins/signals.ts`). A herdr job's login ends only on a **login
  signal** the turn shows after its `HOPPER_AUTH_PENDING`: a token obtained, the CLI or Claude saying it is
  logged in or the authentication went through (`completed`); the code expired (`expired`, at once, as at
  `expiresAt`, `onExpiry` applies); the user denied it at the provider (`failed`). The protocol line asks the
  job to report a login once per code and, when it goes through, to say so in a line `Logged in.`. Polling output
  (`authorization_pending`, `slow_down`, "waiting for authorization", the same code printed again), Claude
  going on by itself, and the screen changing are no signal: before issue #567 Claude going on completed the
  login, and the same report still on screen made a new one on the next poll, every few seconds. A line
  that says not, never, yet, still, waiting or pending is no signal either. A job that ends with no signal
  leaves its login to the sweep (`failed`, `the job ended`), never `completed`. A print-mode run's login
  is `completed` when the run succeeds; `failed` when the run ends first. Tenant migration 27 collapsed the
  logins the flood made: one of a job's (or question's) tool reported before the kept one's `expiresAt` is
  that login again, and the kept one took its last status. The tick
  sweeps: an open login whose job no longer runs fails (`the job ended`), an expired one too (issue #529: nothing
  waits on it, so no Cancel or New code is offered that does nothing), and so does an escalation level's login
  whose question is no longer open (`the question ended`); a pending one past `expiresAt` expires, with or without
  word from the machine.
- **Expiry.** The logins setting `onExpiry` (`POST /ui/api/logins/settings`, admin; the user's settings,
  read at each expiry, so a change applies without a restart): `fail` (default) — the job fails, its error
  `the <tool> login expired at <time> before it was completed`; `hold` — the job keeps waiting until its
  own timeout, and a new code may still be asked for. Nothing asks a machine for a new code by itself.
- **Acting** (`POST /ui/api/logins/:id/cancel`, `…/new-code`, operator). Cancel ends the login and types
  into a herdr job's pane that the user cancelled it: stop the command, go on without it or fail. A new
  code types in: stop the command, start the login again, report the new code. A print-mode run takes no
  input, so it cannot be asked for a new code (409); cancel only ends the login there.
- **Who completes it.** Always the user, at the provider. No agent or other machine completes a login.
- **Sensitive data.** The URL and the code are credentials in flight. Never stored: the `logins` table
  and every `auth.*` event carry the login's id, kind, tool, status, times and what waits on it, never
  them; they live in the daemon's memory while the login is open and are dropped when it ends (a restart
  drops them: `codeKept: false`; a herdr job still waiting is read back from its screen). Only a UI session
  of the user whose role may act on a login (operator or admin, issue #477) reads them, from `GET /api/logins`
  and `/api/logins/:id`: never a viewer's, never the API door's token, never a loopback read without a session. Wherever a run's output goes on — a job's progress, a question's text
  and recent output, a job's result or error, a login's failure reason — a code its screen or output shows
  is replaced with `[code hidden]`. Webhooks deliver `auth.*` events as any other, without the URL or code.
- **Notifiers.** No `auth.*` event goes to a notifier: the existing notifier sends questions, and a login
  is not one. Webhook subscribers may subscribe to `auth.*`. The Logins UI is issue #477.
- **Naming.** "Login lane" in the issue is a login kind here: a **lane** is a job slot (`lane.opened`).
- **The Logins view** (issue #477, `ui/src/views/logins.tsx`, its model `ui/src/model/logins.ts`). A view of its
  own (`#logins`), apart from Questions: no login is ever a question card. One card per login, open ones first
  with the least time left on top: the machine, the tool, what waits on it (the job, or the escalation run),
  the code with copy and open (`DeviceCode`), a countdown, and Request a new code (a run that can ask) and
  Cancel (asks first). **Phases**, from the server's status and the clock: `pending`; `expiring` under the
  **warning** — the setting `warnSec` (default 60 s; `POST /ui/api/logins/settings`, admin; 10 to 3600) or a
  fifth of the code's life from its last report, whichever is longer — the card and the badge amber, the
  countdown larger, and a polite live region says it once; `expired` at `expiresAt` by the browser's clock,
  before the server's `auth.expired` arrives (the code no longer shown, the card says what happens to the
  job by `onExpiry`); then the server's status is final: `completed` (Signed in, the time, the job goes on: a login signal said so),
  `cancelled`, `failed` with its reason. **Server time:** `GET /api/logins` answers `now`; the UI keeps
  server time less its own clock and counts down on the shared 1 s clock plus that offset, so a skewed
  browser clock does not move the countdown. **Live:** each `auth.*` event refreshes the logins, as each
  `question.*` refreshes the questions. **Badge:** the nav entry and a header link count the open logins
  (pending, not past `expiresAt`) on every view until none is left, never cleared by being seen
  (issue #499's rule for Questions). An ended login stays on its card 5 minutes (`ENDED_ON_CARD_MS`), an
  expired one held for a new code until it changes; then it goes to Earlier logins, under the cards, a
  compact list that never had the code. A viewer's card shows the countdown and a notice instead of the
  code and the actions. The logins settings are a panel there for an admin.
  Taken conservatively, each one place to change: a top-level nav entry, not a tab beside Questions; the
  warning one setting per user (the logins settings are the user's); 5 minutes on a card; no browser
  notification (no `auth.*` event goes to a notifier, above).

Open decisions taken conservatively, each one entry to change: the kinds after `device_code`
(`LOGIN_KINDS`, `kinds.ts`); who completes a login (the user only); on expiry (`onExpiry`, default
`fail`); notifiers (none by default).

## Failure assessment (issue #509, 2026-10-08)

A failed job stayed failed until someone looked at it, and a cause that hit many jobs showed as many failures.
The **failure assessor** (`src/failures/`, one per user runtime) judges every failed job once, from its
`job.failed` — whatever failed it: an executor's outcome, restart recovery, a question's end, an invalid item at
intake. A failed job left unassessed (no `assessment`) — by a restart, or by a build before the assessor — is
assessed at start and by the sweep, whatever its age (issue #517); the sweep leaves a job that failed in the last
minute to its own `job.failed`.

**Rules first, no model.** The error is normalised and hashed to a **signature**; a **known cause** is matched —
a cause a person named for that signature first, then the built-in ones by their text (`causes.ts`). In order
(`assess.ts`, pure):

0. A job that **timed out** (the built-in cause `timed-out`) is decided by its **liveness** alone (issue #630,
   "A timed-out job" below): never grouped into a problem, nor joined to one.
1. The open **problem** of the signature whose scope covers the job's machine takes it: held, or redirected. Not a
   `job` cause's failure (issue #637): a done-check miss is its own job's, even when an older build grouped its
   signature into a problem.
2. A known `shared` cause opens a problem, scoped by the cause to the job's machine (`machine`), its executor on
   that machine (`executor`: an expired login), or every machine.
3. The signature failed on `groupThreshold` items (default 3, counting this one; a retry chain is one item)
   within `groupWindowMin` minutes (default 60): a **general** cause, grouped and held, scoped to the machine
   and executor every failure of it shares. Only when they share a machine or an executor, and only when its cause
   is absent or `transient`: a `job` cause (`not-complete`, `invalid-spec`, `question-unanswered`, or a cause a
   person named with the decision "a person") belongs to its one job and never groups (issue #625).
4. A `transient` cause runs again while its retries are under `maxAttempts` (default 3): after
   `backoffSec × backoffFactor^(attempt−1)`, at most `backoffMaxSec` (defaults 60 s, 2, 1800 s). At the limit:
   a person, saying so.
5. Anything else: a person, with a summary — what was tried (runs, machine, how long), what failed (the error's
   first line), the last line of output.

Two cases come before the rules and act on nothing (issue #517):

- **Superseded.** A failed job that is not its item's newest job — a person ran it again, or anything else did —
  is recorded `superseded`, `nextJobId` the newer job: its class and decision kept for the profile, no problem
  opened or joined, no retry, not for a person. The sweep does the same to a record that was `surfaced`,
  `not_retried` or `held` once its item runs again, so it leaves the person's list.
- **Older than a day** (`STALE_AFTER_MS`) when assessed — an upgraded install's backlog. Its decision stands, as a
  recommendation (`auto: false`, `Retry recommended`, `Redirect recommended: <cause>`), and it waits on a person:
  its work may be stale, and a failure that old neither retries by itself nor opens or joins a problem that would
  hold other jobs.

**hopper's own client errors** match known causes: `client <machine> is not dialled in` is `machine offline` (a
problem, redirected or held, resolved by its online check); `no answer: its link closed` and `no answer within <n>
ms, or its link closed` are `link closed`, transient — a link that drops for good fails the next run with `is not
dialled in`. `test/failures/client-link.test.ts` checks every `ClientError` template in `src/executors/client.ts`,
so a reworded or new one fails there instead of falling through to a person.

**Hold or redirect.** A problem planned `redirect` (socket path, disk full, machine offline) redirects a failed
job that may run elsewhere — not pinned, its machine known, the problem on one machine, automatic redirect on:
it runs again at once, and the decider keeps it off that machine. Any other is held: it waits on the problem's
release. While a problem is open the decider (`DecisionInputs.problems`, `problemHold` and `eligible` in
`assign.ts`) keeps every new job it covers off its machine, and holds one with no other machine — pinned there,
or no other online machine runs its executor — with the reason `held by problem: <title>`. A resuming job returns
to its pane. With automatic hold off, problems are still grouped and shown, but hold no job. A **general** (Recurring)
problem holds only the jobs grouped in it, never every job of its scope (issue #637): with no known cause, nothing says
another job would meet it — problem `ba0f00fc` held every queued job of one machine for ten hours over done-check misses.

**A done-check miss** (issue #637, the `not-complete` cause) is looked at once more before it is assessed
(`lookedAgain`, `done-at-source.ts`, at most `PR_LOOKUP_MS`): its job said it was done, and its source said not done twice,
a minute apart; GitHub may still show the work late. Done now: its record is written `resolved` (the note says done at its
source), no hand-off opens, and its job ends finished, its source told again. Not done, or not known: assessed as before
(a `job` cause: a person), and then it is a decider call like a failure no known cause explains — Jev picks run it again
or a person, in the words of a done-check miss. Whether it is done stays GitHub's to say, never Jev's, so Jev is not
offered `done` or PR waiting: those come only from the source's own answer, here and before every run again.

**Running again** is the sync loop's Run again (issues #313, #354), `by: "assessor"` on `job.rerun`: the item is
given back by its source and a new job queued, `rerunOf` the failed one. Each run again the assessor decides is
**pending** on the failure record (`pending`, `pendingAt`) until made, so a retry due later, a redirect or a
release outlives a restart; the sweep (every tick) makes the due ones. A refusal that may pass — the end not yet
reported to its source, the source not running, the source down — is tried again later; any other ends it
`not_retried`, its reason kept. **Finished work is never run again** (issue #637): before each run again — a retry, a
redirect, a release, a person's Retry — the source is asked whether the job's work is done there
(`FailuresOptions.doneAtSource`, the source's `notComplete`: its issue closed as completed, a pull request that closes
it ready or merged). Done: the job ends finished (`finishShipped`, its source told again: `hopper:done` or
`hopper:pr-ready`, its pull request followed), the record `resolved` with the note `done at its source: …`, and nothing
runs again — Run again would reopen the closed issue (`takeBack`). A person's Retry is then refused, saying so. A source
that cannot tell postpones the run again 30 s. The attempt count is the chain of earlier jobs of the item a retry ran again.

**Release.** Resolving a problem (a person; or its **check**: a `machine offline` or `disk full` problem whose
check saw the cause on its machine — offline, disk low — and then sees it gone) sets its held jobs to run again,
and new jobs are no longer held for it. Release held does the first without resolving.

**Events** (`docs/events.md`): `job.assessed` (once per failed job: decision, class, reasons, summary, attempt,
`auto`), `failure.grouped` (a job joined or opened a problem), `failure.resolved` (by `user` or `check`, how many
held jobs released). Webhooks and notifiers take them as any event.

**Profile** (`profile.ts`): per signature counts and a daily trend over 14 days, its jobs and machines, flagged
recurring on `groupThreshold` jobs; breakdowns by machine, repo and executor.

**Settings** (`failureSettings`, a user setting in the database; Failures view, admin): `maxAttempts`, the
backoff, the grouping threshold and window, `activeWindowMin` (issue #630), `auto.retry` / `auto.hold` / `auto.redirect`
/ `auto.continue` (default on: off, the decision is recorded and waits for a person; one saved before it existed takes
its default), `retentionDays` (default 90: records and resolved problems older
are deleted, a pending one never). Read at each assessment and sweep: no restart. Named causes: `failureCauses`.

**Failures view** (its own nav entry, after Logins; the badge counts open problems and open hand-offs, "Needs a person"): first
what is left (issue #517) — the failed jobs not assessed yet and the open hand-offs, `counts` in `GET /api/failures`,
both zero once everything is processed; open problems with their
jobs, the held ones, Resolve and Release held; the recent assessed failures with their decision, summary and
Retry; the profile and the known causes (an admin names a signature, or forgets one); the settings. `GET
/api/failures` gives each problem and failure its `actions`, `{ ok }` or `{ ok: false, why }`, and the routes
refuse with the same reasons: the view offers only what is taken, and the role (operator for the actions, admin
for settings and causes) is checked by the UI session guard as for every mutation. A failed job's assessment shows
under its error in the Queue and the Overview.

Open decisions taken conservatively, each one entry to change: no model judges a failure (rules only; an unclear
one goes to a person); every automatic action on by default, each switchable; retries move to another machine
only through a problem's redirect; the profile is its own view; the assessor never opens or drafts a GitHub issue.

## A timed-out job (issue #630, 2026-10-10)

A job that ran out of its time (`timeoutMs`, error `timed out`) got no known cause and went to a person, though the
facts that decide it were at hand: was it still at work? Its **liveness** (`JobLiveness` on the job, and in its failure
record's evidence) says:

- `outputAt` — when its pane output last changed. The herdr-claude monitor reports each change of the turn's output
  (`TurnWatch.onOutput`); the executor keeps the last one per job and gives it with the failure.
- `pushed` — the reap at the timeout (`keep`, "Work tree" → "The reap") found a repository in its scratch dir whose
  `HEAD` holds a remote branch the default branch does not. The scratch dir is kept: the job may go on there.
- `pullRequest` — its source says a pull request of its own is open (`JobSource.pullRequestOpen`; GitHub: an open
  pull request closing its issue that it opened, or an older one it pushed to; a draft counts). The assessor asks
  before it assesses (`timeouts.ts`), at most `PR_LOOKUP_MS` (10 s); a lookup that fails or takes longer leaves it
  not known, and the other two decide.

A fact absent is not known. The rules (`timed-out.ts`, pure: liveness and the chain in, decision out):

- **Active** — output changed within `activeWindowMin` minutes (default 10, a failure setting) before the timeout, or
  commits pushed, or a pull request open: **Continue** (decision `continue`, class `transient`, `auto.continue`).
  The sweep makes it at once: its own agent session resumes in its kept work tree when it can (`continueResumes` as for
  a hand-off: an executor that parks, a recorded session, a work tree) — `job.continued` with `recordId` —, else its item
  runs again, `job.rerun` `by: "assessor"`. Either one is told it timed out while at work and to go on from its
  branch or pull request (`timedOutBrief`). The third active timeout in a row of its chain (`MAX_ACTIVE_TIMEOUTS`)
  goes to a person: an agent that keeps producing output is not continued for ever.
- **Silent** — none of them: **Retry** once, after the first backoff. Silent again right after that retry: a person.

The chain (`chain.ts`) is read from the failure records: a continued run is the same job, so its earlier records
count as well as its earlier jobs'. Only timed-out runs the assessor ran again count, newest first, back to the first
that was not one. A person names no cause with `continue`: it needs a timeout's liveness.

## Needs a person (issue #516, 2026-10-08)

A failed job the assessor handed to a person showed among the recent failures, which a window of 50 hides, and as a
locked entry, which a dismiss hides: either way it could fall out of sight while nothing was still trying. A
**hand-off** (`src/failures/handoffs.ts`, the `handoffs` table, tenant migration 23) is the durable place for it: it
stays open until a person acts.

**It opens** in the transaction that ends automatic handling (`handoffReason`, `handoff.ts`, pure): the assessor's
record surfaced to a person (`person`; `retry_limit` when a transient cause used its retries), its decision's
automatic action off (`auto_off`: a recommended retry, or a hold with automatic hold off, or a failure assessed more
than a day after it failed, issue #517), or a run again the
assessor decided refused (`not_retried`). A dismissed locked entry with no hand-off, no pending run, not run again
and not held by its problem opens one (`dismissed`). At start, records left waiting with no hand-off (a restart
between the two, or a store from the build before) whose job is still failed, not dismissed and the newest of its
item are handed off. One per job at a time; the record keeps `handoffId`, so it is never handed off twice. It keeps
its assessment's summary, reasons and error, so it outlives the record's retention.

**It closes** when its item runs again — a new job whose `rerunOf` is its job, from Needs a person, the Queue, the
failure's Retry or the source (`run_again`) —, when a person resolves it (issue #551, below: `continued`,
`done_by_hand`, `wont_do`, or `run_again` with the resolution; `cleared` is a close by the build before), or when its
job ends finished (`finished`: its issue closed as complete). A failure whose
item already ran again when it is assessed is **superseded** (issue #517) and opens none; one whose item runs again
later, by a way that records no run again on it (the Queue's Run again, the source), turns `superseded` by the sweep,
`nextJobId` the newer job. Run again from
Needs a person (Run again, Continue) runs the item again past the retry limit and past its problem's hold (Release /
Retry with override: one action), and marks the record `retried`.

**It never goes by itself.** The prune deletes closed hand-offs older than `handoffRetentionDays` (default 30) and
never an open one; the failure records' prune does not touch them.

**Stale data clears itself (issue #529, 2026-10-09).** A hand-off nothing waits on any more closes without a person,
by the same rule at start and on every sweep, so one recorded before the rule existed clears on the upgrade. Closed,
never deleted, with why (`handoffs.ts` `settle`, `checked`):

- a newer job of its item exists that no `job.queued` closed it for — a store from the build before, or a newer job
  made while nothing followed the events (`superseded`, `nextJobId` the newer job); its record turns `superseded`;
- its job ended finished (`finished`) or is gone (`job_gone`);
- its item is closed at its source any way but as completed, or gone (`item_closed`): the sweep's work check
  (`work-check.ts`, below "What happened, from the work") asks the source (`JobSource.workState`; GitHub: the issue's
  state, 404/410 gone) for each open hand-off, at once for a new one and then at most every 10 minutes; its record
  turns `item_closed`. A source that cannot tell leaves it open. Closed as completed, the work shipped: below.

A record nothing waits on (`superseded`, `item_closed`: `SETTLED`, `handoff.ts`) leaves Recent failures; the profile
and the history still count it. The badge and `counts` follow the open hand-offs.

**Open and ended (issue #618, 2026-10-09).** Failures shows only what is still open: Needs a person lists the open
hand-offs, and Recent failures the records that have not **ended**. A record ends (`endedAt`, `view.ts`) when its job
ran again or something settled it (an outcome in `RAN_AGAIN` or `SETTLED`), when its hand-off closed — continued, run
again, resolved, superseded, its item closed, its job finished — or when its job ended finished. The hand-offs closed
in the last day and the records that ended in the last day are history: Failures shows them under **Ended in the last
day** (`handoffs` with `status: closed`, `ended` in `GET /api/failures`), out of the counts and the badge. The same rule clears questions and
logins: an open question whose job ended or is gone is cancelled at `recover` and on each tick (`QuestionService.sweep`),
and a login, below in "Logins".

**Events.** `handoff.opened` (reason, summary, `notify`), `handoff.closed` (end, `nextJobId`) and `handoff.checked`
(its work state changed, issue #621: `item`, how many `pullRequests`, `shipped`). `notify` is the
setting `handoffNotify` (default on); off, the event is still recorded and streamed, but no webhook delivers it — the
dispatcher delivers no event whose data says `notify: false`.

**Failures view.** Needs a person first, its own count, then the open problems: each hand-off with its reason, what
happened in one plain sentence and the recommended resolution (its **card**, issue #621, below), its resolutions
(below, issue #551), and behind **Details** the assessment summary, the known cause, the reasons and the raw error. The Failures nav
badge counts open problems plus open hand-offs, read again on each `handoff.*` event: still open means still counted.

### Resolving a hand-off (issue #551, 2026-10-09)

Run again (a cold job, told nothing) and Clear (closed, nothing recorded) left a person not knowing what to do, what
doing it would lead to, or where to say what they did; the issue stayed `hopper:failed`. Now a card says it and takes
the answer.

**What to do.** Each card says what happened and recommends one resolution (its **card**, issue #621, below) and, by
each other resolution, what it leads to — for Continue whether the job's own session resumes (`continueResumes`) or a new
job runs. A resolution the daemon does not take now is said with its reason (`actions[*].why`), never offered.

**One place to answer.** A note box and four resolutions (`POST /ui/api/failures/handoffs/:id/resolve`, operator;
`handoffs.ts` `resolve`):

- **Continue** — when the job's own agent session can resume (its executor parks, it recorded `agentSession`, its
  pane state is kept), the *same* job is queued again (`SourceHost.continueJob`, `job.continued`): its source takes the
  item back as for Run again (`hopper:failed` goes), its end is to be reported again (`claimReported`,
  `finalReported` reset), it is pinned to the machine it ran on with the brief pending (`brief.ts`: the failure, the
  assessment, the error, the note), and `continued` sends its claim to the executor's reopen — the parked job's path:
  a new pane in its work tree (the worktree command finds it, or makes it again at the same path, so `claude --resume`
  finds the session), `--resume <session>`, the brief typed in. Its new failure is assessed on its own (the record
  continued is `retried`, `nextJobId` its own id). Otherwise a new job of its item runs (Run again with the brief after
  its prompt: the earlier error, the assessment and the note).
- **Run again** (`fixed`; *I fixed it* before #621) — the cause was outside the job; Run again with the note.
- **Done** (`done_by_hand`; *Done by hand* before #621) — the work is done, by the job's pull request or by a
  person; its job ends finished (`result` the link); its record `resolved`.
- **Won't do** — the note (required) says why; its locked entry is dismissed; its record `resolved`.

A run again a resolution makes closes the hand-off with the resolution, not by the new job's `job.queued` (the
hand-offs being resolved are skipped there).

**Report back.** The resolution is kept on the hand-off (`resolution`: action, who — the signed-in person's name, kept
here and never written out —, when, note, link, `resumed`) and `handoff.closed` carries its action. The sync loop tells
the job's source (`JobSource.resolved`) on the job's report chain, after the job's own end is reported, at once on
the event and again at each sync while `writeBack` is `pending` (a transient error is kept as `writeBackError`; a
permanent one ends `failed`). On GitHub (`writeResolution`): Done `hopper:done`, Won't do `hopper:rejected`,
in place of `hopper:failed`, so the issue is not taken again; Continue and Run again took it back already; then one
comment — what was done, the note quoted, the link — naming no person. It is the hopper's one comment (AGENTS.md
"GitHub text is neutral").

**Learn.** An admin names the hand-off's cause from its card ("this was X", "next time Y", its decision) through the
known causes (`POST /ui/api/failures/causes`, keyed by the record's signature): the next failure with it follows that.

**Follow it.** The card links the job that follows (`nextJobId`): the same job continued, or the new one.

### What happened, from the work (issue #621, 2026-10-10)

A card that repeated the raw error — "not complete: no pull request opened by this job…" — with a next step chosen by
the hand-off's reason left a person unable to tell what happened: the #613 job had updated a pull request that was
already merged, and the card still said the job hit a problem of its own. Now the hopper checks the real state first,
and the card says it.

**The work check** (`work-check.ts`, in the failure sweep). For each open hand-off, at once for a new one and then at
most every 10 minutes, the sweep asks the job's source what its work shows (`JobSource.workState`): its item — `open`,
`done` (closed as completed), `closed` (any other way), `gone` — and the pull requests the job opened or pushed to,
each with its number, `by` (`opened`: created at or after the job; `updated`: its head commit made at or after the job,
issue #618), its state (open, merged, closed), draft and merge conflicts. GitHub (`completion.ts` `workState`) reads the
issue, the merged pull request that closed it, the open pull requests that close it, the pull requests that mention it
in its own repo, and those the issue's text names (as the done-check does, at most 10). The answer is kept on the
hand-off (`work`, with `checkedAt`; JSON in its row: no migration, the build before ignores it); `handoff.checked` says
when it changed. A source that cannot tell, or fails to, leaves the hand-off as it was, asked again later.

**The work shipped** (`workShipped`, glossary **Shipped**): a pull request of the job's merged, or its item closed as completed. Nothing is left
to do, so the hopper closes the hand-off itself (`finished`) and the job ends finished (`SourceHost.finishShipped`,
`job.finished`, `result` what happened and the merged pull request's link); its end is reported to its source again, so
on GitHub its issue loses `hopper:failed` (`hopper:done` once closed, else `hopper:pr-ready`). A job whose pull request
merged never stays a failure. Its item closed any other way, or gone: the hand-off closes `item_closed`, as before.

**The card** (`card.ts` `handoffCard`, pure; `HandoffView.card`). `whatHappened`: short ASD-STE100 sentences from the
work, never from the error — "The job updated PR #616. #616 is merged. The issue is done.", "The job stopped before it
opened or updated a PR." — naming at most two pull requests (merged first, then open and ready, open otherwise, closed),
counting the rest. Before the first answer: "The job stopped with an error. The hopper is checking its PRs and its
issue." `recommended` and `why`, in order: the work shipped → Done ("The work is done."); the item closed or gone → Won't
do; the first pull request open and ready → Done, with its link ("The PR is ready. Review and merge it."); with merge
conflicts or a draft → Continue; closed without a merge → Run again; no pull request → by the reason (job-specific:
Continue; retries used up, automatic action off, run again refused: Run again; dismissed: Won't do). `link`: the pull
request Done points at, put in the Link box.

**The view.** The card's sentence first, then the recommended resolution as the main button with its why, the others
after it, smaller, each with what it leads to; the assessment summary, the known cause, the reasons and the raw error
behind **Details**. A viewer sees the recommendation without buttons. The buttons read Done, Continue, Run again,
Won't do; the actions (`done_by_hand`, `continue`, `fixed`, `wont_do`) and the API are unchanged.

A model's short summary of a long assessment is the hand-off's TL;DR (issue #569, "TL;DR"), under what happened.

Not done here, carried: Park, ask a question, or send to another machine or model as resolutions; a model-written
diagnosis of the failure on the card (issue #550).

Open decisions taken (issue #516): the name is *Needs a person*, a section of the Failures view, not a nav entry of its
own, and the domain word is *hand-off* (*dead letter* stays a not-term, as for the locked entry); the locked entry
stays in the Queue beside its hand-off (Won't do dismisses it; Clear did, before issue #551); entering notifies by a setting, default on. No setting
moves the badge: the Failures entry carries it.

## Parked jobs (issue #501, 2026-10-08)

A person takes a running job, or one on a question, out of its lane for an open-ended time — days or weeks —
and re-queues it later on the same machine, where it resumes its agent session. Distinct from a job on a
question (`waiting_answer` keeps its waiting pane and Claude in it) and from a job's own wait for something
(issue #483, "A job's own wait"): parking is a person shelving a job, and holds nothing live.

- **Park.** `POST /ui/api/jobs/:id/park` (least role `operator`, the same as cancel). Accepted for a `running`
  job or a `waiting_answer` one whose executor has `park` (`parkingExecutors` of `GET /api/health`), with or
  without an **agent session** (issue #530); else 409 with the reason (`parkRefusal`, `src/engine/park.ts`). A running job is
  interrupted at once (abort reason `park`): the herdr-claude executor leaves its pane as it is, the runner
  records the park and frees the lane in one transaction (`recordPark`), then `Executor.park` ends Claude,
  stops the job's scope and processes through the machine's own connection (the reap without a scratch dir),
  and closes the pane. A job that ended done in that moment is recorded as done. A job on a question is
  parked the same way, without the runner. The job is `parked`, `parked: { at, from }`, `resumeOn` its
  machine; `job.parked { from, machineId }`. A machine that cannot be reached is logged; the sweep stops what
  still runs there (a parked job is not live).
- **Kept.** The work tree, the job worktree and branch in the scratch dir, the agent's own session data, the
  machine, the open question. The sweep removes scratch dirs of ended jobs only; the reap runs only at a job's
  end; the deferred cleanup is of ended jobs: none touches a parked job. Restart recovery leaves it as it is.
  Credential files left in the scratch dir are not renewed while parked (no process reads them) and are
  written again at the re-queue's start.
- **Its question.** Stays open, in **Parked** with its job, not in Questions (issue #565): neither Questions, its
  badge nor the Attention panel shows it, and `GET /api/sections` counts it in `parked`, not `questions`
  (`GET /api/questions` still lists it). Picked up with it still open, it is back in Questions. While its job is parked it never
  expires and is not renotified (`QuestionService`: `expire`, `renotify` and `armHuman` skip it). An answer
  or a close is kept as `pendingAnswer`; the job stays parked. Dismissing it cancels the job, as for any job
  on its question.
- **Pick up** (a re-queue; the UI's word since issue #565). `POST /ui/api/jobs/:id/requeue` (least role `operator`), `job.unparked { to }`. With its
  question still open: back to `waiting_answer` (`to: waiting_answer`), the human timeout started again
  (`QuestionService.unparked`); the answer then re-queues it as any. Else `queued` (`to: queued`) with
  `pendingAnswer` the answer kept, or `PARKED_RESUME` (it was parked; go on). A pending answer pins it to
  `resumeOn` and gives it the resume boost, so it waits for its machine — held `pinned machine <m> offline`
  while it is — and never starts elsewhere. A fresh start elsewhere is not offered: cancel it and Run again.
- **Resume.** The claim calls `Executor.resume`; with `job.parked` set, herdr-claude reopens: it stops
  whatever of the job still runs there (two agents in one session would interleave), opens a new pane in the
  recorded work tree, enters the same job worktree (the worktree command uses the one there), starts
  `claude --resume <agentSession>`, and sends the answer. The next outcome clears `job.parked`.
- **Fresh start** (issue #530). A parked job with no agent session (`startsFresh`: started before the session
  was recorded) cannot resume one. Its re-queue is refused (409) unless the request says `freshSession: true`,
  the person's confirmation from the UI's Re-queue dialog: never a silent fresh start. Its claim then opens
  the new pane in the kept work tree as above, starts Claude with a new `--session-id` (recorded, so a later
  park resumes it), and sends the task, then `freshStartBrief` (`src/engine/park.ts`, wrapped around the
  pending answer by the runner: no history, look at the work tree first, and — parked on a question — the
  question and the answer, or that none was given), then the protocol footer. With its question still open it
  waits on it again first, as any; the answer then starts it fresh the same way.
- **Agent session.** herdr-claude starts Claude with a session id it chose (`--session-id`, a UUID) and
  reports it once Claude is up (`ExecutionContext.agentSession`). Jobs started before that have none; they
  park all the same, and start fresh at the re-queue. Executors that cannot park (the print-mode agent
  executors, the test executor) are not in `parkingExecutors`.
- **Machine and lanes** (issue #530). Capacity is lanes: the decider counts busy and draining lanes, and a
  job on a question or a parked one holds none, so neither counts against its machine's lane cap.
  `jobsOnMachine` (`src/engine/queries.ts`) is not capacity: it keeps a client machine's connection and
  refuses removing a machine while jobs need it. A job on a question stays in it — its pane and Claude are
  live there, and the answer is typed into them. A parked job is not in it: nothing of it runs, and parking
  ends its pane and agent, so the machine is free of it at once.
- **UI.** Park on a running lane's job, on a job on a question in the Waiting panel, and on its question card
  (For you / Questions, issue #530), where a person decides a job must wait; Pick up and Cancel on a parked
  job. Park only where `canPark` (`ui/src/model/board.ts`, from `parkingExecutors`) says the daemon takes it;
  on a running job or one on a question it does not apply to, the job says why instead (`parkRefusal`).
  Pick up of a job that starts fresh asks first, saying it starts a fresh session in the kept work tree with
  its question and answer as context. Only for a role that operates. The Overview's Waiting panel and the Queue view list parked jobs in their own group
  (`/api/queue` `parked`); the Waiting card says how many are parked; they are never running and on no lane.
- **The Parked section** (issue #565, `ui/src/views/parked.tsx`). Parked jobs have their own place, a section like
  Questions, Logins and Failures (`SECTIONS.parked`, events `job.parked` and `job.unparked`): one compact row per
  job — its issue title and number, the machine it resumes on, how long it has been parked, its open question's first
  line, whether its agent session resumes or it starts fresh —, high-priority jobs first, then the longest parked
  (`parkedOrder`). Expanded, the full question and **Answer and pick up**: the answer (`POST
  /ui/api/questions/:id/answer`, kept as `pendingAnswer`), then the pick up, in one step; a fresh start is confirmed
  first; an answer kept when the pick up fails leaves the job parked, answered. Pick up and Cancel on each row. Its
  badge counts the parked jobs, marked when high priority, quiet (muted): a reminder, not an alarm.
- **A login it waits on** (issue #476) fails when it is parked, as for any job that no longer runs (`the job
  ended`); the resumed session meets its tool again and reports a new one.
- **Auto-park** (issue #650). A question that waits on a person longer than the **park timeout** parks its job by
  itself, so a night of unanswered questions does not keep panes and agents live on the machines. The engine checks
  on each tick (`src/engine/auto-park.ts`): a `waiting_answer` job whose question is open at the human stage, waited
  at least the timeout since `escalatedToHumanAt` (time at the escalation levels, Jev and the fixed answers does not
  count), is parked on the Park button's path (`recordPark`, then `releaseParked`), with `parked: { auto: true, why }`
  and `job.parked { auto: true, why }`; `why` reads "Parked automatically: the question waited 30 min." (the timeout
  that applied). The timeout is the user's setting `autoPark` (`GET /api/auto-park`, `POST /ui/api/auto-park`,
  least role `admin`, `auto_park.settings_changed`; Settings → Auto-park; `hopper auto-park [set]`): `minutes` for a
  job that is not **high priority** and `highPriorityMinutes` for one that is, its live priority; default 30 for
  both; 0 turns it off for those jobs; at most a week. Read on each tick, so a change applies without a restart, and a
  restart loses no timer (the wait is from the stored time). Never parked by it: a question a risk rule or the
  consequential guard sent to a person (`Question.keptBy`, set by `toHuman`: `risk`, `guard`) — it keeps its pane, as
  before —; a job with no agent session (its pick up needs a person's confirmation, issue #530); one a fork of its
  question still works for (issue #548). A job waiting on a login is running, not on a question, and never parks by
  itself. **Its answer picks it up**: the answer (or a close) to an auto-parked job's question re-queues it in the
  same transaction (`onAnswered` → `recordUnpark`): `queued`, its priority as it was, pinned to its machine, and its
  claim resumes its agent session there with the answer; no Pick up. The Parked row offers **Answer** in place of
  Answer and pick up, and the Parked row and the Overview's parked row show `why`. A job a person parked keeps the
  answer until it is picked up, as before.
- **Settings.** Who may park is the operator role, as for cancel, and roles apply live. Auto-park's timeouts above;
  no limit for parked jobs.
- **Persisted state.** No schema change: the status and the fields are in the job's JSON. A build before
  this one, on a store holding a parked job, shows it in no group and never runs it.

## A GitHub sign-in ends with its connection (issue #513, 2026-10-08)

Owner request: when the connected GitHub account ended ("GitHub sign-in expired: connect again"), the person
stayed signed in to the hopper: Sources paused, the header asked to connect again, and the rest of the UI stayed
live. The person looked signed in while what they signed in for — reading their `hopper` issues and acting on
GitHub — was gone. The connection ending must end the hopper sessions that depended on it; signing in with GitHub
again restores both; no "still signed in, only reconnect GitHub" path for someone whose sign-in that connection was.

**As built** (`src/http/ui/sessions.ts`, `src/http/index.ts`; `ConnectedAccounts.expired`):
- **A session signed in with GitHub** — its realm is a `github` realm — **ends when its user's GitHub connection
  has ended** (`expired`: GitHub refused the refresh token itself with no newer pair stored, or the token is past
  its expiry with nothing to renew it; "Keeping the connection"). It is checked where every expiry is, on lookup
  (`live`): the request that names it, its renewal, and the sweep of the stored sessions — so it ends after a
  restart too, and each gets its event even when no request names it. A renewal trouble or a token the runtime
  cannot open (`failed`) ends nothing: neither is an end of the connection.
- **Reason `connection-ended`**: logged (`hopper: UI session ended (connection-ended): …`) and recorded as
  `ui_session.ended { reason: 'connection-ended', realm }` in the user's events, beside `connected_account.expired`.
- **The UI goes to sign-in at once.** The header's **GitHub sign-in expired: connect again** shows only to
  someone signed in another way; signed in with GitHub, an ended connection on the source makes the page ask
  `GET /ui/api/session` at once (`recheckSession`), which the daemon answers signed out, and the page goes to
  sign-in with the realm, keeping the page it was on (#439's `reauth`). The Sources panel offers no **Connect
  GitHub again** to a GitHub sign-in. Signing in with GitHub again adopts the new grant (`ConnectedAccounts.adopt`,
  which replaces the ended record): a session and a live connection in one step, then the page it was on.

**Open decisions, taken without asking** (the issue's D1, D2):
- **D1 — only sessions signed in with GitHub.** A person signed in at the edge (OIDC, SAML, a gateway, the login
  code) whose GitHub was connected from Sources keeps their session; their GitHub sign-in was never their hopper
  sign-in, so the header and the Sources panel keep asking them to connect again. Ending theirs too would sign
  someone out because of an integration, which the edge realm (the authority for their sign-in) did not ask for.
- **D2 — every GitHub session of that user, not only the browser that last used it.** All of them signed in
  through the connection that ended; the hopper does not record which browser used the connection last, and a
  second browser left signed in would be the same half-working state the issue removes.

**Verification:** `test/http/ui-sessions.test.ts` (every GitHub session of the user ends, as `connection-ended`,
on lookup and on renewal; a session of that user signed in another way stays; a live connection and another
user's session stay), `test/integration/connection-ended-session.test.ts` (the real daemon and a fake GitHub on
loopback: two browsers signed in with GitHub, GitHub revokes the grant, both sessions read signed out, a change
is refused, two `ui_session.ended` events; signing in with GitHub again gives a session and a connected account;
a token refused while its refresh token works is renewed and ends no session), `test/ui/sources-view.test.ts`
(signed in with GitHub, an ended connection goes to sign-in at once, with no reconnect offered and the page kept).

## Usage limits (issue #522, 2026-10-08)

The soft and hard limits are a setting of the user, edited on the Usage view, not only the environment.

- **Which wins.** `HOPPER_SOFT_LIMIT` / `HOPPER_HARD_LIMIT` are the defaults. Once the user saves limits on the
  Usage view, the stored ones (`usageLimits` in the user's `settings`) win, for that user, until changed again
  there; the environment is not read for them after that. **Defaults** on the editor saves the environment's values
  back as the user's. Same bounds as the environment: fractions from 0 to 1, soft below hard.
- **Live.** The engine keeps the environment's policy (`EngineOptions.policy`) and reads the stored limits over
  it at every Decision and every usage report (`policyOf`, `src/engine/context.ts`); a Decision's `inputs.policy`
  carries the limits it used. Saving appends `usage.limits_changed { from, to }`, one of the `TRIGGERS`, so the
  next Decision comes at once, not at the next tick. Nothing restarts.
- **Route.** `POST /ui/api/usage/limits { soft, hard }`, admin. `GET /api/usage` answers `limits` as
  `{ soft, hard, defaults: { soft, hard }, set }`. A soft limit at or above the hard one is refused with 400; the
  editor refuses it first (`limitsProblem`, `ui/src/model/usage-limits.ts`) and posts nothing.
- **Informational readings never throttle**, whatever the limits: unchanged, the limits apply to the throttle
  fraction of decider step 1 only.
- **The editor.** A panel across the top of the Usage view: usage now (the highest throttling fraction over online
  machines) with its band, each online machine's lane cap at the draft (the decider's rule, repeated in the UI's
  model because the UI imports nothing of `src/`), and the graph (`ui/src/charts/usage-limits.tsx`): the last
  day's throttle line — the highest non-informational line of the usage history at each step — over the free,
  soft and hard bands, the line coloured by the band each stretch of it is in, its last point usage now. Each
  limit is a dashed rule with a handle: drag it, press on the graph to move the nearer limit there, or use the
  handle's arrow keys (Shift: 5%). A limit moves in whole percents and stops 1% short of the other. Two number
  fields edit the same draft. Nothing is stored until Save. A viewer sees the graph without handles.
- **Gauges follow the limits.** Every usage gauge's marks and colours are the limits the decider uses now, not
  fixed 70% / 95%; before the usage report has loaded, a gauge has no marks and one neutral colour.

**Verification:** `test/integration/usage-limits.test.ts` (the real daemon: defaults from the environment; an
admin sets limits, the next Decision uses them and holds a job at the new hard limit, raising them starts it;
one `usage.limits_changed`; soft ≥ hard, out of 0..1 and a missing limit refused; a viewer refused; the stored
limits outlive a restart), `test/ui/usage-limits.test.ts` (the model), `test/ui/usage-limits-view.test.ts` (the
Usage view: band and lane cap follow a draft before saving, Save posts it, soft ≥ hard refused in place with
nothing posted, a viewer reads only).

## High priority everywhere (issue #535, 2026-10-09)

Owner requirement: a high-priority item (`hopper:high`) is tracked through the whole system and raised in every part
of it, not only in the queue order; some lanes are **priority lanes** that high-priority jobs get first; the priority
lanes are the most reliable lanes, measured from the hopper's own history.

**High priority.** A job is high priority when its live priority is at or above the user's **high-priority threshold**
(`highPriority`, default 75 — what `hopper:high` gives; `isHighPriority`, `src/domain/priority.ts`). The *live*
priority: each sync's `refresh` now updates the priority of every job not ended, a started one too (before: only a
waiting one), with `job.reprioritized`, so a label change moves it everywhere at the next sync, without a restart.

| where | what high priority does |
|---|---|
| `GET /api/questions` (`QuestionView`), `/api/questions/:id`, the question routes' answers | `priority`, `high`; the open questions high first, then oldest first |
| `GET /api/logins` (`LoginView`) | `priority`, `high` (its job, or its question's job); the open ones high first |
| `GET /api/failures` (`HandoffView`, `FailureRecordView`) | `priority`, `high`; the open hand-offs (Needs a person) high first |
| `GET /api/queue` | `highPriority` (the threshold); running, on a question, operator-led and parked jobs high first (waiting jobs are in queue order, priority first already; locked entries highest priority first) |
| events | `priority`, `high` (additive, same versions) on `job.failed`, `question.asked`, `question.escalated`, `question.escalated_to_human`, `auth.pending`, `job.assessed`, `handoff.opened` — webhooks deliver them as they are |
| Grok Bot routine | the question body's `high` (beside `priority`); Send open questions sends high-priority ones first |
| failure assessor | the due runs again, high priority first |
| decider step 8 | under a usage limit the lowest-priority busy lane drains first (then the newest): high-priority work is the last scaled down |
| UI | one tag (`HighTag`) on every job title, question card, login and hand-off; Questions, Logins and Needs a person list them first; the Questions, Logins and Failures nav badges are marked and say how many are high priority |

**Priority lanes.** A lane number of a machine (`desk/lane-2`). The decider reads `DecisionInputs.priorityLanes`
(`{ lanes, highPriority, whenIdle }`, `src/decider/priority-lanes.ts`):

- A high-priority job goes to the machine holding the best free priority lane, and takes it — an idle one, or opens it
  (`StartPlan.opens`: with `laneId` null, the lane the engine opens; `LaneRepository.open(machineId, id)`). With every
  priority lane busy it takes any other free lane: it never waits for one.
- `whenIdle: keep-free` (default): a job that is not high priority leaves the free priority lanes — its room on the
  machine is its room less them — and waits with `waiting for a lane: machine m keeps priority lane m/lane-1 free for
  high-priority jobs, the other K are in use`; the lane plan's idle reason says the same. `share`: a default job takes a
  priority lane only when no other lane of the machine (up to its lane count) is free; a low job (below 50) never does.
- Nothing is preempted: a running job is never stopped or parked for a high-priority one (owner decision D2 left open;
  the hopper never preempts, "Usage pacing"). A job on a non-priority lane opens the lowest number not a priority lane.

**Lane reliability** (`src/reliability/`, pure). Runs are read from the event log over the window (`EventLog.between`:
`job.claimed`, `job.started`, and the end on that lane — `job.finished`, `job.failed`, `question.asked`;
`job.cancelled` does not count). Per lane: runs, finished, failed, **lane faults** (`isLaneFault`: the failure
assessor's known causes `machine-offline`, `link-closed`, `start-race`, `socket-path-too-long`, `disk-full`, and the
executors' start failures — `claude exited at startup`, `blocked at startup`, `never reached claude`, a work tree not
usable, `herdr:` errors), lane faults in the last day, success rate, median claim-to-start time. The **score** is the
share of runs without a lane fault, each run weighing half as much per quarter of the window it is old.

**Choosing** (`rank.ts`). Every lane number up to each machine's lane count is listed. A lane is ranked when its machine
is online and it has `minRuns` runs in the window: by score, then success, then quicker start, then id. The `count`
best are the priority lanes; one already chosen stays until a lane scores more than `SWITCH_MARGIN` (0.1) better, or
it drops out (machine offline, too few runs), so one failure does not move it. `manual` (an admin's lanes) wins over
the ranking. Each lane carries its `reason`. The choice is kept in the user's settings (`priorityLaneChoice`), so a
restart keeps it and its hysteresis; it is measured again at most every 30 s (`MEASURE_MS`) and at once after a
settings change. A change of the choice is `priority_lanes.changed { from, to, by }`.

**Settings** (`priorityLanes` in the user's settings, all live; `PriorityLaneSettings`): `highPriority` 1..100 (75),
`count` 0..32 (1), `whenIdle` `keep-free` | `share` (`keep-free`), `windowDays` 1..90 (14), `minRuns` 1..1000 (5),
`manual` (absent). `POST /ui/api/priority-lanes/settings` (admin) takes any of them, `manual: null` back to reliability;
saving is `priority_lanes.settings_changed { from, to }`, one of the engine's TRIGGERS. `GET /api/priority-lanes`
answers `PriorityLanesView`: the settings and defaults, `chosen`, `by` (`reliability`, `manual`, `none`), every lane
with its figures, rank and reason, `measuredAt`, `switchMargin`.

**UI.** Machines: the Priority lanes panel — a sentence of the settings, every lane's reliability, start time, last
day, rank and why, the priority lanes marked; an admin edits the settings, ticks lanes and Use these lanes, or Choose
by reliability. Overview: the Lanes panel marks the priority lanes and names those not open.

**Owner decisions taken as defaults** (all settings, changed live on Machines): D1 a fixed count, 1; D2 keep-free, with
share as the other choice — no park-and-yield; D3 a low job never takes a priority lane, and lanes are not otherwise
handed out by reliability; D4 14 days, 5 runs.

**Verification:** `test/decider/priority-lanes.test.ts` (keep-free and its wait reason; a high job ahead of an older
default job; an idle priority lane; the machine holding it; busy priority lanes; share; a low job; drain order under
a usage limit), `test/reliability/measure.test.ts`, `test/reliability/rank.test.ts` (best lanes, minimum runs, offline,
no flapping on one fault, a lane better by more than the margin, an admin's choice), `test/integration/high-priority.test.ts`
(question and login first and tagged in the API and events, failure and hand-off tags, a label change re-sorts a job on a
question at the next sync), `test/integration/priority-lanes.test.ts` (the API, reliability choice and its event, a high
job takes the free priority lane ahead of waiting default jobs, share, bounds, roles, restart),
`test/ui/high-priority.test.ts`, `test/ui/high-priority-views.test.ts`, `test/plugins/grokbot-payload.test.ts`.

## Proposals (issue #537, 2026-10-09)

Owner requirement: proposals are a category of their own, beside questions. A job — or a person in the UI — asks an
agent for a proposal; the agent comes back with one (goal, approach, alternatives considered, risks, effort, the
context it relied on) instead of doing the work, finishing or asking a question. It goes through configurable reviewer
levels and then a person, with its trail on it, as a question does; it is signed off (who, when, which version),
rejected, or sent back for a revision, the versions kept; it has its own view and badge; settings live in the database
and apply live; priority (#535) applies.

**Asking.** A job is asked for a proposal (`spec.proposal: true`) when its item carries the label `hopper:proposal`
(set at intake, `asksOf`; or a Proposal heading in its body, "Sections"), or when a person asks a job that has not started (queued or held): `POST
/ui/api/jobs/:id/propose`, `proposal.asked`. Its agent is told so after the job rules (`askLine`,
`withAsks`, `src/job-rules/`). Every job's protocol names the marker: an agent asked for a proposal — by its
job or by the issue's own text — writes each part on a line of its own starting with its label (`Goal:`, `Approach:`,
`Alternatives considered:`, `Risks:`, `Effort:`, `Context:`) and ends with a line `HOPPER_PROPOSAL`.

**The marker.** The herdr screen reads `HOPPER_PROPOSAL` as the marker `proposal`; the print-mode executors read it on
the last line. Either returns the outcome `{ kind: 'report', review: 'proposal', report: { text, recentOutput } }` and keeps its
resume state, as for a question. The parts are read from the text (`reviewSections`, `src/domain/review.ts`,
pure): from a label (heading, list and emphasis marks aside; a heading on its own line too) to the next; a part left
out or empty is listed in `missing`. Nothing is refused for a missing part: the reviewers and the person see it.

**The job waits.** (Open decision D2, settled here: the job waits.) The outcome is recorded in the same tx as any
(`recordReport`, `src/engine/reviews.ts`): a new proposal at version 1, or — when the job's proposal was sent back
(`revising`) — its next version. The job goes `waiting_answer` with `proposalId` (no `questionId`): it holds no lane,
its pane stays, it can be parked (#501) and re-queued; re-queued while its proposal is in review, it waits on it again. A restart keeps it waiting (recovery leaves a `waiting_answer` job on an open proposal
alone); a review a level held is started again from that level (`ReviewService.recover`).
`proposal.submitted` (version, Goal, missing parts, the raising machine, the job's priority). A job cancelled or gone
takes its open proposal with it (`proposal.cancelled`, the sweep on each tick and at start).

**Review.** `ReviewService` (`src/review/service.ts`, the proposals' instance) runs the reviewer levels the proposal settings name, lowest
first, then a person — the question pipeline's shape: each stage entered is `proposal.escalated { target }`, a person
`proposal.escalated_to_human` once per version, every write one tx, compare-and-set on status, stage and version, a
person's decision wins over a level in flight. A reviewer level is an **escalation level** reviewing: the
`EscalationLevel` port's `review(req)` (`ReviewRequest`: the kind, the item, the version, the job's prompt and goal — the item, its
repository and context —, the owner's rules, the trail, its place). The built-in `claude-cli` and `anthropic-api` levels
review with a prompt of their own (`review-prompt.ts`), every part from the job fenced as untrusted, and a JSON reply
`{ verdict, notes }` validated by the service (`reply.ts`). Its verdict, recorded with its notes (`proposal.reviewed`):

| verdict | then |
|---|---|
| `approve` | the next level up, the approval on the trail; at the top level with `signOff: top-level`, accepted by that level |
| `request_changes` | sent back to the job with the notes, while the levels have sent it back fewer times than `levelRevisions`; past that, to a person |
| `escalate`, an error, a timeout, a malformed reply, a level that cannot review or no longer exists | the next level up |

**A person decides** (operator role, on an open proposal at any stage): `POST /ui/api/proposals/:id/accept` (optional
`notes`), `/reject` (`notes` required: why), `/request-changes` (`notes` required: what to change). The decision goes on
the trail with who (the session's sign-in name). Accepted or rejected, the proposal is signed off — `signOff { decision,
stage, by, at, version, notes }`, `proposal.accepted` / `proposal.rejected`, delivered to webhooks like `question.*` —
and its job ends `finished`, its result `{ proposal: { id, version, decision } }` (with the job's accepted research, if it researched first: "Sections"), its pane cleaned up. No completion
check runs: the decision is the job's end. Sent back, `proposal.revision_requested`; the job is re-queued with the
revision brief (the type's `brief`: who sent it back, the notes, "write the revised proposal in full … HOPPER_PROPOSAL"),
its next proposal is the next version, reviewed from the first level again.

**What an accepted proposal becomes** (open decision D1): settled by issue #651 — a proposal is a set of paths, and each
selected path continues as a follow-on job ("Proposals: a set of paths" below). The proposal stays linked to its job
and the job's item (`source { key, url, title }`), and the job ends. **Who may sign off** (open decision D3) is a
setting.

**Settings** (`ReviewSettings`, the user's `settings` row `proposalSettings`, read at each review): `reviewers` — the
escalation levels that review, lowest first, by instance name (default none: a person reviews); `signOff` — `owner`
(default: only a person accepts) or `top-level` (the top reviewer level's approval accepts too); `levelRevisions` (0 to
5, default 1). `POST /ui/api/proposals/settings` (admin) refuses a reviewer that is not an escalation level now, so the
UI offers only `levels`, the names `GET /api/proposals` answers with the settings.

**Store.** Table `proposals` (tenant migration 24: a table only, so the build before runs on it): one row per
proposal, its versions and review trail in its body.

**API.** `GET /api/proposals` (`status`: `open` — open or revising, high-priority jobs' first, then oldest first — the
default; any status or `all`, a history newest first) answers `{ items: ReviewItemView[], settings, type }`; `GET
/api/proposals/:id`; `POST /ui/api/proposals/:id/seen`. `ReviewItemView` carries the job's live priority (#535), as
`QuestionView` does.

**UI.** The **Proposals** view, beside Questions: one card per open proposal — the newest version's parts, the parts
left out, earlier versions folded, the review trail, the job — with Accept, Request changes and Reject (the last two
need a reason); a viewer sees a notice. Earlier proposals below, and for an admin the proposal settings. Its nav badge
counts the proposals waiting on a person (open, at the human stage), seen or not, as the Questions badge does (#499),
marked when one is high priority. The Queue's waiting jobs get **Propose** and **Research** (ask for a proposal, for research) and a *proposal asked* or *research report asked*
tag.

## Proposals: a set of paths (issue #651, 2026-10-10)

Owner requirement: a proposal is generally zero or more paths. It is a set of alternative strategies, and the person
selects one or more of them to continue with; before, it was one document, accepted or rejected (#537). The UI supports
the format fully, on a phone too.

**The document** (`proposalDocument`, `src/domain/proposal-paths.ts`, pure). The protocol (`REVIEW_SECTIONS.proposal`)
asks for Markdown in Simplified Technical English (#571): `TL;DR:`, `Problem:`, then each path as `Path N: <title>`
(heading, list or emphasis marks aside) with `Summary:`, `Security:`, `Effort:`, `Risk:`, `Friction:` and `Creates:`
and any Markdown detail, then `Recommended:` (a path's number or a combination's, and why), or `Paths: none — <why>`
(no change is needed, or no viable path was found), then `Context:`. The top parts are the section's parts (`tldr`,
`problem`, `paths`, `recommended`, `context`; the TL;DR is the headline, #569); each path runs from its line to the
next path or top part. A line naming a path in prose (`Path 1 is cheaper`) starts none. A version keeps its paths
(`ReviewVersion.paths`). A document with no path and no reason for none — a proposal written before #651, or one that
left the format — reads as **one path** (`single`): titled by its Goal or its first line, its Risks and Effort as
tradeoffs, the whole text as its Markdown. A version stored before #651 has no `paths`; `pathsOf` reads its one path from
its text, and the routes answer every version with its paths. No stored row changes.

**Structure** (the pre-check, #631): a path that leaves out a part, a set with no recommended path, zero paths with no
reason, or a document not written as paths, each one fixed line.

**Frontier review.** A reviewer level is shown each path in full and asked whether each serves the goal, whether the set
covers the real options, and whether the recommendation is sound. With an approval or an escalation it may also reply
`paths: { add: [...], notViable: [{ id, why }] }` (`PATH_AMENDMENTS`, `src/review/reply.ts`, bounded): an added path
is numbered after the last and marked `addedBy`; a path not viable is marked `notViable { by, why }` and cannot be
selected. Both change the newest version before a person sees it; the trail entry and `proposal.reviewed` name what
changed (`paths { added, notViable }`). Where the top level may sign off, its approval continues with the recommended
viable paths; with paths but none recommended, a person selects.

**The decisions** (operator role): **Continue with selected** (`accept`, `paths: [{ id, note? }]` — at least one, all
viable, each once; none on zero paths, where the button reads Accept), **Ask for more paths** (`more_paths`, notes
optional: the job keeps its paths and their numbers and adds new ones), **Steer** (`steer`, notes required), **Reject
all** (`reject`, notes required; refused, 409, on zero paths). A decision that sends the proposal back may carry the
selection made so far: kept as `selection { version, paths }`, so the next version starts with it checked. A refused
selection is 400.

**Follow-ons** (`createFollowOns`, `src/engine/follow-ons.ts`). Accepted with paths selected, outside a fork (whose
result answers its parent's question, the selected paths named in it) and a switch that goes on (whose job is told the
selected paths), each path continues as its own **follow-on** job, in the tx of the decision: the parent's spec without
its asks, its priority, accepted at once, `followOn { jobId, proposalId, pathId, title, text, note, siblings, source }`;
`job.queued` with `followOn`, then `proposal.followed_on` on the parent's timeline. A follow-on is told its path after its
job rules (`followOnBrief`): the path as written, the person's note, and the other selected paths, which run as their
own jobs. Like a fork, it has no source of its own; the sync never reports it to the parent's item. `signOff.selected`
keeps each path with its job; the parent ends `finished`, its result `{ proposal: { id, version, decision, followOns: [{
path, jobId }] } }`. Paths not selected stay on the version as the record. Follow-ons are jobs only: the hopper files no
issue (GitHub text is neutral, and the hopper opens no issue of its own).

**API and CLI.** `ReviewItemView.followOns`: each follow-on with its job's live status (as `QuestionView.forks`, #570).
The operator CLI (`hopper proposal list|paths|select|accept|more-paths|steer|reject`, `src/cli-operator.ts`) answers JSON
and makes the UI's own call under a one-call session, as the other operator actions (#374, #623) do; the decision names
`operator CLI` as who.

**UI** (`ui/src/views/proposal-paths.tsx`). The card shows the TL;DR and the problem, then each path as its own sub-card:
title, TL;DR, tradeoff badges, a recommended badge, *added by* or *not viable* where a level said so, what it creates,
and **Details**, its full Markdown. Markdown (`ui/src/components/markdown.tsx`) is rendered by marked with raw HTML
shown as text, images as their alt text and only http, https, mailto and in-page links, then sanitized by DOMPurify;
links open in a new tab, `rel=noopener noreferrer`. A checkbox per path, a note field for each checked one, and the
section's decisions; zero paths shows the reason with Accept, Ask for more paths and Steer only. Decided, the earlier
proposals list each path of the signed-off version: a selected one links to its follow-on with its live status, the
others greyed out and kept.

## Blast radius and actor machines (issue #542, 2026-10-09)

Owner proposal: the hopper gives jobs read-only credentials to tools such as AWS, Terraform and kubectl, but did not
know what each machine could reach, so a job could land on a machine whose access was much wider than it needed. Three
layers, configuration the source of truth throughout: **discovery** of each machine, its **blast radius** rated from
it, and the **gate** that keeps jobs off a high-radius machine; **actor machines** are machines set up for that work on
purpose.

**Discovery** (`src/client/discover.ts`, read by `src/blast-radius/read.ts`). A fixed POSIX sh script, run with no
argument of the request's through the machine's own connection — this machine, ssh, or a client target's
`POST /discover` — as the reap and the survey are (`MachineShell.discover`). It reads, and prints names only:

| what | how |
|---|---|
| tools | every PATH directory and every executable in it; `aws --version`, `terraform version`, `tofu version`, `kubectl version --client` (first line) |
| AWS | the environment's own identity, then each profile's (`aws configure list-profiles`, at most 8): `sts get-caller-identity`, the region; then `iam simulate-principal-policy` of the identity (an assumed role as its role) for `AWS_WRITE_ACTIONS` |
| kubectl | each context (`config get-contexts`, at most 8), its cluster and namespace (`config view --minify`), and `auth can-i --all-namespaces` for `KUBE_CHECKS`: `create deployments`, `delete pods`, `get secrets`, `* *` |
| credential sources | the names of credential variables set (`AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, `KUBECONFIG`, `TF_TOKEN_*`, …) and labels of credential files present (`aws-credentials`, `kubeconfig`, `terraform-credentials`, `kubernetes-service-account`, …) — never a value, never a file's content |

Every call is bounded at 10 s (`timeout`), the whole at `DISCOVER_TIMEOUT_MS` (120 s). Every call is a read:
`test/client/discover.test.ts` runs the real script against stand-in `aws` and `kubectl` and checks each call they
received, and that a secret in a credentials file or a variable never appears in what it prints. A container target
has no shell the hopper reaches it by: it is shown as not discoverable, and is never gated by rating.

Terraform state backends and workspaces live in each repository's configuration, not on the machine: the machine's
Terraform reach is the cloud credentials it holds, which the AWS and credential-source rows find, and a Terraform
Cloud token (`TF_TOKEN_*`, `terraform-credentials`), rated unconfirmed.

**When.** A machine online and not yet discovered in this run is discovered at the next Decision (it attached, or the
hopper started); each machine again every `everyMinutes` (default 60; checked each minute); one or every machine on
demand (`POST /ui/api/blast-radius/discover`, operator: it only reads). Its **record** (`DiscoveryRecord`, the user's
settings key `discovery:<machine>`, no schema change) keeps when, the facts, what **changed** since the one before
(tools, AWS identities, contexts and credential sources that came or went, and the level when it moved), the level it
gave, `grew` while a raised level stays, and an actor machine's `mismatch`. A discovery that fails keeps the facts
before it and says why (`machine.discovery_failed`, once per error).

**Rating** (`src/blast-radius/rate.ts`, pure). Each **reach** — an AWS identity with an ARN, a kubectl context, a
credential source no discovered identity accounts for — is `read`, `write` (a simulated write action allowed; a
`create` or `delete` can-i yes), `admin` (an IAM write allowed — `iam:CreateUser`, `iam:AttachRolePolicy`,
`iam:PutRolePolicy` —, an account's root, can-i `* *`) or `unconfirmed` (simulation or can-i gave no answer; a credential
source alone), and **prod** when a profile, account, ARN, context, cluster or namespace holds one of `prodPatterns`
(default `prod`, `production`, `prd`, case ignored) or its account is in `prodAccounts`. The level: `high` for admin
reach or write reach to prod; `medium` for any other write reach; `low` otherwise. `unconfirmed` counts as `write`
(fail closed, the default) or `read`, as the rules say. Each machine is rated from its record with the rules now, at
every Decision and every view: a rule change applies at once. The reasons are the reaches that set the level, each with
its evidence.

**A box's blast radius includes its template's** (issue #605). A box (a client target joined with a template's line)
is rated for the higher of its reach and its template's rating ("A template's blast radius"): its tools decide what it
could do, its template what it may do. `machineRadius` (`rate.ts`, pure) gives the level and its **source** — `reach`,
`template`, or `both` when they are the same. The engine reads the template's rating live from the vault
(`VaultService.boxRadius`) at every Decision and every view, so a template widened to high gates its boxes at the next
Decision, as a rule change does; a template saved or removed, a profile approved and a vault secret set or removed wake
the engine. A box not yet discovered is rated by its template alone: a high template gates it before its first
discovery. An actor box's mismatch compares the level declared with this level. The discovery record keeps the level
of the reach alone.

**The gate** (`src/decider/gate.ts`, pure; `DecisionInputs.blastRadius`). A machine is **gated** when it is an actor
machine, or rated at or above `gateAt` (`high` by default; `medium`; `off`: only actor machines). Placement leaves a
gated machine to the jobs that **pass**: let through by a person (`Job.gatePass`), with one of `pass.labels`, from one of
`pass.repos`, or at or above `pass.minPriority` (none by default: only a person lets a job through until an admin names
rules). A job resuming returns to its pane on its machine. A job every machine it could otherwise take a new job on
(online, its executor, its pin, home known, work tree usable, disk not low, no open problem) keeps from it is held:
`held at the blast-radius gate: desk is rated high; only a job let through the gate runs there`. Otherwise it goes to
a machine that is not gated, or waits for a lane there. A gated machine's idle reason says it is gated. A machine never
discovered is not gated by rating — unless it is a box of a template rated at or above `gateAt` (issue #605):
discovery runs at the next Decision after it comes online.

**Let through** (`POST /ui/api/jobs/:id/gate-pass`, admin — it widens what the job may reach): only a job held at the
gate (409 otherwise); `gatePass { at }`, `job.gate_passed { reason }`, and it is placed at the next Decision. The
Overview's Waiting panel shows the hold as every hold, and for an admin **Let through**, behind a confirmation that
names what the machine is rated; Approve is not offered for a job held at the gate (approving would not move it), and a
role the server refuses sees no button.

**Actor machines.** Declared in the settings (`actors`: the machine, its purpose, the level it is expected to rate).
Always gated. A rating other than the level declared is a **mismatch**: flagged on Machines, and told once per
(expected, found) by `machine.actor_mismatch`.

**Settings** (`blastRadius` in the user's settings, all live, admin; `BlastRadiusSettings`): `gateAt` (`high`),
`pass { labels, repos, minPriority? }` (none), `rules { prodPatterns, prodAccounts, unconfirmed }`
(`prod`/`production`/`prd`, none, `write`), `actors` (none), `everyMinutes` 5..1440 (60).
`POST /ui/api/blast-radius/settings` takes any of them, each replaced whole (`pass.minPriority: null` clears it); names,
repos (`owner/name`), account ids (12 digits), machines and bounds are checked (400). Saving is
`blast_radius.settings_changed { from, to }`. `GET /api/blast-radius` answers `BlastRadiusView`: the settings and
defaults, the curated AWS actions and kubectl checks, and per machine whether it can be discovered, its record, its
rating now (`rating`: its reach), a box's `template` (its name and rating, issue #605), its blast radius `radius`
(`level` and `source`: `reach`, `template` or `both`), its actor declaration with `mismatch`, and why it is gated.

**Events.** `machine.discovered { machineId, level, changes }` (the first discovery, or one that changed something),
`machine.discovery_failed`, `machine.radius_grew { from, to }`, `machine.actor_mismatch { expected, found }`,
`blast_radius.settings_changed`, `job.gate_passed`. `machine.discovered`, the settings change and `job.gate_passed` wake
the engine; so do `template.saved`, `template.removed`, `template.profile_approved`, `vault.secret_set` and
`vault.secret_removed`, which change a template's rating and so its boxes' (issue #605).

**UI.** Machines: the Blast radius panel — the settings in a sentence; per machine its level, *gated* and why, *actor*
and a mismatch, *grew*, when it was discovered and what changed, the reasons, a box's template with its rating and
reasons, the level's source (`high radius, from template kube`), and on demand every reach with its access,
prod and evidence, its tools and its credential sources; Discover per machine and Discover all (operator); an admin edits
the settings and the actor machines.

**Owner decisions taken as defaults** (all settings, changed live on Machines): D1 levels low/medium/high by the rule
above, the rules an admin's to change; D2 AWS reach confirmed by IAM policy simulation of a curated write list (strictly
read-only; an identity that may not simulate is unconfirmed), not a probe list; D3 discovery through the machine's own
connection (what a job there sees), not inside each job; every 60 minutes; D4 the known set is AWS, Terraform and
kubectl — Helm, GCP, Azure, Vault and database clients are not rated yet (their credential files and variables are
listed as credential sources); D5 nothing passes the gate by rule until an admin names one: a person lets each job
through.

**Not built — the owner's open question.** The hand-off to a person on an actor machine: what is handed over (work
tree, branch, plan, commands), where the person picks it up, and how the job resumes or completes after. The gate is
the core it would consume: today a job held at the gate waits (or is parked, issue #501), and a person either lets it
through or does the step by hand (operator-led, issue #318).

**Verification:** `test/client/discover.test.ts` (the real script: tools, identities, simulation, contexts, can-i,
credential sources by name, every call a read, no secret printed), `test/blast-radius/rate.test.ts` (each level and its
evidence, prod by name and account, admin, unconfirmed both ways, root, a refused identity, kubernetes, credential
sources, what a discovery changed, which machines are gated), `test/decider/blast-radius-gate.test.ts` (another machine,
held naming the machine, pinned, let through, pass by label, repo and priority, resuming, the gate holding beside a full
disk), `test/integration/blast-radius.test.ts` (discovered on coming online, the rating and its evidence, held and let
through, settings live, a radius that grew, an actor machine and its mismatch, refusals, roles, restart),
`test/ui/blast-radius.test.ts` (the sentence, the changes, Let through behind a confirmation for an admin only, no
Approve on a job held at the gate).

## Sections (issue #543, 2026-10-09)

Owner requirement: hopper's structure has sections for the categories of things waiting on or involving a person —
Questions, Logins, Failures (Needs a person). Proposals and Research are first-class section types in the same structure,
each with its nav entry, list view, detail and badge, working as the others do: open-item counts and the badge that stays
up while anything is open (#499), priority tagging and ordering (#535), stale cleanup (#529 / #531). Whatever defines a
section type is generic enough that Proposals and Research are two more types, and a future type follows the same path.
Hopper infers the special jobs from the structure: an item in Research maps to a research job, one in Proposals to a
proposal job; an issue laid out with Proposal, Research and Special jobs headings (as #542 is) is read into the matching
sections. Events and webhooks `proposal.*` and `research.*`; settings in the database, live; the UI offers only what the
server takes. The structural home for #537 (proposals) and #538 (research reports), not a replacement.

**The section types** (`src/domain/sections.ts`): `SECTIONS`, in nav order — `questions`, `proposals`, `research`,
`logins`, `failures`, `parked` (issue #565) — each with its label, the event types it emits (by prefix: `question.`,
`proposal.`, `research.`, `auth.`, `failure.` and `handoff.`; for Parked, `job.parked` and `job.unparked`; a webhook
subscribes to them like any), and for a review section its review kind.
`GET /api/sections` (`src/http/sections.ts`) answers each with `open`, `waiting` (of those, what waits on a person) and
`high` (of those, a high-priority job's), each counted by the section's own open rule: an open question at the human
tier, its job not parked on it; a pending login; an open problem or hand-off; a review item open or revising, waiting
at the human stage; a parked job. The UI
lists the same kinds (`ui/src/model/sections.ts`, checked against the server's `SectionKind` at typecheck): every
section's nav entry and its badge follow one rule (`sectionBadges`, `useSectionBadges`): what is open and waits on a
person, seen or not, marked and counted when high priority.

**Review sections** (`src/domain/review.ts`): Proposals and Research are one model. A job asked for one writes a
document instead of doing the work and ends with the section's marker; the document is a **review item**: versions (a
research report's rounds), a review trail, reviewer levels from the section's settings then a person, a sign-off.
Everything that differs is declared once, in the section's `ReviewSectionType` (`REVIEW_SECTIONS`):

| | `research` | `proposal` |
|---|---|---|
| section, events, item id | `research`, `research.*`, `researchId` | `proposals`, `proposal.*`, `proposalId` |
| marker | `HOPPER_RESEARCH_REPORT` | `HOPPER_PROPOSAL` |
| label, body heading | `hopper:research`, `## Research` | `hopper:proposal`, `## Proposal` |
| ask a job (`POST /ui/api/jobs/:id/…`) | `research` | `propose` |
| parts | Question, Findings, Sources and evidence, Confidence, Open threads, Next step | Goal, Approach, Alternatives considered, Risks, Effort, Context |
| a person's decisions | Accept; Dig deeper (notes optional: the open threads to go into, else the whole report); Steer (notes required: the direction) | Accept; Request changes (notes required); Reject (notes required) |
| table (tenant migration) | `research_reports` (25) | `proposals` (24) |
| settings row | `researchSettings` | `proposalSettings` |

**The structural pre-check** (issue #631, `src/review/pre-check.ts`): where the section's settings name reviewer levels, the
newest version is checked first, with no model call: every part present, the summary (the first part) present, links
well formed (an empty target, an anchor that names no heading in the document, or a URL that does not parse is broken;
a relative path is not checked, and nothing is fetched), and a next version not the same as the one sent back. An item
with gaps goes back to its job with the gap list as the notes (`<prefix>.reviewed` and `.revision_requested`, stage
`pre-check`; the trail entry's role `check`), and never reaches a level. Its send-backs do not count against
`levelRevisions`; after `PRE_CHECK_RETURNS` (2) of them, the next item with gaps goes to a person. With no reviewer
levels, a person reviews the item as it is.

Each decision has an effect — `accept` and `reject` sign the item off, `send_back` re-queues its job with the type's
brief, in the same session, for the next version — and its own route `POST /ui/api/<section>/:id/<route>`; a decision a
section does not declare is no route (404). `GET /api/<section>` answers `{ items, settings, type }`, `type` the parts and
decisions, which the UI offers and nothing else. One service per section (`createReviewServices`, `src/review/`), one
repository per table (`createReviewItemRepository`), one set of event schemas (`reviewEvents`, `src/events/schemas.ts`):
`<prefix>.asked`, `.submitted`, `.escalated`, `.escalated_to_human`, `.reviewed`, `.revision_requested` (`decision`
names what sent it back, additive), `.accepted`, `.rejected` (only where a decision rejects: not research), `.cancelled`.
The executors read every type's marker as the outcome `{ kind: 'report', review, report }`; the protocol tells every job
each type's line. A future review section adds a kind, its type, its table and job field, and its event types; nothing
else is per section.

**Research** (#538's behavior, the settled open decisions): a research report goes to a person unless the research
settings name reviewer levels (D1: the same settings as proposals, default none); the job keeps its session meanwhile and
can be parked and resumed on it, as a proposal's. Accepted (D2), the job moves on to the next section it asks for —
research before the proposal — or ends `finished` with its decisions as its result (`{ research: { id, version,
decision } }`, plus `proposal` when it went on to one). **A job not asked for research** (no `spec.research`: its agent
researched because its own item asked for research within wider work) is not ended by the decision (issue #538, D2 as
the owner settled it): it is re-queued in the same session, told the report was accepted (with the notes) and to go on
with what else its item asks, or, asking nothing more, to end with `HOPPER_DONE`; it then ends by its own outcome, the
completion check included, its result the executor's. `job.requeued { reason: 'research report accepted: the job goes
on' }`. Declared on the type (`ReviewSectionType.goesOn`: research `true`, proposal `false` — how an accepted proposal
becomes work is #537's open D1, so its decision still ends the job).

**Special jobs from the structure.** A source item asks for research or a proposal by its label or by a heading of that
section in its body (`asksOf`, at intake: `## Research`, `## Proposal`, any heading level; a word in the text is not a
heading). It sets the spec's flags (`spec.research`, `spec.proposal`). A job asking for both is the orchestration loop of
#537 / #538 in one job: it is told to research first (`withAsks`: the research ask, and that the proposal follows); its
report is reviewed; accepted, the job is re-queued, told so and asked for the proposal, in the same session (`job.requeued`
`reason` names it); the proposal is reviewed; its decision ends the job. A `## Special jobs` heading is the item's own
content: the agent reads it with the rest of the item; it starts no job of its own.

**Stale cleanup and priority** are the section's, by the same code for every review section: the sweep (each tick and at
start) cancels an open item whose job ended or is gone (`<prefix>.cancelled`); every item and event carries the job's live
priority, the open ones list high-priority jobs' first, then the longest waiting.

Tests: `test/sections/sections.test.ts` (the section types and their events, schemas and docs; the research parts, its
marker on the screen and in print mode; what a source item asks for by label and heading; the asks a job is told),
`test/integration/research.test.ts` (Research over the real server: rounds, dig deeper, steer, accept, no reject,
reviewer levels, priority, stale cleanup, ask a job; an item with Research and Proposal headings researched then
proposed in one job; `GET /api/sections`), `test/ui/research-view.test.ts`, and the proposal tests on the shared contract.

## Decider calls (issue #550, 2026-10-09)

Hopper and its jobs make many small decisions. A **decider call** is a bounded choice with a known option set and a
low blast radius. Jev picks it first — before an escalation level, a model or a person — and the decision goes on as
before when Jev's pick is not applied. Jev is not the router (that is the gate router, "Gate router"): it is asked
before anything else at each **decision point**.

**Jev at its seam** (`src/minor-decisions/jev.ts`, `jev_pick.py`): one TypeSafe `Choice` named `decision` over the
point's options (`criteria`: option id → what it means), with the point's instructions and the facts as `state`, model
`jev-latest` (grok-bot-jev's own default) — the call grok-bot-jev's `jev_client` makes, through the `typesafe_sdk` the
image installs (0.7.4). The key is the user's **TypeSafe API key**, kept in the vault's system scope and opened on every
call ("The TypeSafe API key in the vault's system scope", issue #657). No key: Jev is off, nothing is asked and nothing recorded, and every point decides as it did before (an
escalation level, the rules, a person). Every failure — no SDK, TypeSafe refusing, 30 s without a pick, a pick outside
the options — is no pick, never a throw. Not a plugin and not a setting: no option of it is something a person setting
up the hopper knows (issue #217). Tests put a double at the seam (`UserSeams.jev`).

**Decision points.** Each declares its options; the settings are per point, in the database (`minorDecisions`, a user
setting), edited in Settings → Decider (admin), read at every decision:

| point | asked | options | applied |
|---|---|---|---|
| `question-answer` | a question whose text lists at least two numbered options (`1. …`, `2) …`, a dialog's cursor and border aside; the last run of them, numbered from 1), before the first escalation level | each listed option, by its number | the number is the answer (`answeredBy: jev`), typed as a level's answer is |
| `failure-assessment` | a failure the rules hand to a person with no known cause, not superseded, not stale, within the retry limit — after the rules | `retry`, `person` | `retry`: the job runs again by the assessor (`job.rerun`, `by: assessor`; its record `retried`, note `run again: Jev picked it`); its hand-off, opened by the rules, closes as for any run again |

Grouping stays the rules' own (a problem needs failures on several items), so it is not an option. The other decider
calls the issue names — the queue gate and pre-sort, priority and lane choice, phase shifts, stale cleanup, client
repair — are not decision points yet; each one is a new row here.

**Modes.** `off`: Jev is not asked. `shadow` (the default for every point): Jev's pick is recorded next to what was
decided, and nothing else changes. `active`: a pick whose confidence is at or above the point's `threshold` (default
0.85) is applied; below it, the decision goes on as before.

**Never for consequential actions** (`guard.ts`). A decision is consequential when its text matches the question
pipeline's risk rules (delete, deploy and publish, force-push, spend, credentials, sending a message) or names a
permission change (permissions, chmod, chown, grant, revoke, sudo, access to), or when its job's machine is one the
blast-radius gate keeps (`BlastRadius.gates`, issue #542). For a question the text is the question with its options;
for a failure, the job's goal. A consequential pick is recorded (`notApplied: consequential`, with what made it so) and
never applied, whatever its confidence.

**Visible.** Every pick is a `minor_decision.picked` event on its job (and its question): the options, the pick and its
confidence or the error, the mode and threshold, whether it was applied, and why not (`shadow`, `below_threshold`,
`consequential`, `no_pick`). A question's pick is also the first entry of its trail (`role: jev`, outcome `accepted`
when applied). The event stream shows it as one line.

**Agreement.** What is decided after a pick that was not applied is compared with it (`minor_decision.compared`): a
question's accepted answer — a level's or a person's —, read as the option it names (its number or its words; a typed
answer naming none is a disagreement), and a person's end of a failure's hand-off — Run again is `retry`, Clear is
`person` (a hand-off closed by anything else is not compared). A person may override any pick, applied or not
(`POST /ui/api/minor-decisions/picks/:id/override`, operator; `minor_decision.overridden`): what it should have been,
one of its options. It changes nothing already done; it replaces the comparison in the agreement rate. An applied pick
is compared only through an override: what follows it is its own doing. `GET /api/minor-decisions` gives, per point
over the last 30 days, how often Jev was asked, picked, applied, compared, agreed, the agreement rate and the overrides,
and the newest 50 picks; the figures are read from the events, so no table and no migration. An admin flips a point to
active once its rate holds; `minor_decision.settings_changed` records each change.

Open decisions taken as defaults, each one entry to change: every point starts in shadow; threshold 0.85; the
consequential rules are the question risk rules plus permissions; an active failure pick opens the hand-off first and
closes it when it runs the job again (a webhook told of the hand-off sees it close).

Tests: `test/minor-decisions/` (options, the guard, the view from events, Jev through the fake `typesafe_sdk`),
`test/integration/minor-decisions.test.ts` (shadow, active, below the threshold, consequential, Jev failing, a failure
in shadow and active, a known cause, overrides, settings, off, no key), `test/ui/minor-decisions.test.ts`.
## Phase shifts (issue #548, 2026-10-09)

Owner requirement: when a job asks a question, the right response is sometimes "go research this aspect" or "write a
proposal for this first". The question card says so directly, as a **phase shift**: **Research this** and **Propose
this**, next to Send answer, Park, Close and Dismiss, each with an optional note scoping the aspect, in one of two modes.

**Phase** (`src/domain/phase.ts`): a job is in one — `work`, `research` or `proposal` (`JOB_PHASES`). `Job.phase` is set
by a shift; absent, `phaseOf` derives it from the spec (a job asked for research is in research; one asked for a
proposal, or that reached its proposal, in proposal; else work). Every route that answers a job names it (`withPhase`:
`/api/queue`, `/api/jobs`, the shift routes), and the UI shows it wherever a job is named (`JobTitle`: Overview, Queue,
Questions, the sections), unless it is `work`.

**Fork** (`mode: fork`): a separate job asked for research or a proposal about the aspect — the parent's spec with that
one special job's flag, its priority, its payload and work tree, accepted at once (a person or an allowed level asked
for it) — the orchestration loop of #537 / #538. It has **no source of its own**: the sync never reports it to the
parent's item (labels, completion), and `getBySourceKey` never takes it for the item's job. `forkOf` carries the parent
job and question, the kind, the note, the question's text (it is told it, after its job rules: `forkBrief`) and the
parent's source (where it came from in the sections, the repository its work tree holds, the connection it acts through).
The parent records it (`forks`), keeps waiting on its question — which holds no lane and does not expire while a fork of it
runs — or is parked (`forkParent: park`, where its executor can park). Its priority follows the parent's while it runs
(`job.reprioritized`), and the usage limits apply to it as to any job. Accepted, its document answers the parent's
question while that is open (`settleWith`, answered by `fork:<id>`, `forkAnswer`: the document and the notes, "use it
as the answer, or as context"); rejected, the question stays open and waits on a person again, its timeout from now.
`job.forked` on the parent, `job.queued { forkOf }` on the fork, `job.fork_resolved { decision, delivered }`.

**Switch** (`mode: switch`): the question is answered with what the job is to do now (`switchBrief`: research or write
a proposal first, the aspect, the section's ask) and the same job and session move into the phase (`phase`, `shift`:
the question, the note, who, when; `job.phase_changed { from, to, mode: switch, questionId, note, by, reason }`). Its
document is a review item like any (`switchedFrom` names the question). At Accept the person picks what the job does
next (`then`, offered only while the job is in a switched phase of the item's kind — `ReviewItemView.then` lists the
choices — and refused otherwise, 409): `work` — back to the work in the same session with the document as context
(`backToWorkBrief`), the default —, `end` — it ends finished with its decisions as its result —, or, from research,
`proposal` — it writes a proposal next, in the same session, still switched. A rejected proposal of a switched job sends
it back to work, told so. Each move is `job.phase_changed`; `<prefix>.accepted` carries `then`.

**Suggestions.** A job suggests a shift in its question (`Suggest: research — <aspect>` on a line of its own; the
protocol tells every job, `SUGGEST_PROTOCOL`); an escalation level in its reply (`suggest: { to, note }`, the claude-cli
level's schema and prompt). The question carries the first one (`suggestion`, `by` `job` or the level), and the card
offers it as one click in the default mode. Only a person shifts — or a level the settings name (`levels`), which then
shifts the job itself in the default mode (its reply's attempt `accepted`); a level's fork moves the question to a person,
who may still answer it first.

**Rules as everywhere else.** Only a job whose executor runs the research and proposal loop may shift (`Executor.reviews`:
the test executor, herdr-claude, the print-mode agents; `GET /api/health` `reviewingExecutors`); the question's
`shifts` (`QuestionView`) lists the modes the server takes now, or none with the refusal, and the card offers exactly
those. The settings (`GET /api/phase-shifts`, `POST /ui/api/phase-shifts`, admin; settings row `phaseShifts`, read at
each shift; `phase_shifts.settings_changed`): `defaultMode` (`fork`), `forkParent` (`wait`), `levels` (none). No schema
change: the job's new fields are in its body, the settings a settings row.

**Open decisions, as taken** (defaults, all live settings or per-decision choices): D1 the default mode is Fork — it
leaves the original job as it was; D2 under Fork the parent waits on its question (no lane is held while it waits), Park
a setting; D3 under Switch the person picks at each Accept, back to work preselected; D4 a research phase may go on to a
proposal in the same job, and each step is the person's pick at Accept.

**A fork on its question** (issue #570). Owner report: a fork made from a question showed nowhere on it, so it looked as
if nothing happened; the question was reminded "still unanswered", answered directly, and the same feedback given again in
the fork's review, whose acceptance then delivered nothing. The fork and its question are now linked both ways.
`QuestionView.forks` lists the jobs forked from the question (`forksOf`, `src/questions/stale.ts`): each one's kind, note,
job status, `running`, and its review item and status once written; the card shows each as a line ("Proposal in
progress: <note>", its status, a link to its section or, before it wrote one, to the queue). While a fork of a kind runs,
a second fork of that kind is refused (`refusal(q, to, mode)`, 409) and not offered; a switch, or a fork of the other
kind, still is. While any fork of it runs, the question is not reminded (`renotify` checks `forkRuns`, as `expire` does,
and looks again a period later, so a fork that ended without a decision lets the reminders resume). The question can still
be answered directly: inside the settling tx (`forksOnAnswered`, called by the engine's `onAnswered`) each running fork
keeps the answer (`forkOf.answered { answer, by, at }`), and the parent's answer carries `forkRunningBrief` — the fork
still runs, its result no longer comes to it, and its reviewer is told so. The fork is told the answer once
(`forkResume`, at its next start: a fresh start by `forkBrief`, a resume before what it resumes with; `answered.told`). A
fork's review item carries `forkQuestion` (the question's status now, and who answered it), and the item says that
accepting it delivers nothing; `job.fork_resolved` carries `question`, the question's status at the decision. A fork made
from the card toasts "Proposal forked" or "Research forked" with a link, and the jobs and the review section are read
again. No schema change: `answered` is in the fork's body.

Tests: `test/integration/phase-shifts.test.ts` (switch and back to work; research then proposal then end; `then` only in
a switched phase; fork, its link, priority and accepted result answering the parent; a rejected forked proposal; the
settings live; refusals; suggestions by a job and by levels, allowed and not; issue #570: the fork on its question and a
second one refused, no reminders while it runs, a direct answer told to the parent, the fork and the reviewer),
`test/ui/phase-shifts.test.ts`, `test/job-rules/job-rules.test.ts` (a fork's brief with the answer),
`test/plugins/claude-cli-prompt.test.ts` (the level may suggest).

## The TypeSafe API key in the vault's system scope (issue #657, 2026-10-10)

The Jev page said "Jev is off until HOPPER_USER_<ID>_TYPESAFE_API_KEY is set", and nobody could turn Jev on from the
UI. The owner's rule: the hopper keeps its own secrets, entered in the UI and kept in its database, never read from a
variable or a mounted file. The owner's direction on the issue: keep the key in the vault, in a **system scope** that no
job, worker or sandbox can mint, ask for or read, enforced through OpenFGA; the vault's sealer and master key, not a
table or column of its own. Moving the hopper's other secrets into the system scope is issue #658, not this one.

- **The system scope** (`src/domain/vault.ts` `SYSTEM_SECRETS`, `src/vault/system.ts`). A **system secret** is a row of
  `vault_secrets` named `system/<name>` (`system/typesafe-api-key`; since issue #673 `system/artifact-content-key`), a name no vault secret can take (the
  name rule has no `/`). It is sealed by the hopper's sealer under `HOPPER_MASTER_KEY`, bound to `vault:<id>/value`, as
  a vault secret is — under the master key even when the vault's own secrets are under a KMS's data key or in a vault
  container, so only the hopper opens one, in its own process, when it uses it. It is none of the vault's own
  secrets: `GET /api/vault` lists none, `remove` there does not find one, a template that names one is refused (400),
  the rating and a box's scope leave one out, the vault's reseal skips one (the system scope reseals its own), and a
  job's ask for one (`POST /client/vault`) is refused and recorded (`vault.refused`). No schema change: a new row
  name in an existing table. The build before lists such a row in the vault as a plain secret; it gives it to no job,
  since no template holds it.
- **Access** (`src/authz/model.ts`, `Access.decideSystemSecret`). The default model gains `type system_secret` with
  `owner: [user]`, `admin: [user]`, `can_change: owner or admin` and `can_read: owner`. At each ask the hopper tells
  OpenFGA, as contextual tuples for that check only, the user the secret is kept for (`owner`) and, for an admin's UI
  session, that user as `admin`: no stored tuple says either. A change asks `can_change` of `user:<id>`; a job's ask
  asks `can_read` of `job:<user>/<id>`, which the default model never allows. A job's ask is refused even when an
  edited model allows it. OpenFGA not set up, not reached, or a model without these relations: every change is
  denied (403), never a mint. A model the hopper wrote and nobody edited is upgraded to this build's default.
- **The key** (`src/minor-decisions/typesafe-key.ts`). `set` trims the value, checks it once against TypeSafe — one
  Choice over two options through `jev_pick.py`, the call Jev makes, with the key offered (`JevChooser.check`) —, then
  keeps it in place of any key kept. A key the check fails is not kept: 400, TypeSafe's error with the key masked
  (`maskSecret`, `src/secrets/mask.ts`). `remove` deletes it. Jev's readers ask for the key at each decision: the
  decider calls (`createJev({ key })`) and the gate router (the user's runtime secrets answer `TYPESAFE_API_KEY`
  with the key kept, never the variable), so a set, a replace or a removal applies from the next decision, without a
  restart. Events: `vault.secret_set` and `vault.secret_removed`, name `system/typesafe-api-key`, with who; never the
  key. A failed pick's error (`minor_decision.picked`) masks the key too.
- **The view** (`TypesafeKeyView`, `typesafeKey` in `GET /api/minor-decisions`): `set`, the key's last 4 characters
  (`last4`, read from the key at each view), `setAt` and `setBy`; `environment.variable` while the runtime still
  gives the variable; `problem` when no key can be kept or opened (no `HOPPER_MASTER_KEY`). Never the key.
- **The edit** (`POST /ui/api/typesafe-key`, `{ action: 'set', value }` or `{ action: 'remove' }`; least role
  operator, then Access; not cached): answers the view. The Jev page (Settings → Decider) has the field right
  under "Jev is off until a TypeSafe API key is set": a password field the browser does not fill in, Save or Replace,
  and Remove; it shows only "Set — ends in wxyz — set <when> by <who>" or "Not set".
- **The operator CLI** (`hopper typesafe-key`, `set`, `remove`; issue #623's JSON answers): `set` reads the key from
  stdin, never from an argument, so it is in no shell history or process list; an argument is refused.
- **The variable, once.** At each start, while no import is recorded (the user's backfills, `typesafe-key-import`):
  a key the runtime gives as `<secret prefix>TYPESAFE_API_KEY` (or `_FILE`) is kept when none is, unchecked (TypeSafe
  may not be reachable at start), and the log says "imported from the environment into the vault; remove it from the
  environment". Then the import is recorded, and the variable is never read again: a key removed later stays removed.
  While the variable is still set, the Jev page says so.

**Residual risk, stated.** The last 4 characters of the key are shown, as the issue asks. Whoever holds the database
and the master key holds the key, as for every sealed secret.

Tests: `test/integration/typesafe-key.test.ts` (the real daemon and the real Jev with a fake `typesafe_sdk`: save turns
Jev on without a restart; no answer, event, log line or row carries the key; a bad key is not kept and its error is
masked; the one-time import and its note; remove turns Jev off; Access decides; the CLI from stdin),
`test/vault/system-scope.test.ts` (the vault lists none, puts none in a template, gives none to a job, whatever Access
says), `test/authz/model.test.ts`, `test/minor-decisions/jev.test.ts`, `test/ui/minor-decisions.test.ts`.

## The vault's system scope: the hopper's own secrets (issue #658, 2026-10-10)

Before this change the hopper kept its own secrets in four places with four sets of rules: the GitHub connection's
tokens in `connected_accounts` (the token box of issue #441), the webhook signing secrets in `webhooks.secret_sealed`
(the sealer, issue #451), the sign-in realms' secrets in clear in the `sign-in` record (issue #216), and the TypeSafe
API key in the vault's system scope (issue #657). There was no one page, no one audit trail and no one way to replace
one. Now each is a **system secret**, kept, changed, read and audited one way. Owner decision on the issue (the jobs'
hand-off): move all four kinds, including the access token, into the system scope, and make OpenFGA deny any job,
worker or sandbox that asks the vault for one. Since issue #652 no job holds a GitHub token at all: a job's GitHub
goes through the hopper, which reads the token through the vault at each call.

- **Where.** A user's in that user's vault (`vault_secrets`): `typesafe-api-key`, `connected-account.github.access-token`,
  `connected-account.github.refresh-token`, `webhook.<subscription id>.signing-secret`. The whole hopper's in the
  **instance's vault**, a `vault_secrets` table in the instance schema (instance migration 33, a table only):
  `sign-in.<realm>.clientSecret` (oidc, gateway) and `sign-in.<realm>.bindPassword` (ldap). Each a row `system/<name>`,
  sealed by the hopper's sealer under the master key `HOPPER_MASTER_KEY` (issue #659), bound to `vault:<id>/value`, its
  metadata (who, when, its last 4 characters) in the row's body. Never in clear: without the master key (the hopper
  limited) none is kept (503, naming `HOPPER_MASTER_KEY`) or opened, and no old copy is moved; a realm's secret given
  meanwhile stays in the `sign-in` record, as before #658, and a realm whose secret cannot be opened is read as off.
- **One way in** (`src/vault/system.ts`, `SystemSecrets`). `keep` is the only code that writes a value: a set, a
  replace, a GitHub renewal and a webhook rotation; `drop` removes one (a subscription removed, a connection
  disconnected, a realm's secret left out); `migrate` keeps one moved from its old place. `open` is the hopper's read.
  Every part writes through it: `src/connected-accounts/at-rest.ts` (the connection), `src/webhooks/secrets.ts`,
  `src/auth/sealed-secrets.ts` (the sign-in config), `src/minor-decisions/typesafe-key.ts`.
- **Renewals write through the vault with the lock** (`AtRest.swap`). In one transaction: the `connected_accounts` row
  locked (`FOR UPDATE`), the stored refresh token compared with the one the renewal used, then the new pair kept. The
  advisory lock per account (issue #441) still parts processes. So two renewals at once call GitHub once, and the vault
  holds exactly one refresh token, the newest.
- **The sign-in config over the vault** (`sealedSignIn`). Every part reads and writes the sign-in config as before:
  `read` gives each realm its secrets, opened; `write` keeps each secret given (a secret the same as the one kept writes
  nothing), removes each one left out, and stores the record without them, all in one transaction. Its `version` also
  covers when each realm secret last changed, so a secret replaced alone is applied at once and an edit against the
  older version is refused (409). The operator CLI opens the same way with the runtime's key; `config get sign-in` no
  longer prints a secret, and `config set sign-in` checks a record without them as having those the vault holds.
- **The move, once, at start** (`src/users/system-secrets.ts`, `src/users/instance-secrets.ts`). Each old copy is read,
  kept in the vault, opened again and compared, and only then removed: `webhooks.secret_sealed` emptied,
  `connected_accounts` without its tokens (under the account's renewal lock), the `sign-in` record without its secrets
  (before the sign-in config is read). One `vault.secret_migrated` per secret (`name`, `from`), never a value. A start
  with nothing left to move changes nothing. An old copy that cannot be opened (its key is missing) stays where it is,
  said in the log; a connection whose old tokens stay reads unreadable, as before.
- **One audit trail.** `vault.secret_set` (`replaced`; `rotated` when the hopper made or renewed it), `vault.secret_removed`,
  `vault.secret_migrated`, `vault.secret_read` (`by: hopper`, `purpose`: at most once an hour per secret and process,
  `READ_EVENT_EVERY_MS`: the hopper reads the GitHub token at every source poll) and `vault.refused` (a job's ask). The
  instance's events go to every user's log once the runtimes exist, as the update events do. Settings → Vault, panel
  **Hopper's own secrets** (`ui/src/views/vault-system.tsx`): each system secret, the user's and the whole hopper's,
  with what it is for, its last 4 characters, who set it and when, where it is changed, and why it
  cannot be opened; then the newest 50 audit entries (`GET /api/vault` `system`: `secrets`, `audit`). Never a value.
  Each keeps its own page for changes: Sources (the connection), Webhooks (replace, rotate), Sign-in (the realm's
  form), Decider (the TypeSafe key).
- **No job, worker or sandbox reads one.** A job's ask (`POST /client/vault`) for any `system/` name asks Access
  `decideSystemSecret` (`system_secret#can_read` of the job), which the default model never allows, and is refused
  (`vault.refused`) whatever it answers; no template may name one and none is minted from. `test/authz/system-secrets.test.ts`
  asks for every kind as a job, as its machine and as a box of an approved template: each denied.
- **The start check** (issue #647, requirement 8 of this issue). Each system secret that cannot be opened logs
  `start check: system secret <name> cannot be opened: …`, naming `HOPPER_MASTER_KEY` when the launch gives none, else
  the key id it was sealed under; the panel says it too. It never asks for a new value.
- **The key stays outside.** The master key comes from the launch (issue #659), never from a vault. With
  `HOPPER_KMS_URL` or `HOPPER_VAULT_URL` the vault's own secrets are under the KMS's data key or in the vault container;
  the system scope stays in the hopper under the master key. The master key's start check counts the system secrets
  of every user's vault and of the instance's (`keptSecrets`).

**Not built here, carried (issue #658, requirement 6):** a system secret kept in a vault backend (HashiCorp Vault,
1Password, Bitwarden). A backend reads at the moment of use and asynchronously, and the hopper only reads from one;
the GitHub tokens are written at each renewal, and the sign-in config and a webhook's signature read synchronously.

**A build before this one on a moved store** (`docs/deploy.md` "Update channels and promotion"): it finds no GitHub
tokens in `connected_accounts` (the connection reads unreadable: reconnect), no webhook secret (replace it), and no
realm secret (a realm that is on and needs one stops that build at start). Builds since issue #527 refuse a store a
newer build migrated anyway.

Tests: `test/integration/system-scope.test.ts` (the real daemon on a store from before: each secret moved, sealed, its
old copy gone, one event each, GitHub, the webhook's signature and the realm still working; a second start changes
nothing; the view and its audit, no value), `test/vault/system-secrets.test.ts` (keep, rotate, the read event once an
hour, nothing kept without the master key, a new key sealing again, the start check, the move), `test/authz/system-secrets.test.ts` (OpenFGA
denies a job, its machine and its box every kind), `test/vault/system-scope.test.ts` (every kind refused to a job),
`test/connected-accounts/rotation.test.ts` (a renewal through the vault keeps exactly one refresh token),
`test/auth/sealed-secrets.test.ts` (the sign-in config over the vault), `test/ui/vault-system.test.ts`.

## Access: OpenFGA decides each mint (issue #559, 2026-10-09)

The vault (issue #558) will hand jobs short-lived credentials. Before it mints or renews one, it asks **access**
(`src/authz/`) whether the job may have it: a relationship check in [OpenFGA](https://openfga.dev/), evaluated at
request time, instead of permissions baked into a token. Revoking an approval bites on the next request; nothing
already minted is widened, and minted credentials are short-lived. This builds the decision point; the vault's
first-time gate is #584's ("A template's blast radius") and the minting is #580's ("Minting: short-lived
credentials"), which calls it.

**The entry point** — `Access.decideMint(request)` (`src/authz/service.ts`, the app's `access`), with
`MintRequest` (`src/domain/access.ts`): the **requester** (issue #581: a job, a machine or a user), the operation and the
asset. The template is not in the request: it comes from the requester's relations below.
It answers a `MintDecision` — `allowed`, `reason`, the relationship `path` when the hopper can name it, the
OpenFGA model asked — and records it, with the requester and the template it runs as. The vault calls it before every
mint and every renewal, and mints nothing unless `allowed`; the template comes from the machine's join line, never from
the job's prompt. The skill broker (issue #582) asks it for the job.

**The types the model needs**, kept minimal for the vault to adopt or extend (`src/domain/access.ts`):

| type | | OpenFGA object |
|---|---|---|
| template | a kind of machine a job runs on, by name (`TEMPLATE_NAME`) | `template:kubectl-diag` |
| operation | `read`, `write`, `sync`, `apply` | — |
| asset | `cluster`, `namespace` (`<cluster>/<namespace>`), `argocd-app`, `terraform-workspace`, `aws-account`, `aws-role` (`<account>/<role>`), and a name (`ASSET_NAME`: OpenFGA takes no `:`, `@`, `#` or space in an id, so not an ARN) | `asset:cluster/x` |
| operation profile | an operation on an asset | `operation_profile:read/cluster/x` |
| job | one run of a job: the issue's *session* (*UI session* is taken, glossary) | `job:<user>/<job>` |
| user | a person the hopper works for (issue #581) | `user:<user>` |
| machine | a machine jobs run on, of one user; its name escaped (`encodeURIComponent`: OpenFGA takes no space, `:` or `#`) | `machine:<user>/<name>` |

The issue's *target* is an **asset** here: *target* is an attached machine (glossary).

**The model** (`src/authz/model.ts`, `DEFAULT_ACCESS_MODEL`, OpenFGA DSL; a tuple reads *subject relation object*):

```
type user
type job                 owns: [user]                      # user:u owns job:u/j
type machine             runs_on: [job]; owner: owns from runs_on          # job runs_on machine
type template            running: [job]; instance_of: [machine]            # machine instance_of template
                         requester: running or instance_of or runs_on from instance_of or owner from instance_of
type operation_profile   approved_for: [template]; requester: requester from approved_for
type asset               grants_<op>: [operation_profile]; can_<op>: requester from grants_<op>
```

An approval is two tuples (`approvalTuples`): the profile `grants_<op>` the asset, and the template is
`approved_for` the profile.

**Requesters** (issue #581; the issue's *identity*, but *identity* is who signed in, glossary). A check starts from the
requester that asks — `job:<user>/<job>`, `machine:<user>/<name>` or `user:<user>` — `can_<op>` `asset:…`, and follows the
tuples the hopper writes from **who is live** (`requesterTuples`): a user `owns` each of their live jobs (`claimed`,
`running`, `waiting_answer`); a job `runs_on` the machine it runs on (its lane's, else where it resumes); a box is an
`instance_of` the template its join line named. So a job reaches a template through its box, a box through its join,
and a user through their live jobs; a job on a machine of no template reaches none. Who is live comes from each user's
store through the composition root (`AccessOptions.requesters`, the vault's `boxes()`); nothing is stored for it. It
is pushed with the approvals: within 2 s of a change (`REQUESTERS_CHECK_MS`: a job started or ended, a box joined or
left) and before every check, which asks OpenFGA only once it holds who is live now. A requester that is not live is
denied before OpenFGA is asked: a job not live, a machine that is no box of a template now, a user the hopper does not
have. A check tried in Settings → Access still tells a made-up job `running` from the template as a contextual tuple.
Not built (later, #241, #242): admin roles; a template is named by its name alone, so two users' templates of one name
share their approvals.

**The model kept.** The default model of #559 lacked the requester relations. At start, a newest model the hopper wrote
(`writtenBy: hopper`) that lacks a relation this build writes is replaced by this build's default, as a new version.
One a person edited is kept: until a model with the relations is saved, the push stops and every check is denied, the
status saying what it lacks.

**The hopper's database is the source of truth** (migration 29, instance schema; `src/store/access.ts`):
`access_models` (each saved model, its version the row), `access_tuples` (every tuple pushed, a revoked one kept
with who and when), `access_state` (OpenFGA's store id and the model pushed there), `access_decisions` (every
decision). **Push** (`sync`): the store (made when OpenFGA holds none by the kept id — a new OpenFGA is filled from
the database), the model when the store or version changed, then the tuples: what OpenFGA holds and the database
does not is deleted, what it lacks is written — the approvals, and the tuples of who is live. At start, after every change, and every 30 s, so drift is put back
and an OpenFGA come back is found. One push at a time.

**Fail closed.** Every mint is denied, and recorded, when: no OpenFGA is set up; OpenFGA cannot be reached or
refused what was pushed; a change is not pushed yet (a revoke OpenFGA has not taken: the next check pushes first,
and denies when it cannot); the requester is not live; the model lacks a relation the hopper writes; the request names no template, operation or asset the model can
hold. The status (`not-configured`, `connected`, `unreachable` with why) is logged once per change of reason and
shown in Settings → Access.

**The relationship path.** OpenFGA's check answers only allowed or not. On an allow, the path is the hopper's
reading of its own live tuples: (for a job, its owner first) the user owns the job → the job runs on the machine → the
machine is an instance of the template → the template is approved for the profile → the profile grants the operation on
the asset; for a tried check, the made-up job runs from the template. When a model edit allowed it another way, no path
is given.

**Settings → Access** (`GET /api/access`, `POST /ui/api/access`; the instance admin's alone, issue #240): the
status; each template's approvals with the chain and **Revoke** (asked once), and its blast radius with the reasons
(issue #584, "A template's blast radius"); the revoked ones; **Try a check** (a
made-up live job of a template, asked of OpenFGA as for a real credential and recorded as a trial); the newest
decisions; a link to the **permission matrix** (below); and the model, saved against its version. An edit must keep every relation the hopper writes or asks
(`modelGaps`), and OpenFGA must take it when it can be asked; it applies from the next check. `approve` is in the
API for the vault's gate (#558) to write; the UI offers no approve, since that is the gate.

**Settings → Permission matrix** (`#settings/permissions`, the instance admin's alone): the same `GET /api/access`,
as a table of who may do what on which asset. Rows: each template — with its blast radius — followed by its boxes, then
every user; switched, the live jobs (with their machine and template). The rows besides the templates are the
**requesters** (issue #581, `AccessView.requesters`), each with the profiles it reaches and the path. Columns: the assets an
approval names or a template waits on, grouped by kind. A cell holds the approved operations, and apart (dashed) the
declared operation profiles of the row's template that wait for approval (issue #584). A click on a cell opens why: the
relationship path (for a job, its owner first), who approved it and when, and **Revoke** (asked once, the same `revoke` as
Settings → Access: the next check is denied). Filters: asset kind, operation, a name, only the rows with access; the header
rows and the first column stay in place on scroll. A cell is the hopper's reading of its own rows, as the requesters are: a
model edit can allow more. The matrix model is pure (`ui/src/model/permission-matrix.ts`). It replaced the hover-only
"Who may do what" table of #581 on Settings → Access.

**OpenFGA itself** is `HOPPER_OPENFGA_URL`, with the preshared key `HOPPER_OPENFGA_KEY` (or `_FILE`) from the
runtime, read at each call (`src/authz/openfga.ts`, `@openfga/sdk`, no retries). Recommended, and in `compose.yaml`:
the `openfga/openfga` image as two rootless containers beside the hopper — `openfga-migrate` (once per version) and
`openfga` — with its tables in the `openfga` schema of the hopper's Postgres and its config and key made by the
postgres service. Not bundled into the hopper's image: OpenFGA is a Go server with its own release cadence and
migrations, and a second process in the hopper's container would need a supervisor. Tests put a double at the seam
(`AppSeams.authorizationServer`, `test/support/fake-authorization-server.ts`, which evaluates the model's JSON);
`test/authz/openfga-real.test.ts` runs against a real one when `HOPPER_TEST_OPENFGA_URL` is set.

Tests (issue #581): `test/integration/access-requesters.test.ts` (a real joined box: a job on a box of an approved
template allowed with the path user, job, machine, template; the box and the user too; a box of a template not approved
denied; a job's tuples gone when it ends and a box's when it leaves, each next check denied; the matrix rows),
`test/integration/access.test.ts` (a job on a machine of no template denied; the default model of #559 replaced at start,
an edited one kept and denied until saved again), `test/authz/model.test.ts`, `test/store/migration-31.test.ts`
(a decision recorded for a job names it as its requester), `test/ui/access-view.test.ts`.

Not yet: retention of `access_decisions` (they grow like the event log). The vault's issuance audit is its
`vault.minted` event, which names the decision's id (issue #580).
## Machine resources over time (issue #560, 2026-10-09)

Owner request: the same kind of over-time graph the usage history has, for machine conditions — CPU and memory as well
as disk. Before, the hopper read only plan usage and a machine's disk (for the low-disk hold, issue #410).

**Reading on the machine.** A machine's snapshot carries `resources` (`ResourceReading`, `src/domain/machine-history.ts`):
cores, CPU busy (share of CPU time busy since the read before; none at a first read), load averages (none on Windows),
memory total and available (available, not free), and swap total and used where it is read. Who reads it:
- **this machine**: the meter `src/client/resources.ts` at every list; a read less than a second after the last keeps the
  last CPU busy, so a burst of Decisions is not noise. Linux reads /proc/meminfo; Windows and macOS the OS (Node's
  `os`), with no swap.
- **a client target**: its client, with the same meter, in its `/release` answer (`resources`), checked by
  `resourcesOf` (`src/machines/resources.ts`) before it is believed. CPU busy is over the time between two probes
  (30 s). A client older than this says none; its next update loads the meter like any client file.
- **an ssh target**: its probe prints two `/proc/stat` cpu lines a second apart, `/proc/loadavg`, the memory lines and
  the core count, each marked `hopper-res ` (`RESOURCES_COMMAND`); a machine with no /proc prints none. The second's
  wait is in the probe's background call, never in a Decision.
- **in a container**: a meter whose cgroup (v2) sets a memory limit reads the limit as its total and its own use less
  the page cache it could drop (`inactive_file`); a CPU quota is its cores, and CPU busy is its own `usage_usec` against
  the quota. `container: true` says so; the card says "container limit". A container target (docker exec) is not read,
  as its disk is not.
- Per lane (an agent's process tree): not built.

**Recording.** Each user runtime runs a **resource recorder** (`src/machines/history.ts`), on the usage recorder's loop
(`createRecordLoop`, `src/usage/history.ts`): every minute it lists the user's machines and keeps a **machine sample**
of each one online with a reading — CPU busy, load (1 min), cores, memory, swap, disk, its lanes in use and its lane cap
— in the user schema (tenant migration 26, `machine_samples`, unique per machine and time; a table only, so the build
before runs on it). An offline machine adds nothing; the graph shows the stretch as a gap. New samples are told on the
stream (`machine.recorded`, `{ added }`). The **history retention** is the usage history's: one setting, both pruned
every hour, both at once when it is lowered (`POST /ui/api/usage-history/retention`). At one sample a minute, four
machines for 90 days are about 520 000 rows, aggregated in SQL per step.

**The resource graph** (`GET /api/machines/history`, every machine; `GET /api/machines/:id/history`, one). The query is
the usage graph's (`range` or `from`/`to`, `tz`); no saved view, default the last day. Its **resource step** is finer
than the usage graph's, since a machine is read every minute (`resourceStepMs`): 15 minutes up to a day, an hour up to
4, 6 hours up to 14, a day up to 60, else a week. Per machine and step, each resource's peak share: CPU busy, memory
used (1 − available / total), swap used, disk used, lanes in use / lane cap. Gaps by the usage history's rule: a
stretch with no sample longer than 3 × the machine's usual spacing (at least 5 minutes).

**UI.** The usage graph card (`ui/src/components/usage-graph-card.tsx`) draws it, with its own lines (`linesOf`,
`ui/src/model/machine-history.ts`) and redrawn on `machine.recorded`. On Machines, each card says CPU and memory now,
draws a CPU sparkline of the last day, and *Resources over time* opens its graph: CPU, memory, swap, disk and lanes in
use, one colour each (lanes dashed). On the Usage page, *Machine resources over time* sits under the usage limits, at
the same day range as their usage line: every machine one colour, CPU solid, memory dashed, disk dotted; swap and lanes
hidden until shown from the legend.

**Not built yet** (the issue's second step): soft and hard CPU and memory thresholds per machine, a machine taking
fewer new lanes above soft and no new job above hard (like the disk hold), off by default until the graphs have shown
sensible levels.

Tests: `test/client/resources.test.ts` (CPU busy between reads, memory available, swap, Windows and macOS, cgroup
limits, the host when a cgroup sets none), `test/adapters/machine-resources.test.ts` (the ssh probe's lines, a client's
answer checked), `test/adapters/ssh-machine.test.ts` (the probe answers them), `test/integration/machine-history.test.ts`
(the snapshot carries them, one sample per online machine, none offline, per-step peak, gaps, the finer step, every
machine and one, `machine.recorded`, the shared retention), `test/ui/machine-history.test.ts` (the lines, colours and
dashes, the sparkline, the card's text).

## GitHub through the hopper (issue #563, 2026-10-09)

Owner requirement: a job that needs a GitHub operation — filing an issue, most often — must not log in to GitHub
itself. It reached for `gh auth login`, the device flow, which spends device codes (GitHub keeps about ten open at a
time) and leaves a GitHub login on every machine. Instead the hopper is the proxy: the job asks the hopper, and the
hopper does it with its own GitHub credentials, or says plainly why not. The motivating case: a job of another user,
on another machine, told to file an issue on the hopper's own repository — treated as untrusted.

**The hopper's credentials** are its oldest user's **connected account** (the instance's first user, whose runtime the
plugin store also reads): the GitHub connection that set the hopper up. Never handed to a machine for this: a job gets
a **proxy token**, not a GitHub token. (A job of a connected account still runs with that account's token for its own
pushes and `gh` calls, issue #441; this changes nothing there. #558 takes tokens off the machines.)

**The way in.** At each start, resume and turn (`ExecutionContext.credentials`) the engine keeps two more files in the
job's credentials dir on its machine (`placeCredentials`, `src/engine/credentials.ts`), through the machine's connection
like the connected account's (issue #441), and sets three variables:

| variable | value |
|----------|-------|
| `HOPPER_TOKEN_FILE` | `<credentials dir>/hopper/token`: the **proxy token** |
| `HOPPER_GH` | `<credentials dir>/hopper/gh`: **hopper-gh**, run as `sh "$HOPPER_GH" …` |
| `HOPPER_URL` | the hopper as the machine reaches it: a client target, the URL it dialled in at (the Host of its `GET /client/connect`, or the public URL behind it; `MachineLinks.urlOf`); this machine, `http://127.0.0.1:<port>`; an ssh or container target, `HOPPER_PUBLIC_URL`, else `http://<first LAN name>:<port>` |

A machine that reaches the hopper at none of these, or whose connection keeps no files, gives its jobs no proxy (said in
the job's progress when files could not be kept). The token is never in an environment variable, a command line or the
database: `hopper-gh` sends it to curl on stdin (`-H @-`).

**The proxy token** (`src/github-proxy/token.ts`): `<user id, base64url>.<job id>.<mac>`, the mac an HMAC-SHA256 of the
job id under a key HKDF-derived from the user's link key (issue #308) and user id. Derived, never stored: the same at
every start of the job, so a restart or a renewal changes nothing on the machine. Honoured only while the job is
`running` or `waiting_answer`; a token of an ended job opens nothing. (`AGENTS.md`: "a token or code it mints is only
hashed" — this one is not even kept.)

**`hopper-gh`** (`src/github-proxy/script.ts`): POSIX sh and curl, nothing else, so it runs on any machine a job runs
on. `issue create|comment|view`, `pr create|view`, `help`. Arguments become `--data-urlencode` form fields, rebuilt in
place (no `eval`); `--body-file` is read by curl. It prints the hopper's JSON answer and exits 1 on a refusal or a
GitHub failure, 2 on a bad call. Its `help` is the whole manual: the job is told one protocol line
(`GITHUB_PROXY_LINE`, `src/job-rules/`) and reads the rest only when it needs it.

**`POST /job/github`** (`src/http/job-github.ts`): outside the UI session, behind the Host guard, like a machine's join
(`AGENTS.md`). `Authorization: Bearer <proxy token>`; the request as a form (what `hopper-gh` sends; the form parser is
registered on this route only) or JSON. The broker (`src/github-proxy/broker.ts`), in order:

1. the token: its user's runtime, its link key, its job, at work — else **401**;
2. the request's shape (`proxyRequest`, strict: no labels, no assignees, GitHub's length limits) — else **400**;
3. who asks (`checkRequest`, `src/github-proxy/policy.ts`): the repository must be one of the hopper's user's **job
   repositories**; the hopper's **own job** (a job of that user) may ask every operation, a pull request only on its own
   repository (its source's, a fork's parent's); **another user's job** only `issue.create` — else **403** with the reason;
4. the hopper's GitHub connection: none, or its sign-in ended — **503** saying so;
5. the rate limits (`src/github-proxy/limits.ts`, per hour, per job and per machine: `issue.create` 5 and 20,
   `issue.comment` 20 and 100, `pr.create` 3 and 20, reads 120 and 600; in memory, a restart starts them again) — **429**;
6. GitHub (`src/github-proxy/api.ts`: one REST call, `pr.create` without `--base` first reads the default branch; a 401
   renews the token once) — **200** `{ ok, op, repo, requestId, number, url, … }`, or **502** with what GitHub said.

**An issue filed through it** is the job's text, under the publishing rule, plus the hopper's note at its end:
"Filed through hopper for job `<job id>` (request `<request id>`). It is not a job: it waits for a person to triage it."
It is never labelled or assigned — the request cannot carry either — so no source takes it (intake is by the `hopper`
label and the assignee, issue #387): a job cannot spawn a job; a person labels it. **Ids only on GitHub.** The owner
asked for the machine and the user in the issue; the repo law ("GitHub text is neutral") and the publishing rule forbid
both, so the issue names the job and the request, and the event under that request id has the machine and the user.

**Audit.** Every outcome but a token that names no job is an event on the job's timeline: `github_proxy.done` (`op`,
`repo`, `number`, `url`), `github_proxy.refused` (`reason`) or `github_proxy.failed` (`error`), each with `requestId`,
`machine` and `own`. For another user's job the same event also goes to the hopper's own user's log, with `forUser` and
`job`: the owner of the credentials sees everything done with them. A token that names no job is logged only.

**Steering a login** (`src/executors/herdr/login.ts`). A herdr-claude job that reports a GitHub login (HOPPER_AUTH_PENDING
with tool `gh…` or a `github.com/login/device` URL, `isGitHubLogin`) is not taken to the Logins: it is told, in its pane,
to stop the login without entering the code and ask the hopper (`githubLoginNote`), as a job is never left blocking on
input (#533). Reported again at once — the proxy is not set up there, or cannot do what it needs — it goes to the
Logins as before (issue #476), so a person still decides. A print-mode run is not steered: it cannot be typed into.

**Not built.** The identity checks are the policy above, behind one function, until #559 (OpenFGA) decides them. The
skill catalog of #559 ("what can you set up for me?") is issue #582's: `hopper-gh`'s help is its `github` skill. No UI of its own: the events
show on the job's timeline and the event log. Rate limits are not settings.

| dir | owns | must not import |
|-----|------|-----------------|
| `src/github-proxy/` | the token, the policy, the limits, the GitHub calls, `hopper-gh`, the broker | engine, http, store, plugins, decider |

Tests: `test/integration/github-proxy.test.ts` (the real daemon and a fake GitHub on loopback; the job runs the real
`hopper-gh` against it: an issue filed, unlabelled and marked, never a job; a repository refused; comment, read, pull
request and its GitHub failure; a pull request on another repository refused; another user's job files an issue and
nothing else, both in the hopper's own user's log; a bad token and an ended job refused; the help and no GitHub token on
the machine), `test/github-proxy/proxy.test.ts` (token, request, policy, limits, the broker's 400, 429, 503),
`test/herdr/executor-login.test.ts` (a GitHub login steered, then taken when reported again).

## Git through the hopper: a job holds no owner credentials (issue #652, 2026-10-10)

Owner requirement (the 2026-10-10 intake security review, paths A + C + F; this part builds F and the prompt and merge
rules): one bad issue, or one injected agent, must not be able to change `dev`, the published image or the hosts. Until
now each job of a connected account got that account's token (`gh/hosts.yml`, `GH_CONFIG_DIR`, `GH_TOKEN` where no files
are kept — issues #214, #441, #647), the host's ssh agent, and whatever git credentials its machine had, so the GitHub
proxy (#563) restricted nothing. **A job now holds no GitHub token.** Removed with no shim: `JobSource.credentials`,
`JobCredentials`, `engine.renewCredentials`, the connected account service's `onToken`, `Job.credentialsDir` and
`Job.credentialsWarning` (and its card line), and the job worktree script's `GH_TOKEN` / `gh auth git-credential` helper.
The connection's token is read by the hopper at each call it makes, so a renewal reaches nothing on a machine.

**The way in.** Beside the proxy's three variables (above), `placeCredentials` gives every job whose machine keeps files
git's own configuration from the environment (`jobGitConfig`, `src/github-proxy/git.ts`; `GIT_CONFIG_COUNT`,
`GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`):

| key | value |
|-----|-------|
| `url.<HOPPER_URL>/job/git/.insteadOf` | `https://github.com/`, `git@github.com:`, `ssh://git@github.com/` (the connection's web origin and host) |
| `credential.<HOPPER_URL>/job/git/.helper` | empty (clears every helper before it for that URL), then a shell function that answers `get` with `username=hopper-job` and the content of `$HOPPER_TOKEN_FILE` as the password |

So `git clone https://github.com/o/r`, `git fetch` and `git push` in any checkout — the job worktree's, a person's
checkout the job works in — go to the hopper, and the proxy token is read from its file when git asks, never put in a
variable or on a command line. A machine that reaches no hopper URL, or whose connection keeps no files, gets no proxy:
its git uses what that machine has, said in the job's progress (as before).

**The route** (`src/http/job-git.ts`): `GET /job/git/<owner>/<name>.git/info/refs?service=git-upload-pack|git-receive-pack`
and `POST /job/git/<owner>/<name>.git/git-upload-pack|git-receive-pack`, git's smart HTTP, behind the Host guard,
outside the UI session, like `/job/github`. Bodies are read whole (up to 512 MB) under their own content-type parsers.
The broker (`createGitProxy`, `src/github-proxy/git-broker.ts`), in order:

1. the token: the Basic auth password is a proxy token of a user whose job it names, at work — else **401** (git then
   asks its helper once more and stops);
2. the path: `owner/name` (`.git` optional) and a smart-HTTP service; dumb HTTP is not served — else **404**;
3. a push (`git-receive-pack`): only to the job's **own repository** (its source's, or for a fork its parent's), and only
   when that is one of its user's **job repositories** — else **403** with the reason, which git shows as `remote: …`;
4. the job's user's GitHub connection: none — **403** for a push or a job repository, **503** otherwise;
5. a push's ref updates, read from the pkt-lines before the pack (`receivePackCommands`; gzip is opened; a signed push or
   a shallow one is not taken) and checked (`checkPush`): only `refs/heads/*`, never the repository's default branch
   (read from GitHub) or a **release branch** (`main`, `master`, `dev`, `beta`, `stable`), never a delete. A forced update
   of a branch of the job's own work is allowed: a rebase pushes with `--force-with-lease`. A refusal is answered as
   git's own report (`ng <ref> <reason>`, in side band 1 when asked for), so git shows `! [remote rejected] … (<reason>)`;
6. GitHub: the request as git sent it, to `<web origin>/<owner>/<name>.git/…`, with Basic `x-access-token:<token>` of the
   job's **own user's** connection (not the hopper's oldest user's: a push is the job's user's act), the response streamed
   back. A 401 renews the token once. A fetch of a repository the user's jobs do not use goes **without credentials**,
   as anyone's would: a public repository clones, a private one does not.

**Audit.** A push is an event on the job's timeline: `github_proxy.done` (op `git.push`, `repo`, `refs`),
`github_proxy.refused` (`reason`, `refs` once read) or `github_proxy.failed`. A fetch is not recorded.

**`hopper-gh` additions** (the job has no `gh` login to do them with): `issue close N` — the job's **own issue** only, as
completed (`PATCH … state_reason: completed`); `pr ready N` — on its own repository, through GitHub's GraphQL
`markPullRequestReadyForReview`. Both refused to another user's job. The finish brief of a draft (issue #626) now says
`sh "$HOPPER_GH" pr ready <n> --repo <owner/name>`.

**The ssh agent.** `scrubbedEnv` drops `SSH_AUTH_SOCK` and `SSH_AGENT_PID`, so the herdr server the hopper starts, its
panes and the command and print-mode executors never see the host's agent; a herdr server started as a systemd unit
(which inherits the user manager's environment) runs under `env -u SSH_AUTH_SOCK -u SSH_AGENT_PID`. The hopper's own ssh
to targets already used `IdentityAgent=none`.

**The prompt** (`src/sources/github/context.ts`): the issue's title, body and the assignee's recent comments go inside
the **untrusted issue text** block — `UNTRUSTED_LINE`, then `<<<hopper-untrusted-issue-text`, the text, and
`hopper-untrusted-issue-text>>>` — with the markers removed from the text, so it cannot close the block early. The
hopper's `[hopper issue context]` follows: repo, labels and author, priority, the `done:` line. Caps as before: the body
64 000 characters, the comments 16 000, the oldest dropped first.

**Yolo mode's merge** needed a check that passed: `checks` `passing`; a pull request with none waited. Issue #677 changed
this: no checks, settled, is ready ("No checks means ready"). The job is told
the hopper merges it and not to merge it itself.

**Residual risk, said plainly.** On a machine where a job runs as a person's own account (this machine, an ssh target),
the files in that account's home — `~/.ssh` keys, a gh login, git credentials — are readable by the job: only a sandbox
box (#603) keeps them out. The git rewrite routes GitHub through the hopper, but an agent that reads a key file directly
is not stopped by it. A push may overwrite any other branch of the job's own repository that is not the default or a
release branch: branch protection on GitHub (the next part of this issue) is what keeps the rest.

**Not built in this part** (carried in issue #652): trusted actors and request cards (A, C), re-reading an edited issue,
the backfill; the vault helper given only on a per-job grant; yolo merging only jobs of a trusted origin; the repository
setup check and pull-request checks workflow; deploying only a merged and checked commit.

Tests: `test/integration/git-proxy.test.ts` (the real daemon, a fake GitHub serving git with `git-http-backend`, the real
git with the job's variables: clone and push a branch with the user's token, a forced update; `dev` and `stable` refused
and a delete refused, nothing changed on GitHub; another repository refused; a repository outside the job repositories
read without credentials; a bad token and an ended job refused; no `GH_TOKEN`, `GH_CONFIG_DIR` or `SSH_AUTH_SOCK`),
`test/github-proxy/git.test.ts` (the pkt-lines, the push check, the path, the git config),
`test/integration/github-proxy.test.ts` (close the job's own issue, mark ready, another issue refused),
`test/integration/connected-account-renewal.test.ts` (a source job's variables and files hold no token),
`test/sources/github-context.test.ts` (the untrusted block, its markers removed), `test/integration/pull-requests.test.ts`
(no checks: not merged until a check passed), `test/herdr/session.test.ts` (the server starts without the ssh agent).

| dir | owns | must not import |
|-----|------|-----------------|
| `src/github-proxy/` | also git through the hopper: the path, the push check, the job's git config, the git broker | engine, http, store, plugins, decider |

## Writing style: Simplified Technical English (issue #571, 2026-10-09)

Owner direction: everything the hopper's agents write for people — questions, proposals, research reports, Needs a
person notes, summaries, pull request and issue text — is in Simplified Technical English (ASD-STE100). A writing
style, not a process: no review agent, no rewriting pass, no gate, no check by Jev or the escalation levels.

- **The line.** `STE_RULE` (`src/job-rules/`), the last line of the default job rules: "[hopper writing style] Write
  all text for people in Simplified Technical English (ASD-STE100): short sentences, one instruction per sentence,
  active voice, simple common words, one meaning per word." The job rules are the owner's to edit; saved job rules
  carry it only if the owner adds it.
- **The protocol.** The fixed question line and the research and proposal protocol lines (`REVIEW_SECTIONS`) name STE
  in a clause, and so do the research and proposal asks, so a job writes them in STE whatever its saved job rules say.
  No dictionary or rule list goes into a prompt.
- **What follows.** A summary a model writes for people later (the short summary of issue #569) names STE in its own
  prompt the same way. If adherence is poor, that is raised again; nothing checks it now.

**Verification.** `test/job-rules/writing-style.test.ts`, `test/herdr/screen.test.ts` (the footer verbatim).

## The vault (issue #558, 2026-10-09)

Owner request: a vault inside the hopper for one job — getting secrets to box containers safely. Owner clarification
(issue #558): local to the hopper, not an outside key service and not a replacement for one. The accepted proposal
builds it in three slices, one pull request each; the scope comment on the issue lists what is not built (an outside
key service, minted short-lived credentials, per-operation profiles, boxes the hopper launches itself).

1. **Write-only vault secrets** (this section, below).
2. **Templates**: an image and the vault secrets its boxes may ask for, approved once by a person; the scope comes
   from the template, never from the job ("Templates (slice 2)" below).
3. **Delivery**: a box's job asks the hopper client over a socket; the client asks the hopper over its signed link with
   a job-bound token, as the GitHub proxy (issue #563) does; nothing in the environment or on disk ("Delivery to the
   box (slice 3)" below).

### Write-only vault secrets (slice 1)

A **vault secret** is a name (a letter, then letters, digits, `_`, `.`, `-`; at most 64), an optional **scope** (one
line, at most 200 characters: what it reaches, in the words of whoever set it) and a value (1 to 64 KiB). An admin sets,
replaces or removes it in Settings → Vault (`POST /ui/api/vault`, `set` / `remove`). `GET /api/vault` and the edit's
answer carry each secret's metadata — id, name, scope, who set it and when, who last changed it and when — and never a
value, to any role; both are `cache-control: no-store`. The page's value field is a password field the browser does not
fill in or remember.

**Kept** in the user schema's `vault_secrets` (tenant migration 28, a table only: the build before runs on it): the
metadata as JSON in `body`, the value in `sealed`, sealed by the sealer ("Sealed in the database") under the master key,
bound to `vault:<id>/value`. The id, not the name or the user, so a fold of one user into another keeps it, and a value
copied to another row does not open. `sealed` is read only by the vault service, never into a secret's metadata. A
database dump holds no value; a copy of the hopper's container or image holds none either (the master key is given at
launch, issue #659). A key rotation seals every vault secret again at start, as it does the webhook secrets
(`resealAll`, logged as a count). No key: nothing is stored (503 naming `HOPPER_MASTER_KEY`) and the page says why.

**Never carried**: an event (`vault.secret_set` — `name`, `by`, `replaced` — and `vault.secret_removed` — `name`, `by`),
a log line, an error text or a webhook delivery (deliveries are events). No job prompt is given one: nothing in this
slice reads a value but the sealer's own check of a rotation.

**Seams.** `src/domain/vault.ts` (the types and limits), `src/store/vault.ts` (the table), `src/vault/service.ts`
(set, remove, view, reseal: the only code that seals a vault value), `src/http/vault.ts` (the read),
`src/http/ui/vault.ts` (the edits, admin), `ui/src/views/vault.tsx` and `ui/src/model/vault.ts` (the page).

| dir | owns | must not import |
|-----|------|-----------------|
| `src/vault/` | the vault: its secrets set, removed, listed as metadata, sealed again on a key rotation; its templates saved, approved and asked what a machine may be given (`scopeOf`); since issue #586 its key provider chosen (`keys.ts`), the KMS at the `KeyService` port (`kms.ts`, @aws-sdk/client-kms), and the vault in a container of its own: its server (`server.ts`, `main.ts`), the hopper's client of it (`remote.ts`), their wire (`wire.ts`); since issue #580 whose ask a box's ask is (`box.ts`), minting through Access (`mint.ts`) and the minting adapters, STS and the Kubernetes API (`minter.ts`); the credential requests a skill load opens (`requests.ts`, issue #583, "The dynamic vault"); the system scope (`system.ts`, `system-read.ts`, issue #657, "The TypeSafe API key in the vault's system scope") | engine, http, plugins, decider, executors |

Tests: `test/integration/vault.test.ts` (the real daemon: set and replace never answered back, sealed in the database;
every read route the API reference documents asked with an admin session, none carrying the value; no value in an event,
a log line or an error; no session refused; no key 503; a key rotation seals again), `test/ui/vault.test.ts` (the page's
model).

### The key provider: the vault's one seam to its key (owner constraint)

Owner constraint (issue #558): a key service (a cloud KMS, or a local one) is always optional and never a dependency;
the vault needs nothing outside the hopper to start, and a user hosting everything themselves has a vault that works.
So the vault reaches its key through one small seam, the **key provider** — the `Sealer` interface of
`src/secrets/sealer.ts` (`seal(value, context)`, `open(sealed, context)`, `current(sealed)`, `keyId`) — and
`src/vault/service.ts` knows nothing else of keys. The local default is the sealer under the runtime's master key, used
when no KMS is named. Since issue #586 a **KMS** can stand behind it, optional ("The KMS: an optional key provider" below); nothing
in the vault, the store or the routes changed for it, and a value it cannot open is `SecretUnreadable` as before.
`test/vault/key-seam.test.ts` keeps the vault working behind any key provider.

### Templates (slice 2)

A **template** (the glossary's, issue #559's `TEMPLATE_NAME`: lowercase letters, digits, `.`, `_`, `-`; at most 64; its
boxes are `hopper-sandbox-<name>`) is, for the vault, an image
(a full reference, as `podman run` takes it) and its **scope**: the vault secrets its boxes may ask for. An admin
saves, removes or approves one on Settings → Vault (`POST /ui/api/vault`: `save-template`, `remove-template`,
`approve-template`); `GET /api/vault` lists them under `templates`. Kept in the user schema's `templates` (tenant
migration 29, a table only), the last approval in its body.

- **Approved once.** A new template gives nothing. `approve-template` approves it as it is — its image and its whole
  scope — recording who and when (`vault.approved`). A scope widened since (a secret added) or a new image waits for a
  person again (`pending`); meanwhile its boxes are given what was approved, and nothing at all while the image is not
  the approved one. Narrowing needs no approval. `gives` says what its boxes may be given now.
- **Approval gates job placement too** (issue #602). A box of a template that is not approved — not saved, never
  approved, its approval revoked, or its image changed since — joins and shows on Machines, but takes no new job: its
  snapshot carries `template: { name, waiting }` (`approvalWait`, src/domain/vault.ts, read at every machine list), and
  the decider holds a job from it as from a machine whose work tree is not usable (`templateHolds`, src/decider/assign.ts).
  A job that can run nowhere else is held with the reason (`job.held`, on its timeline); the box's lanes stay idle with
  the reason (the Overview's lanes). Machines says "waiting for template approval". `approve-template` opens it: the
  next Decision places jobs there (`vault.approved` wakes the engine). A widened scope does not close it: its boxes keep
  working on what was approved. A job resuming in its pane there returns to it; a job running there keeps running.
- **Revoked at once.** `revoke-template` (`POST /ui/api/vault`, Settings → Vault → Revoke) drops the template's approval
  and every access approval of its operation profiles (`vault.revoked`): the next Decision places no new job on its
  boxes, and they are given no vault secret, until a person approves it again.
- **The scope is the template's.** Never a job's: nothing a job sends can name a template or a secret beyond it.
- **A box is an instance of a template.** Add machine → A sandbox box → a template: the join code names it (instance
  migration 29: `join_codes.template`, a column only), so the line carries no template the box could change. The box
  joins as a client target whose `template` option is the template's name; its line runs the template's image under
  the name `hopper-sandbox-<template>`. A computer's line names none. `scopeOf(machine)` answers what a machine's jobs
  may be given: its template's `gives`, else nothing.
- **Removing a template** (issue #604). `remove-template` is refused (409) while a box of it is attached; the answer
  names the boxes. A person removes them in Machines first, then the template. So no box points at a template that is
  not there. The removal revokes the template's access approvals (`Access.revokeProfile`): its `approved_for` tuples go,
  and its boxes' `instance_of` tuples went when the boxes left. Two more checks keep it so: a join line whose template
  was removed after the line was made is refused (409, the join adds no machine), and a machine's options are not set to
  a template the vault does not hold (`POST /ui/api/plugins`, 404). A box record from before this rule, of a template
  that is not there, is an instance of nothing: `boxes()` leaves it out, so Access writes no tuple for it, and the
  vault refuses it every secret. It takes no new job: it waits for template approval (issue #602), and a person
  removes it.
- **Events**: `template.saved` (template, image, scope, who), `template.removed`, `vault.approved`, `vault.revoked` — names,
  never a value.

**The vault mints only through Access** (issue #580, "Minting: short-lived credentials" below). It calls
`Access.decideMint` before every mint and every renewal, and mints nothing on a deny: the request goes to the
first-time gate (the profile waits for a person on Settings → Vault) or is refused, and the reason is on the job's
timeline. When a person approves a template at the gate, the vault writes the `approved_for` tuples through
`Access.approve`; a widening needs a new approval and new tuples. The issuance audit (`vault.minted`) records the
decision's id beside each mint. A vault secret's *delivery* (slice 3) is not a mint: the template's approval of its
image and secrets above decides it, rows in the hopper's database. A template's vault approval of its image and
secrets is not an access approval (`approved_for` an operation profile on an asset). A template's **operation
profiles** are (issue #584, "A template's blast radius" below): the vault's gate writes their access approvals, and
access is the one record of which are approved.

**Not built** (owner: keep the vault minimal; deferred): a template per agent CLI (a box of a template runs the template's image, whose agent is the one
that image carries — `claude` for the published `box-claude`).

Tests: `test/integration/templates.test.ts` (approve once; widening and a new image wait; narrowing does not; a
secret the vault does not hold refused; the join line names the template and the box joins as its instance; a template
with an attached box not removed, a join line of a removed template refused, a machine not set to a missing template; a box of a template
not approved takes no job until approved, and none after a revoke),
`test/integration/access-requesters.test.ts` (the removed template's tuples gone), `test/vault/missing-template.test.ts`
(a box of a template that is not there is no instance),
`test/decider/template-approval.test.ts`, `test/ui/machine-template.test.ts`,
`test/ui/machines.test.ts` (the line of a template's box), `test/ui/vault.test.ts` (what a template's card says).

### A template's blast radius (issue #584)

Owner direction (issue #559, split into #584): a box's tools decide what it *could* do (a machine's blast radius, issue
#542, from its discovery); its identity decides what it *may* do. So a template is rated too, from what its boxes may
ask for, and a high-radius operation profile takes its own explicit approval.

- **Declared profiles.** A template declares the operation profiles its boxes may ask for (`Template.profiles`, kept in
  its body: no migration; absent on a template saved before, none). `save-template` takes `profiles` (absent: the ones
  it has); each must be one the access model can hold (`profileProblem`, 400). A profile dropped from the template, or
  the template removed, has its access approval revoked at once (`Access.revokeProfile`): access holds no approval the
  template does not declare. A profile approved in access but not declared is rated too.
- **Approval is in access.** Access (issue #559) is the one record of which profiles are approved: `pending.profiles`
  is what the template declares and access does not approve, and a revoke in Settings → Access makes a profile wait
  again. The vault reaches access through `TemplateApprovals` (`approvedProfiles`, `approve`, `revokeProfile`;
  `src/domain/access.ts`), given to each user's runtime by the composition root. `approve-template` approves the image,
  the secrets and every pending **read** profile. A **high-radius** profile — `write`, `sync` or `apply` — is approved
  only by `approve-profile` (`name`, `operation`, `asset`), one profile at a time, behind a confirmation that says it
  changes the asset: an approval for read never approves write. Each is `template.profile_approved` (template,
  operation, asset, level, who).
- **The rating** (`rateTemplate`, `src/blast-radius/template.ts`, pure; `TemplateRadius`). Each profile, declared or
  approved: `read` is `low`, a high-radius one `high`, approved or waiting. Each vault secret in the scope is a
  credential whose reach the hopper cannot see: an unconfirmed reach, rated by the user's blast-radius rules
  (`reachLevel`: `medium` by default, `high` when its name or scope line holds a prod pattern, `low` when the rules
  count unconfirmed as read). The level is the highest; the reasons are the lines that set it, a profile's saying
  whether it is approved or waits. Rated at every view: a widening (a profile or a secret added) rates it again at
  once, and the new profile waits for a person.
- **Where it shows.** `GET /api/vault` and Settings → Vault: each template's `radius`, its badge and reasons, its
  profiles marked as waiting, Approve (the template and its read profiles) and one *Approve write on …* per waiting
  high-radius profile. `GET /api/access` and Settings → Access: each template with an approval or a vault template of
  its name, its `radius` beside its approvals, and what waits for approval on the Vault page. Access rates a template
  from every user's vault templates of that name (`VaultService.templateScopes`), each with its user's rules, and shows
  the highest.

**Not built.** A box's machine rating does not include its template's yet: the gate (#544) holds jobs by the machine's
discovered rating only. The permission matrix (#559, Settings → Permission matrix) shows each template's rating next to its row. `GET /api/access` carries each template's `radius`. Minting (#580) asks `decideMint`, which denies what the gate has not approved.

Tests: `test/blast-radius/template-rate.test.ts` (each operation's level, approved or waiting, a profile approved but
not declared, a vault secret by the rules), `test/integration/template-radius.test.ts` (the real daemon and access: a
read profile rated low and its check allowed; a write profile added raises the rating, the template's approval does
not approve it, its check is denied until `approve-profile`; a vault secret in the scope; a revoke in Settings → Access
makes it wait again; narrowing and removal revoke; refusals), `test/integration/access.test.ts`, `test/ui/vault.test.ts`.

### Delivery to the box (slice 3)

A job on a box gets a vault secret at the moment a tool asks for it, and only then. Nothing is set in its environment
or written to its disk: the value is in memory, in the client and the helper, for the one call.

**On the box.** The hopper client (`src/client/vault.ts`) serves a Unix socket, `vault.sock` in its client dir (the
dir 700, the socket 600), and writes the helper `hopper-secret` beside it at each start: a short sh script that runs
the client's `secret.ts` with node, the socket named. The client's `/release` answer says the helper's path (`vault`);
the hopper keeps it on the machine (`MachineSnapshot.client.vault`) and gives each job there `HOPPER_SECRET`, beside the
GitHub proxy's `HOPPER_TOKEN_FILE` (`src/users/github-proxy.ts`, issue #563). A machine whose client says no helper (an
ssh target, this machine, a client from before) gets none.

| run | prints |
|-----|--------|
| `$HOPPER_SECRET get NAME` | the value, as it is: for one command, `$("$HOPPER_SECRET" get NAME)` |
| `$HOPPER_SECRET kube NAME` | a kubeconfig `exec` credential plugin's `ExecCredential` (the API version kubectl asked for), the secret as the token |
| `$HOPPER_SECRET git NAME [USER] get` | a git credential helper's answer, the secret as the password (user `x-access-token` unless named); `store`, `erase` ignored |
| `$HOPPER_SECRET aws NAME` | an AWS `credential_process` answer; the secret holds the key pair as JSON (`AccessKeyId`, `SecretAccessKey`, optional `SessionToken`, `Expiration`) |
| `$HOPPER_SECRET kube\|aws OPERATION ASSET` | a credential the vault mints for the operation on the asset, short-lived, after Access allows it ("Minting" below) |

**The ask.** The helper reads the job's proxy token from `HOPPER_TOKEN_FILE` and asks the socket `{name, token}`; the
client posts it to the hopper's `POST /client/vault` (at the URL it joined), signed with the client token over the
user, its machine key and the body (`signVault`, label `hopper-vault`: never taken for a request of the hopper's or a
dial-in), once, within 30 s. The hopper (`VaultService.deliver`) gives the value only when all of these hold — else
**403** saying why, and a `vault.refused` event:

1. a client target holds the machine key, and the signature is its token's (else **401**);
2. the proxy token is one this user's link key gives the job (issue #563): it dies with the job;
3. the job is at work (`running`, `waiting_answer`): ended, failed or parked, nothing;
4. the job runs on that machine (its lane's, or where its pane waits);
5. the machine is a box of a template, and the secret is in the template's approved scope now (`scopeOf`, slice 2);
6. the vault holds the secret and the key provider opens it.

**The answer** is sealed to that one request: AES-256-GCM under a key HKDF-derived from the client token, a fresh salt
and the request's nonce, with the secret's name and the job's token as authenticated data, and `cache-control:
no-store`. It crosses no wire in clear, even over plain HTTP on a LAN; only the client opens it. The delivery is
recorded: `vault.delivered` (secret, template, machine, job) and the secret's `lastUsed`, shown on the Vault page —
never the value.

**What a job can still do.** A tool, or the agent, that receives a secret can keep it for the rest of its job: the
value delivered is the stored one. The scope per template and the audit bound this; for AWS and Kubernetes, a
minted short-lived credential closes it (issue #580, below). Several jobs on one box share its user and its socket: a job can ask only with its
own token, but a box of a template with secrets is best run one job at a time (one lane).

Tests: `test/integration/vault-delivery.test.ts` (a real joined box of a template and the real helper: refused until
the template is approved, then `get` and `kube`; a secret outside the scope, an ended job, a token the hopper did not
give, a computer of no template and an ask not signed by the machine refused; the value in no event, log line or file
of the client dir), `test/client/vault.test.ts` (the signature, the sealed answer, the socket and the helper's forms),
`test/vault/job-secret.test.ts` (HOPPER_SECRET given only where the client serves a helper), `test/ui/vault.test.ts`.

### Minting: short-lived credentials (issue #580)

Owner direction (issue #559, split into #580): the vault mints short-lived credentials — AWS STS sessions and
Kubernetes TokenRequest tokens — and asks Access (`decideMint`) before every mint and every renewal. OpenFGA is part
of the hopper's compose stack, as Postgres is, so this needs nothing outside it.

**A minting credential** is a vault secret marked with what it mints for (`VaultSecret.mints`: an `aws-account` or a
`cluster` asset; `set` with `mints`, *Mints for* on Settings → Vault; in its JSON body, so no migration). It is sealed
like any vault secret (or kept in a vault backend, issue #585), and it never leaves the vault: `deliver` refuses it, no template may list it in its scope, and
the page leaves it out of a template's secrets. Its value is JSON (`mintingCredentialOf`, `src/domain/minting.ts`):
for AWS `AccessKeyId`, `SecretAccessKey` (optional `SessionToken`, `Region`, `Endpoint`), for Kubernetes `server`,
`token`, optional `certificateAuthorityData`.

**What is minted** for an operation profile (`mintTarget`, pure):

| form | asset | minted |
|------|-------|--------|
| `aws` | `aws-role/<account>/<role>` | STS `AssumeRole` on `arn:aws:iam::<account>:role/<role>`, 900 s (STS's floor), session `hopper-<job id>`; a `read` session carries the session policy `arn:aws:iam::aws:policy/ReadOnlyAccess`. From the minting credential for `aws-account/<account>`. |
| `kube` | `namespace/<cluster>/<ns>` | a TokenRequest for the service account `hopper-<operation>` in `<ns>`, 600 s (TokenRequest's floor). From the minting credential for `cluster/<cluster>`. |
| `kube` | `cluster/<name>` | the same, in the namespace `hopper`. |

What a service account or a role may do is the cluster's RBAC and the account's IAM: the hopper decides *whether* a
job gets a credential for the profile, the outside system *what* it allows. `docs/deploy.md` "Minting short-lived
credentials" says how to set them up.

**On the box.** `$HOPPER_SECRET kube OPERATION ASSET` (an exec credential plugin: the token and its
`expirationTimestamp`) and `$HOPPER_SECRET aws OPERATION ASSET` (a `credential_process` answer with `Expiration`).
kubectl and the AWS CLI run the helper again when the last credential expires: each run is a new mint, so each renewal
asks Access again. The ask (`{mint, operation, asset, token}`, `src/client/vault.ts`) goes the delivery's way —
socket, signed `POST /client/vault`, the answer sealed to that request with the form, operation and asset bound as
authenticated data.

**The mint** (`src/vault/mint.ts`), in order; the first that fails is the job's answer (**403**) and a
`vault.mint_refused` event on its timeline:

1. the box and the job (`src/vault/box.ts`, the same checks as a delivery): a client target holds the key, the proxy
   token is the job's, the job is at work on that machine, the machine is a box of a template;
2. the profile is one the model can hold, and of an asset kind the form mints for;
3. **Access**: `decideMint({ requester: { kind: 'job', … }, operation, asset })` — Access finds the template from the
   job's box (issue #581). A deny mints nothing. When the template declares
   the profile and access does not approve it, the reason says it waits for a person's approval on Settings → Vault
   (the first-time gate: `approve-template` for a read profile, `approve-profile` for a high-radius one); when the
   template does not declare it, that a person adds it first;
4. a minting credential for the account or cluster, opened by the key provider;
5. STS or the Kubernetes API (`src/vault/minter.ts`, at the `CredentialMinter` port: `@aws-sdk/client-sts`, and one
   POST with node's https and the cluster's CA — a Kubernetes client library would cost more than the call). A
   refusal there is said, without the minting credential.

**With the vault in a container of its own** (issue #586). Steps 1 to 4 and Access run in the hopper; only step 5
crosses: `POST /vault/mint` (`credential`, the target, the session name), and the vault container opens the minting
credential and calls STS or the Kubernetes API itself, so it must reach them; the minted credential crosses back, the
minting one never. One kept in a vault backend is minted in the hopper, which runs the backends.

**Audit.** `vault.minted`: the form, the profile, the template, the machine, the job, the minting credential's name,
the expiry, `renewal` (the job had one for that profile before; kept in memory, so a restart counts the next as a
first), and `decision` — the id of Access's decision, the row Settings → Access shows. The minting credential's
`lastUsed` says when it last minted. Never a credential, minted or minting.

**Skills.** When the vault holds a minting credential for the asset's account or cluster, a link skill (#582) answers
the minted stanza (`args: [kube, read, namespace/prod/web]`, `credential_process = … aws read aws-role/…`) in place of
the vault secrets.

**Not built.** GitHub installation tokens (the GitHub proxy, #563, already keeps tokens off boxes). Minting for an
`aws-account` asset with no role, an Argo CD app or a Terraform workspace. Revoking a credential already minted: it
lives out its 10 or 15 minutes; a revoke bites on the next mint.

Tests: `test/integration/vault-mint.test.ts` (a real joined box, the real helper and the real minting adapters against
an STS and a Kubernetes API faked on loopback, OpenFGA as a double: waits at the gate and mints nothing; after approval a
token with its expiry, the audit naming the allowing decision; a write denied, nothing asked of the API; an AWS read
session with the read-only policy, its renewal recorded; a revoke denies the next renewal; a minting credential never
given out nor in a template's scope; an undeclared profile and a wrong asset kind refused; the minting credentials in
no event, log line or file of the box), `test/client/vault.test.ts` (the mint ask, its sealed answer, the minted
output), `test/integration/skills.test.ts` (the minted link), `test/ui/vault.test.ts` (*Mints for*).

### The KMS: an optional key provider (issue #586, 2026-10-09)

Owner rule (issue #586): extra compose services are allowed; nothing outside the hopper's compose stack is required;
the KMS is always optional. So the KMS is a second key provider, chosen by one runtime setting, never a dependency.

- **Envelope encryption, a data key per user.** With `HOPPER_KMS_URL` set, the vault asks the KMS once for a data key
  (`GenerateDataKey`, AES-256, bound to the encryption context `hopper: vault data key v1`). It keeps only the wrapped
  form, in the user schema's `config` table as the row `vault-data-key` (no config record names it, so no route or CLI
  reads it). At each start the KMS opens it (`Decrypt`). The vault's sealer is then the usual one (`src/secrets/sealer.ts`)
  under the data key: each value still gets its own key from a salt, AES-256-GCM, bound to `vault:<id>/value`. The data
  key's id is its fingerprint, so a sealed value says which key it needs.
- **Turning it on.** The master keys stay as previous keys, so a vault secret sealed before opens, and is sealed again
  under the data key when the vault opens (`resealAll`). Two starts at once: the first to keep its data key wins
  (`INSERT … ON CONFLICT DO NOTHING`), the other opens that one.
- **Fails closed.** A KMS that gives no data key (down, refused, a changed wrapped key) leaves the vault with no sealer
  and a problem naming the KMS: Settings → Vault says it, nothing is stored, nothing delivered. In the hopper, a restart
  asks again; the vault container asks again at the next request.
- **Turning it off** is not built: a value sealed under the data key does not open without the KMS, and is said so.
  Set each secret again. A fold of users (issue #265) keeps the kept user's data key; the folded user's secrets sealed
  under another data key are set again.
- **The KMS built**: local-kms (`docker.io/nsmithuk/local-kms`, AWS KMS's API, keys in its `/data` volume), the
  compose profile `kms`. The key is `HOPPER_KMS_KEY` (default `alias/hopper-vault`), made with its alias at the first
  ask when the KMS has none. The client is AWS's own (`@aws-sdk/client-kms`), with fixed placeholder credentials:
  local-kms checks none. A KMS that checks credentials (AWS) is not supported yet. Residual risk: local-kms keeps its key
  material in clear in its volume; it parts the key from the database (a dump holds no usable value), not from the host.

Tests: `test/vault/kms-keys.test.ts` (a fake KMS at the `KeyService` port: wrap once, open again, seal again, fail
closed), `test/vault/local-kms.test.ts` (the adapter against a real local-kms, when `HOPPER_TEST_KMS_URL` names one).

### The vault in a container of its own (issue #586, 2026-10-09)

The vault can run as a separate compose container, `hopper-vault` (profile `hopper-vault`): the hopper's image, `node
src/vault/main.ts`. With `HOPPER_VAULT_URL` set, the hopper builds no vault of its own and holds none of its keys: it
asks the vault server (`src/vault/remote.ts`). Unset, the vault runs in the hopper, as before.

- **The split.** The vault container holds the vault's key and the secret values: a secret set or removed, a delivery,
  and whether the vault can be used now (`status`, shown as Settings → Vault's problem) go to it. The secrets' metadata
  and the templates — whose operation profiles are approved in access (issue #584), the hopper's — are read and changed
  in the hopper, by a vault service that holds no key. So is a secret kept in a vault backend (issue #585): its set and
  its delivery run in the hopper, which runs the backends; the vault container never sees one. The service is named
  `hopper-vault`, apart from `vault`, the HashiCorp Vault backend's service. `scopeOf` and `templateScopes` stay synchronous for the skill
  broker (issue #582) and the access rating.
- **The same checks.** The server (`src/vault/server.ts`) opens the user's store and runs the same vault service per
  request: the write-only rule and every check of a delivery stay in the vault. What only the hopper knows travels with
  an ask: the client target whose link signed it (name, machine key, template) and whether the job's token is one the
  user's link key gives (issue #563). The vault decides the rest — the job at work, on that machine, the secret in the
  template's approved scope, read from the user's store — and opens the value.
- **The wire** (`src/vault/wire.ts`): `POST /vault/<op>` — `status`, `set`, `remove`, `deliver` — JSON, with the
  preshared key `HOPPER_VAULT_KEY` as a bearer token (compared in constant time; the postgres service makes it on first
  start, `vault_key`, uid 1000). The answer is `{ result, events }`. On the compose network only: no host port. Residual
  risk: plain HTTP on that network, as for OpenFGA; a value crosses it when it is set and when it is delivered.
- **The hopper keeps the event log.** The vault answers the events it would append (`vault.secret_set`,
  `vault.delivered`, …); the hopper appends them, so webhooks and the UI see them as before. A vault edit and its event
  are no longer one transaction.
- **Not running, or the wrong key**: the view carries the problem ("not reachable", "refused the hopper"), an edit
  answers 503, an ask is refused and recorded (`vault.refused`). Nothing else in the hopper waits on the vault.
- **Its key provider** is chosen in the vault container: the master key (`HOPPER_MASTER_KEY` from `.env`, the hopper's own,
  checked against the database's fingerprint, issue #659), or
  the KMS's data key with `HOPPER_KMS_URL`. The hopper's master key still seals what the hopper owns itself (webhook
  signing secrets, the GitHub connection's tokens).
- **Migrations stay the hopper's.** The vault server opens the store at its first request, after the hopper has
  migrated it.

Tests: `test/integration/vault-container.test.ts` (the hopper and the vault server with one master key: set, sealed
under it, events in the hopper's log; a vault server with another master key seals nothing; a wrong preshared key; no vault running and the hopper works),
`test/integration/vault-delivery.test.ts` (a box's job gets a secret through the vault container),
`test/scripts/compose.test.ts` (the profiles).

## Skills: what the hopper can set up for a box (issue #582, 2026-10-09)

Owner direction (#559, "hopper's skill system, how a box phones home"): the hopper is the broker between all boxes. A
box does not wire itself to other boxes or to outside systems; it asks the hopper. Like MCP, without MCP: a small
catalog that costs few tokens, the full text of a skill only when a box asks for it, a small API and CLI, and a clear
no with a reason when the hopper cannot or may not — never a silent failure, never a hang.

**The way in.** Beside `hopper-gh` (issue #563) the engine keeps a third file in the job's credentials dir,
`hopper/skill`, and sets `HOPPER_SKILL` to it. It asks with the same **proxy token** (`HOPPER_TOKEN_FILE`) and the same
`HOPPER_URL`. One protocol line (`SKILL_LINE`, `src/job-rules/`) tells the job to run it when it needs something set up.

| call | answer (plain text) |
|------|---------------------|
| `sh "$HOPPER_SKILL"` | the **skill catalog**: `name: one line` per skill, then `Load one: sh "$HOPPER_SKILL" NAME [ASSET]` |
| `sh "$HOPPER_SKILL" NAME` | the skill's full text, when it needs no asset |
| `sh "$HOPPER_SKILL" NAME ASSET` | the skill's text and its **link** for this box, when Access allows it |
| a skill whose credential the box's template does not give (issue #583) | `waiting: …` (202), exit 3: the vault asks a person ("The dynamic vault"); `--wait` opens a **watch** and waits on the **job stream** for the answer, pushed when it is ready (issue #613, "The job stream"), until its deadline (`--timeout SECONDS`, an hour unless said): exit 4; `--why TEXT` says what for, `--credential TEXT` names what a service the hopper has no skill for takes |
| any no | `no: <reason>`, exit 1 |

**`POST /job/skill`** (`src/http/job-skill.ts`): outside the UI session, behind the Host guard, like `POST /job/github`
(`AGENTS.md`). `Authorization: Bearer <proxy token>`; no fields for the catalog, else `name` and `asset`, as a form or
JSON. The broker (`src/skills/broker.ts`), in order:

1. the token: its user, its link key, its job, at work — else **401**, logged only;
2. no `name`: the catalog — **200**, `skill.listed`;
3. a skill the hopper has, or a `credential` the job names for one it has not, or a vault secret a person gave for
   that name to the box's template (issue #583) — else **404** `no: the
   hopper has no skill NAME. It has: … For another service, say what credential it takes: … Else find another way.`;
4. a skill with no link: its text — **200**, `skill.loaded`; one that needs a credential (issue #583): with the vault
   secret given for it ("The dynamic vault"), else the credential request's **202**;
5. a link: the `asset` (`kind/name`, as Access names assets: `cluster/prod`, `namespace/prod/web`, `aws-account/ID`,
   `aws-role/ID/ROLE`) of a kind the skill takes — else **400** with how to name it;
6. the box's identity: the job's machine (its lane's, else where it resumes) and the **template** that machine joined as
   (`VaultService.scopeOf`) — a machine of no template: **403**, Access checks a box by its template;
7. Access (issue #559): `decideMint({ job, template, operation, asset })`, the skill's operation (`read` for both
   diagnostics skills). Recorded in Access's decisions, so it feeds the permission matrix — a deny: **403**
   `no: Access denied it: <Access's reason>`, `skill.refused` with `decision`;
8. the vault secrets the template may be given now (its approved scope, issue #558): those given for this skill (issue
   #583), else those given for no skill — none: the credential request's **202** for a skill that says its credential,
   else **403** saying a person adds one; else **200**: the text, Access's reason, and the link — the secrets by name and scope line, and the stanza the
   tool runs (`exec: … args: [kube, NAME]`, `credential_process = … aws NAME`) through `$HOPPER_SECRET`. Never a value:
   the vault gives it just in time, with its own checks, when the tool runs.

**The skills** (`src/skills/catalog.ts`, baked in): `github` (the text is `hopper-gh`'s help), `kube-diagnostics` (read
on a cluster or namespace), `aws-diagnostics` (read on an AWS account or role). No skill is special to one outside service: a credential for any
other service is asked in the job's own words (issue #583, "The dynamic vault"), and the catalog's last line says how.
The catalog stays under 800 characters.

**Audit.** On the job's timeline: `skill.listed`, `skill.loaded` (`skill`, `asset`, `decision`) and `skill.refused`
(`reason`, `decision` when Access answered), each with `requestId`, `machine` and `template`. Access's decision is the
same row Settings → Access shows.

**Minting** (#580): when the vault holds a minting credential for the asset's account or cluster, the link is the
minted stanza ("Minting: short-lived credentials"); else the vault secret as it is, delivered just in time.

**Not built.** Skills a user or a plugin
adds. A link between boxes, a tunnel. Rate limits: the catalog is cheap and a
link costs one Access check. A template is named in Access by its name alone, so two users' templates of one name share
their approvals. Access checks the job (issue #581): its box's template comes from the job's relations.

| dir | owns | must not import |
|-----|------|-----------------|
| `src/skills/` | the skills, the catalog, `hopper-skill`, the broker | engine, http, store, plugins, executors, decider |

Tests: `test/integration/skills.test.ts` (the real daemon, a real joined box and client, OpenFGA as a double; the job runs
the real `hopper-skill`: the catalog in short lines; `github` loaded; a skill the hopper does not have refused with the
list; on a box of a template, Access denies with its reason and the decision is recorded, then after an approval the
skill and its link, never the value; a machine of no template, no asset, a wrong asset kind and a bad token refused),
`test/integration/github-proxy.test.ts` (`HOPPER_SKILL` beside `HOPPER_GH`), `test/herdr/screen.test.ts` (the protocol
line).

### Vault backends (issue #585, 2026-10-09)

Owner direction (issue #559, split out as #585): the vault can keep a secret's value in an outside secret manager the
user prefers — 1Password, Bitwarden, HashiCorp Vault — as a **backend**, never as a replacement. Rule: nothing outside
the hopper's compose stack is required; a backend is always optional, and the hopper works fully without one.

**A plugin role.** A **vault backend** is a plugin of the role `vault-backend` ("Roles, plugins, instances"): 0..n
instances in the plugins config's `vaultBackends`, added, edited and removed in Settings → Plugins, followed live. Port:
`VaultBackend { name; check(reference); read(reference) }` (`src/domain/vault.ts`). `check` says why a reference is not
one the backend reads, from its form alone (no network, no credential); `read` gives the value a reference points at,
now, or throws saying why — never with a value. A built-in plugin is never written into a fresh store's plugins
config: `vaultBackends` is absent until a person adds one, so a build from before it still reads that config.

**What stays the same.** The hopper's vault stays the one front door. A secret kept in a backend is a vault secret like
any other: a template's approved scope names it, a box's job asks for it with its proxy token, the client's link signs
the ask, and the answer is sealed to that one request ("Delivery to the box"). Only where the value comes from
changes: the vault service (`deliver`) reads it from the backend after every check has passed, at the moment of use,
and keeps no copy — not in the database, an event, a log line or a cache. `vault.delivered` and `vault.refused` name
the backend (`backend`); a backend that is gone, cannot run or cannot read the reference refuses the ask, saying why
(`vault.refused`, a warning in the log naming the backend and the secret).

**Kept.** A vault secret kept in a backend has `backend: { name, reference }` in its metadata, shown on Settings →
Vault and in `GET /api/vault`, and no sealed value: tenant migration 31 lets `vault_secrets.sealed` be empty. The build
before reads an empty value as one it cannot open, and refuses to deliver it. Set with `POST /ui/api/vault`
`set-in-backend` (`name`, `scope?`, `backend`, `reference`): refused for a backend the plugins config does not name, one
that cannot run, or a reference its `check` refuses. Setting a value again (`set`) keeps it in the hopper once more;
`set-in-backend` over a secret kept in the hopper drops its sealed value. Such a secret needs no master key. A person
adding a secret on the Vault page chooses where it is kept: this hopper (a value), or a backend (a reference).

**The backend's own token** comes from the runtime, as every credential for an outside service does ("Secrets"): the
variable its `tokenEnv` option names, or the file that variable's `_FILE` names, read at each use, so a rotated token
applies without a restart. It is never in the plugins config, an event or a log line. Unset: the backend is
`needs-setup` and still runs (each read fails, saying which variable to set). `tokenEnv` and every address are
command-bearing options: a UI session cannot send the token somewhere else without an admin.

| plugin | reference | reads with | notes |
|---|---|---|---|
| `hashicorp-vault` | `path#key` in the KV version 2 engine (`mount`, default `secret`) | `GET <address>/v1/<mount>/data/<path>`, header `X-Vault-Token` (`tokenEnv`, default `VAULT_TOKEN`); `namespace` optional | No client library: one GET with a header is all of it, and the Node libraries for Vault wrap the same call with more than they save. 10 s timeout. Default `address` `http://vault:8200`: the optional compose service. |
| `1password` | `op://vault/item/field` (or with a section) | 1Password's SDK `@1password/sdk`, `secrets.resolve`, with a service account token (`tokenEnv`, default `OP_SERVICE_ACCOUNT_TOKEN`) | The SDK is loaded at the first read; one client per token. |
| `bitwarden` | the secret's id in Bitwarden Secrets Manager | Bitwarden's SDK `@bitwarden/sdk-napi`, `secrets().get`, signed in with a machine account's access token (`tokenEnv`, default `BWS_ACCESS_TOKEN`) at `apiUrl` and `identityUrl` (default the US cloud) | The SDK is loaded at the first read; no state file, so nothing is written to disk; one client per token. A native module with no build for linux on arm64: there the plugin is unavailable, saying so. |

**The optional compose service.** `compose.yaml`'s `vault` service (profile `vault`) runs HashiCorp Vault with file
storage, started only with `podman compose --profile vault up -d`; the hopper has no `depends_on` on it. Its first
start initializes Vault with one unseal key, keeps the unseal key and the root token in its own volume `vault-keys`,
enables KV version 2 at `secret`, and makes a read-only token for the hopper (policy `hopper`: read on
`secret/data/*`) in the volume `vault-token`, which the hopper mounts read-only as `VAULT_TOKEN_FILE`. Each start
unseals it with that key, so whoever can read `vault-keys` can open it: a convenience for a single host, said in
`docs/deploy.md`. No host port: only the hopper reaches it.

**When the vault asks for a new credential**, the person enters its value or points the hopper at where it already is
in their backend: the Vault page's form offers both.

**Not built**: a backend that writes (the hopper only reads); a backend's credentials minted per job; a check-read when
a secret is set (a wrong reference shows at the first delivery, in `vault.refused` and on the box); a list of a
backend's items to pick from.

**Seams.** `src/plugins/vault-backend/<id>/` (the plugins), `src/plugins/vault-backend/credential.ts` (the token from
the runtime, one client per token), `src/plugins/source-slots.ts` (`applyVaultBackendSpecs`, `configuredBackend`), the
host's `vaultBackends()`; `src/vault/` is given them as `ConfiguredBackend` (`src/domain/vault.ts`) and imports nothing
of `src/plugins/`.

Tests: `test/integration/vault-backends.test.ts` (a real HashiCorp Vault and a real joined box: a secret kept there is
delivered just in time, a changed value delivered at the next ask, no value in the database, an event or a log line; with
the backend removed the hopper's own secret is still delivered and the one kept there refused; a backend that cannot
read refuses; a backend or reference it does not have refused when set), `test/plugins/vault-backends.test.ts` (each
built-in plugin: HashiCorp Vault against a real server; 1Password and Bitwarden through a fake of their SDK),
`test/ui/vault.test.ts`.

## The dynamic vault (issue #583, 2026-10-09)

Owner direction (#559, "a dynamic vault that grows as it's needed"): the vault keeps no fixed list of keys. It grows from
what work asks for. A job that needs a credential the hopper does not have makes the hopper find out what the work
needs — which skill, which credential —, ask the user for it, take whatever kind the user gives, and hand it to the job
just in time. A user who has no tool set up yet (no kubeconfig) is told how to set it up. The vault is generic: the
hopper has no code, skill or text special to one outside service. A token for some outside service, a kubeconfig or a
cloud API key are only examples of what a person can give. It uses the skill system of issue #582: no second way in.

**A skill's credential** (`SkillCredential`, `src/skills/catalog.ts`). A skill that needs one says the kinds it takes —
the first is the one the hopper suggests — and how a person gets one or sets the tool up (`setup`). Each kind may say
how a job uses it (`use`, `NAME` for the vault secret's name); a link skill's link says it instead.

| skill | suggested, then other kinds | setup says |
|---|---|---|
| `kube-diagnostics` | a read-only bearer token (a service account's) | with no kubeconfig: a service account with the view role and `kubectl create token` |
| `aws-diagnostics` | an access key pair, read-only, as JSON | an IAM user with ReadOnlyAccess and an access key |

A person may always give **something else**, in their own words (`other`, a line the job reads; never the value).

**Any other service.** A service the hopper has no skill for is asked in the job's own words: `sh "$HOPPER_SKILL"
SERVICE --credential "<what it takes>" [--why "<what for>"]` (`askedSkill`). The job's words are the suggested kind
(`asked`); the setup line says the hopper has no steps of its own. This is the path for every outside service: an API
token, a config file, a deploy URL, or anything else a person can give. Once a person gave one, the template's boxes load
`SERVICE` with or without `--credential`, and a later job that needs the same access gets it with no new request.

**Asking.** The broker ("Skills", step 4 or 8) finds no vault secret given for the skill among what the box's template
gives. On a machine of no template it says no: the vault gives credentials only to boxes of a template. Else it asks the
vault (`Vault.need`), which answers. The requests sit over the vault wherever it runs — in the hopper, or in a container
of its own (issue #586) — in the hopper's process (`withCredentialRequests`, `src/vault/service.ts`; the requests
themselves `src/vault/requests.ts`):

- **declined**: a person declined the request this job waited on — **403** `no: the user declined …: <reason>`, told
  once to each job that waited;
- **waiting**: the template's scope holds a secret given for the skill that waits for approval; or no such secret, and
  a **credential request** is opened (or joined) — **202** `waiting: …`. `hopper-skill` exits 3, or with `--wait`
  opens a watch and waits on the job stream, saying it once on stderr, until the answer is 200, a no, or the
  deadline (issue #613, "The job stream"). A wait is no `skill.*` domain event.

**Credential requests** (`CredentialRequest`, `src/domain/vault.ts`): one open per template and skill; a second job
asking joins it (`asked`: each job, its box, its `why`). `vault.credential_asked` once per job and request, on the job's
timeline. Kept in the hopper's memory only: a request no job at work waits on is dropped, and a restart drops them all.
What survives a restart is the job's **watch** (issue #613), in the database: when the job subscribes again, the hopper
asks the request again, and that opens it again. No table for the requests themselves.

**The person's answer** (Settings → Vault, panel **Asked for**, while any request is open; a toast says when a job asks;
`POST /ui/api/vault` `give-credential` / `decline-credential`, admin). The card shows who waits and why, and how to get
the credential. The admin picks the kind — the suggestions first, or something else with a line saying what it is —, a
vault secret name (the skill's by default, or one the vault holds that was given for the skill or has its name: then
the value may stay empty), and the value. **Give**: the value is set through the vault's own set, as any vault secret
(sealed where the vault keeps its key, write-only); its metadata keeps `skill`, `kind` and `note`; it joins the
template's scope; and when the template is approved and its
image unchanged, the giving approves the widening by that one secret — the person gives it for that template's boxes,
and nothing else is approved. A template never approved, or with a new image, still waits on its card, and the job is
told so. A credential the person keeps in a vault backend (issue #585) is given by name: set it on the Vault page as kept
in the backend, then give that name with no value. An `access-key` must be the key pair as JSON, as the helper's `aws`
form reads it. `vault.credential_given`
names the secret, the kind, the template, whether it approved, and the jobs; never the value. **Decline**, with a
reason: `vault.credential_declined`.

**Ready.** The job loads the skill again (or, for its `--wait`, the hopper does, and pushes the answer on the job stream): **200** with the skill's text and, for a skill with no
link, `Vault secret: NAME — <kind> (the user says: …)` and how to use it; for a link, the link names the secrets given
for that skill. **Delivery** is the vault's, unchanged ("Delivery to the box"): `$HOPPER_SECRET get|kube|git|aws NAME`,
only in the template's approved scope, to a job at work on the box, sealed to the request.

**Access.** A link skill's credential is asked for only after Access allows the link. A service asked in the job's own
words has no asset kind in the access model, so it is loaded as `github` is, with no Access check; the vault's template
gate decides who gets the credential. Minting through `decideMint` is #580's.

Taken conservatively, each one place to change: requests in memory (a table if they must outlive a restart); the
request on Settings → Vault and a toast (no section badge); the giving approves only an approved template's widening by
the one secret; Helm, GitOps and Argo CD skills not built (a job asks for them in its own
words until they are).

Tests: `test/integration/vault-requests.test.ts` (the real daemon, a joined box, the real `hopper-skill` and
`hopper-secret`: a job asks for a token for an outside service in its own words, which opens a request; given, the
`--wait` ends with how to use it and `get` delivers it, the value in no answer, event, log or file; a second job on
another box of the template gets it with no new request; another kind in the user's words; declined; no words and
nothing given; a template never approved; a machine of no template; a Kubernetes link Access allows, with no token: asked, with
how to make one), `test/skills/credentials.test.ts`, `test/ui/vault.test.ts` (the request card's model),
`test/integration/skills.test.ts`, `test/herdr/screen.test.ts` (the protocol line).

## The job stream (issue #613, 2026-10-09)

Owner requirement: replace the agent's polling with events the hopper pushes. Before it, `hopper-skill --wait` asked
`POST /job/skill` again every 5 s, forever: no deadline, the waiting request only in memory, and nothing the hopper
could push. Now a running job subscribes to its **job stream** and the hopper tells it.

**The way in.** `GET /job/stream` (`src/http/job-stream.ts`), outside the UI session, behind the Host guard, like
`POST /job/skill` (`AGENTS.md`). `Authorization: Bearer <the job's proxy token>`: the token of issue #563, an HMAC
under a key derived from the user's link key. It is checked when the job subscribes and again at each 15 s ping: the
stream ends once the job is no longer at work. 401 when the token is no job's or its job ended; 404 for a `request`
that is not a watch of this job; 503 with `Retry-After: 1` while the job is not at work but has not ended (queued again
after a restart): the job subscribes again. A job gets its own events only.

| part | form |
|------|------|
| frame | `id: <seq>` · `event: <type>` · `data: <the wire form, JSON>`; `retry: 1000` first; `: ping` every 15 s |
| replay | the job's events after `Last-Event-ID`, else `?after=`, then live (subscribed first, deduplicated by seq) |
| `?request=ID` | that request's events only; the stream ends after its event of an ending phase |
| wire form | `{ seq, type, request?, phase, at, payload }`, the payload last; over 4096 bytes (`INLINE_MAX`) a **result pointer**: the same fields with `ref: { url, bytes }` in place of `payload` |
| `GET /job/stream/results/:seq` | the event whole, as JSON, the same bytes the pointer counts (`resultOf`); with `Accept: text/plain`, the payload alone when it is a string. Same token, same checks |

**One builder.** `wireEvent` (`src/job-stream/wire.ts`) alone decides whole or pointer, from the size of `resultOf` the
same event; the result route answers `resultOf`. So the event and the result fetched are one object and cannot drift.

**A generic envelope.** A stream event is a `type` and a `payload`, the `request` it is of, and a **phase**: `started`,
`progress`, `waiting` (a person is asked), `done`, `failed`, `expired`. Each part that emits registers its types with
their phases, under its own name (`createStreamTypes`, `src/job-stream/types.ts`): `register('skill', …)` may register
only `skill.*`, each once. The hopper reads the phase and never the payload; emitting an unregistered type throws. The
user's registry is made in `src/users/job-stream.ts`.

| type | phase | owner | payload |
|------|-------|-------|---------|
| `skill.waiting` | waiting | the skill broker | the `waiting:` text |
| `skill.loaded` | done | the skill broker | the skill's text |
| `skill.refused` | failed | the skill broker | the `no:` text |
| `hopper.expired` | expired | the hopper | `expired: …` text |
| `hopper.ended` | failed | the hopper | `no: job … is <status>` text |

**Watches.** A request a job waits on (`Watch`, `src/domain/job-stream.ts`): its id (the skill request's id), the job,
a deadline, and the fields to ask it again with (the opener's; the stream never reads them). `POST /job/skill` with
`wait` (what `--wait` sends) and an answer of 202 opens one (`src/skills/waits.ts`) — deadline `timeout` seconds from
now, an hour unless said, at most a day —, emits `skill.waiting`, and adds a line to the answer: `wait: <id> until
<deadline> (<seconds> s): …`. It ends with an event of an ending phase: `done` or `failed` from its owner, `expired`
at its deadline, `failed` when its job ends — the sweep (`JobStream.sweep`, every second) gives the last two.

**Pushed, not polled.** The broker answers a watch's request again (`SkillBroker.again`, under the request's own id, so
its `skill.loaded` or `skill.refused` domain event names it) when what it waits on may have changed: a vault event of
the user's (`vault.credential_given`, `vault.credential_declined`, `vault.approved`, `vault.secret_set`,
`vault.secret_removed`), and when the job subscribes. A 200 ends the watch with `skill.loaded`, a no with
`skill.refused`; a 202 leaves it open. One at a time per watch; a change heard meanwhile asks it once more.

**A restart.** The events and the watches are in the user's schema (tenant migration 32: `job_stream`, `watches`;
tables only, the build before runs on them). The credential request is in memory and is lost, but its watch is not:
when the job subscribes again with `Last-Event-ID`, the hopper asks the request again, which opens the credential
request again, and the person's answer reaches the job.

**`hopper-skill --wait`** (`src/skills/script.ts`): POSIX sh, curl and awk. One `POST /job/skill`; on 202, the
`wait:` line names the request and its seconds. Then `GET /job/stream?request=ID` into a file, until the hopper ends
it; awk (`STREAM_AWK`) reads the last id and the ending event, and decodes a JSON string payload. A pointer is
fetched with `Accept: text/plain`. A stream that drops (a restart) is opened again after 1 s with `Last-Event-ID`; a
503 likewise. Exit 0 done, 1 failed or a refused token, 4 expired — the hopper's `hopper.expired`, or its own
deadline 5 s after the hopper's when no answer came.

Taken conservatively, each one place to change: stream events and watches are never pruned (a job's are few; a
retention policy is #613's to follow if they grow); only the skill broker emits — `started` and `progress` are phases
any part may register, none does yet; `hopper-gh` and `hopper-secret` answer at once and wait on nothing, so they do
not use the stream; the token is the job's proxy token, not the machine's client token: the stream is the job's, and
only the proxy token names a job.

| dir | owns | must not import |
|-----|------|-----------------|
| `src/job-stream/` | the stream types, the wire form and its one builder, one user's stream and its sweep | engine, http, store, plugins, executors, decider, skills |

Tests: `test/integration/job-stream.test.ts` (the real daemon, a joined box, the real `hopper-skill` behind a proxy
that counts its calls: the answer pushed with one ask; a restart in the middle of a wait, the job reconnecting with
`Last-Event-ID`; a large answer as a pointer whose fetch is the object the event describes; a wait past its deadline
ends as expired; a job sees only its own requests, a bad token nothing), `test/job-stream/wire.test.ts` (whole or
pointer, the frame, the registry's refusals), `test/integration/vault-requests.test.ts`.

## Artifacts (issue #624, 2026-10-10)

Agents make things a person should see: graphs, HTML pages, reports, images, CSVs. Before this they stayed in a job's
work tree or were pasted into text. Now a running job puts one on the hopper — an **artifact** — and gets a URL.

**The way in.** `hopper-artifact` (`src/artifacts/script.ts`), written to the job's credentials dir at each start beside
`hopper-gh` and `hopper-skill`, run as `sh "$HOPPER_ARTIFACT"`: POSIX sh, curl and od. It asks `/job/artifacts`
(`src/http/job-artifacts.ts`) outside the UI session, behind the Host guard, with the job's proxy token (issue #563),
honoured only while the job is at work (`AGENTS.md`). Every value but the file is percent-encoded in the query string,
byte by byte (`od`); the file is the body, `application/octet-stream`, read whole up to the most any setting allows
(100 MB). The **`artifacts` skill** (`src/skills/catalog.ts`) is lazy: the catalog has one line, and its text —
`ARTIFACT_HELP`, every command — is read only when the job loads it. The skill protocol line names it.

| command | route | answer |
|---------|-------|--------|
| `put FILE [--title] [--summary] [--type] [--to ID [--note]]` | `POST /job/artifacts` | 201 `put: <id> [revision <n>] <title> <type> <n> bytes` and `url: <stable URL>`; `--to`: a new revision (issue #675) |
| `list [--all] [--markdown]` | `GET /job/artifacts` | the job's (all: the user's); markdown links only through the public URL |
| `get ID [--out FILE]` | `GET /job/artifacts/:id[?content=1]` | its details and shares, or its content |
| `share ID --owner \| --user NAME \| --public [--hours N] \| --revoke SHARE` | `POST /job/artifacts/:id/share` | the share; a public link said once; with the owner, the comment posted (issue #673) |
| `revisions ID` | `GET /job/artifacts/:id/revisions` | its revisions, newest first (issue #675) |
| `restore ID N` | `POST /job/artifacts/:id/restore?revision=N` | revision N is the latest again, as a new revision (issue #675) |
| `rm ID` | `POST /job/artifacts/:id/rm` | removed, with its revisions and shares |

Agent-native: `--json` sends `Accept: application/json` and every answer is one JSON line with `ok`; exit 0 done, 1 a
no (with why), 2 a bad call, 3 the hopper not reached. A refusal is never a silent default: a type the hopper does not
know, an empty file, a size over the limit, public links off, a link past its most hours, a user the hopper does not
have.

**Storage.** In the user's schema (tenant migration 34, `migration-artifacts.ts`: `artifacts`, `artifact_shares`;
tables only, the build before runs on them), the content as `BYTEA` beside its row — no file, no volume: "Nothing
leans on the machine". The store's parameters are text, so content crosses as base64 (`decode`/`encode`); a list never
reads content. Each row: id, user, job, the job's issue (URL and `owner/repo#N`), title, file name, media type, size,
SHA-256, when. Kinds by media type (`src/domain/artifacts.ts`): `html`, `svg`, `image` (png, jpeg, gif, webp), `pdf`,
`csv`, `markdown`, `json`, `text`, else `file`; `--type` or the file name's extension decides.

**Secrets.** A text kind's content and every title pass `maskGitHubTokens` (issue #597) before they are kept;
`artifact.created` says how many were `masked`. What is kept is what a person shares.

**Hosting.** The **stable URL** is `<hopper>/#artifacts/<id>`: the UI's Artifacts view, which opens the artifact for
whoever may see it. **Which `<hopper>`** (issue #673; the first real artifact's link named the first LAN name, a container's
bare name no LAN client resolved): a person's read builds it from the Host they asked on (`ArtifactEdge.baseOf`; the
Host guard already let it in), so a link opens where they are; a link a job reports (`put`, `list`, `get`, a public
link), and a notification's, use the user's **link base** (Settings → Artifacts: an origin the hopper answers to, checked
against them when it is saved, else refused with the list), else the public URL, else the first LAN name that is an
IPv4 address or ends in `.local`, else the first LAN name, else loopback (`ArtifactEdge.base`). A link on GitHub is
still only ever the public URL's (below). Its content is never under `/api/` and needs no UI session: an `<img>` or `<iframe>` carries no
`x-hopper-session`, so the read that checked the viewer signs a **content URL** (`/artifact-content/<name>?v=<token>`,
`src/artifacts/content.ts`): HMAC-SHA-256 of owner, artifact, viewer and an expiry an hour away, under the owner's
**content URL key** — the owner named in the token picks the key that checks it. The key is a system secret
(`system/artifact-content-key`, "The TypeSafe API key in the vault's system scope"), sealed under the master key, made on
the first read that signs a URL (`src/users/artifact-key.ts`, issue #673): a restart opens it again, so a URL a viewer
holds works until its own expiry. With no master key, or a stored key that cannot be opened, the key lives only in the
process (the log says so once, and a stored key is left as it is): a restart then ends every URL, and the next read
signs a new one. The UI reads again every half hour and on every artifact event. The route checks the signature and, for a viewer who is not the owner, Access again, at each load.
The token rides in the query because Fastify caps a path parameter at 100 characters.

| kind | served as | policy (`Content-Security-Policy`) |
|------|-----------|------------------------------------|
| html, svg | `text/html`; svg its type | `sandbox allow-scripts allow-popups allow-downloads`; `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`; scripts, styles, images and fonts only `'unsafe-inline' data: blob:` (issue #673), and scripts also from `<origin>/artifact-lib/` (issue #675); `frame-ancestors 'self'` |
| image | its type | `sandbox; default-src 'none'` (no script, nothing fetched) |
| csv, markdown, json, text | `text/plain` | the same; the UI renders the preview |
| pdf | `application/pdf` | `frame-ancestors 'self'` (a sandbox stops the browser's PDF viewer) |
| file | `application/octet-stream`, a download | the same as image |

Every one: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (a signed URL or a link is a credential
for a while), `Cache-Control: private, no-store`, `Cross-Origin-Resource-Policy: same-origin`. The sandbox without
`allow-same-origin` gives the page an opaque origin: it reads none of the hopper's storage, so not the UI session
(kept in `localStorage`), and a request it could make to the API carries neither the session header nor an allowed
Origin. The UI frames it with the same sandbox attribute too. SVG is made safe by the policy, not by rewriting it: since
issue #675 an SVG is a drawing a job makes, as an HTML page is, so it gets the HTML policy and the UI frames it the same
way: its inline script runs, in an opaque origin, and reaches nothing.

**An artifact is a presentation medium (issue #675).** It is how a job presents its work to people: a shareable,
meaningful, dynamic page — a flowchart, a diagram, a chart, an interactive view — that shows the result itself, which a
person opens on a phone or a desktop, uses and shares. It is not tied to one format; the job picks the form that shows
the result best. Prose goes in the issue comment or the job result. The skill help (`ARTIFACT_HELP`,
`src/artifacts/script.ts`) says so, names the bundled libraries, and gives two examples: an interactive Mermaid
flowchart whose steps show their code when clicked, and a Chart.js chart with a filter. `visualWarning`
(`src/domain/artifacts.ts`) checks an HTML artifact for an `<svg>`, `<canvas>`, `<img>` or `<script>` (a script draws at
run time); with none, the artifact is kept, and the put answers a `warning`, which `artifact.created` carries to the
job's timeline (the event line shows it after the title) and its job stream. A warning, not a no: a page may draw
through an element the check does not know.

**Title and summary (issue #675).** Every artifact has a title (`--title`, else its file name) and a one-line summary
(`--summary`, whitespace folded, at most 300 characters, GitHub tokens masked): the Artifacts list, the job card's links,
a review card's embeds and the share page show it. A put with no summary is kept, with a warning. A revision keeps the
title and summary it does not change.

**Dynamic pages: the bundled libraries (issue #675).** A page runs inline script, and its sandbox loads nothing from
outside, so the hopper serves the libraries a page needs itself: Mermaid 12 (`/artifact-lib/mermaid.js`: flowcharts,
sequence, state, class and Gantt diagrams), Chart.js 4 (`/artifact-lib/chart.js`) and D3 7 (`/artifact-lib/d3.js`)
(`ARTIFACT_LIBS`, `src/artifacts/libs.ts`). They are dev dependencies: `npm run build:ui` copies the three files from
node_modules into `ui/dist/artifact-lib/` (`scripts/copy-artifact-libs.ts`), and the bundle check fails a build without
one, so the image and an install carry the files, not the packages. The daemon reads them at start, as it reads the UI
(a dir that is not there answers 503, a dir with a file missing stops the start), and serves each as JavaScript with
`Cross-Origin-Resource-Policy: cross-origin` — to a sandboxed page the hopper is another origin — and a day's cache. An
HTML or SVG artifact's policy (`htmlPolicy(origin)`) adds `<origin>/artifact-lib/` to its `script-src`, where `origin` is
the address the person opened it at (`ArtifactEdge.baseOf`), so the path matches on loopback, a LAN name and the public
URL alike. A request there reaches the hopper only; nothing leaves. Why bundled and served rather than inlined into
each page: Mermaid alone is 5.5 MB, over half of one artifact's default limit; why these three: each is the established
library for its job, and none needs `eval` or `new Function`, which the policy refuses (checked in Chromium: a Mermaid
flowchart renders and runs its click handler, and a Chart.js chart draws, in the opaque-origin sandbox).

**Revisions (issue #675).** Every change to an artifact is a **revision**, numbered from 1. A put with `--to ID` (a job of
the same user; the job that made it or a later one) makes the next one, with an optional one-line `--note`; the id, its
stable URL, its public links and its shares stay and show the latest. A person (UI, `hopper artifact restore`) or a job
(`restore ID N`) restores an old revision: its content, title, summary, name and type are copied as a new latest revision,
note `restored revision N` — nothing is overwritten or moved. Storage: the `artifacts` row stays the latest revision,
content included, with `revision`, `updated_at`, `revised_by`, `note`, `summary`, `pinned` (tenant migration 36,
`ARTIFACT_REVISION_TABLES` in `migration-artifacts.ts`); each older one is a row of `artifact_revisions` (key: artifact
and number; its content beside it; removed with its artifact). A new revision copies the row into `artifact_revisions`
in the database and then updates the row, in one transaction. So the build before reads and serves the latest as it did,
and what it puts is revision 1 by the columns' defaults; it removes an artifact by its first `created_at`, not its last
change, which is the one difference a rollback shows. `GET /api/artifacts/:id/revisions` lists them newest first (number,
time, who — `job <id>` or the person —, note, pinned, `latest`), and `GET /api/artifacts/:id/revisions/:n` reads one; each
with a content URL signed for the viewer, `&revision=N` beside the token (the signature covers the artifact; Access is per
artifact, so the number need not be signed). **A link to one revision**: the UI's `#artifacts/<id>/<n>` (the stable URL and
`/<n>`), and a public link's `?revision=N`; without it a link follows the latest. **Limits**: every revision counts toward
the user's quota, and each put and restore is checked against it. **Retention**: the sweep removes an older revision past
the retention unless it is pinned (`artifact.revision_removed`), never the latest; it removes an artifact whose latest
revision is past the retention unless one of its revisions is pinned. A person pins and unpins a revision in the UI
(`POST /ui/api/artifacts/:id/revisions/:n/pin`, `artifact.revision_pinned`). A new revision starts unpinned.

**The share page (issue #675).** A public link (`/artifact-link/<token>`) opens a page of the hopper's own (`sharePage`,
`src/http/artifacts.ts`), not the raw content: a phone viewport, the title and summary on top — as `<title>`,
`description` and Open Graph `og:title`/`og:description`, which chat apps read for a share preview —, which revision
it is with a link to the latest when it pins an older one, a download link, and the content below in a frame
(`/artifact-link/<token>/content[?revision=N]`, served as before under its kind's policy; HTML and SVG framed with the
UI's sandbox attribute, an image as an `<img>`). The page runs no script (`default-src 'none'; style-src 'unsafe-inline';
img-src 'self' data:; frame-src 'self'`), escapes every text the job wrote, and is `noindex`. The link checks are the
same for the page and the content: live, public links on, Access.

**It loads nothing from outside** (issue #673). The first real artifact showed the gap: with `https:` in its script,
style, image and font sources a page could load from any address, and send out what it read through the URL of an
image request — its own signed content URL included, a credential for an hour. So each of those four is
`'unsafe-inline' data: blob:` only, and no `'unsafe-eval'`: a page carries everything it needs. A popup it opens stays
in the sandbox (no `allow-popups-to-escape-sandbox`). The `artifacts` skill tells a job so. A separate origin for
`/artifact-content/` was looked at and not built: it needs a second host name or port that the Host guard, the LAN
names and any reverse proxy must all serve, and the sandbox's opaque origin already keeps the page from the hopper's
storage and session; it is the step to take if a browser's sandbox is ever found to leak.

**Share with the owner** (issue #673). The owner is the user whose job made the artifact, and sees it already: a share
with them — `share ID --owner`, or `--user` with their name, or the UI's share with their name — makes nothing and
succeeds (`ShareMade` `{ owner: true }`; it was refused before, "the artifact is yours already"). What a job means by it is
"show this to the person", so the job's route shows it: it posts the artifact's link on the job's issue as the job's own
comment, through the GitHub proxy (`GitHubProxy.handle` with the job's own token: the proxy's policy, limits and
`github_proxy.*` events apply; the job's request, as when it runs `hopper-gh`), and appends `artifact.posted` (the
comment's URL, or why it was not posted) on the job's timeline and stream, which the job card's event list shows. The
comment (`shownComment`) follows the publishing rule: a link only through the public URL, else the artifact's id and
"Open it in the hopper's Artifacts view" — never a LAN or loopback address, which a link base may be. A comment that
cannot be posted is a no (exit 1) with why; a job with no issue is told so.

**Sharing and Access.** By default only the owner sees an artifact. A **share** is with another user of the hopper (by
name) or a **public link** (`/artifact-link/<owner>.<random>`, 32 random bytes; only its SHA-256 is kept, and the link is
answered once). A share is live until revoked, a link until it expires: the user's default hours, at most their most
(Settings → Artifacts). Access decides every view by another user or a link (issue #559): the default model has
`type link` and `type artifact` with `owner`, `viewer: [user, link]` and `can_view: owner or viewer`; the hopper writes
each live share as a viewer tuple — computed from the share rows, like who is live (issue #581), pushed when they change
— and asks `can_view` (`Access.decideView`, not recorded: it is asked at each load). A model edited before this, without
those relations (`artifactGaps`), still decides every mint; every share is then denied with the reason, and the owner
still sees their own. A model the hopper wrote is upgraded to the default. A public link also needs the owner's public
links on: off in Settings → Artifacts, every one stops at once. Revoking a share, or removing the artifact, ends it at
the next load.

**Events.** `artifact.created` (on the job's timeline), `artifact.shared`, `artifact.share_revoked`, `artifact.removed`
(`removed` by a person or a job, or `retention`), `artifact.posted` (issue #673), `artifact.revised`, `artifact.revision_pinned`,
`artifact.revision_removed` (issue #675), `artifact.settings_changed`. `artifact.created`, `.shared`, `.share_revoked`,
`.removed`, `.posted` and `.revised` also go on the job's
**job stream** (issue #613) while the job is at work, phase `progress` (`src/artifacts/stream.ts`, registered as
`artifact` in `src/users/job-stream.ts`), so a waiting agent hears at once; the UI hears the domain events on its SSE.

**UI.** The Artifacts view (`#artifacts`, `#artifacts/<id>`, `#artifacts/<id>/<n>`): the user's own and the ones shared
with them, each with its title, summary and revision; its revisions (issue #675, `ui/src/views/artifact-revisions.tsx`):
number, when, who, note, pinned — open one (its own preview, title and summary, "Revision n of N"), copy a link to it,
pin or unpin it, restore it (the owner); a preview
by kind (HTML and SVG in a sandboxed frame; images; PDF; CSV as a table of its first 50 rows, papaparse; Markdown rendered by
marked into a frame with an empty sandbox; JSON and text as text), its job and issue, open, download, copy its URL,
remove, and the shares: share with a user, make a public link (shown once), revoke. Every card that names a job — the
job, question, proposal, research report and failure cards, through `JobTitle` — links its artifacts. A proposal or a
research report embeds an artifact by putting its URL in its text: the review card previews each one it links.
Settings → Artifacts (admin): the most one artifact and all of the user's may hold, the retention, public links on or
off, and their default and most hours.

**Notify and the CLI** (issue #673). A new artifact reaches the person through their notifier: the Grok Bot routine posts
`artifact.created` with the artifact's link ("Grok Bot routine webhook"). The operator CLI (`src/cli-operator.ts`, issue
#623: JSON out) has `hopper artifact list`, `get <id>`, `share <id> --with <name> | --public [--hours <n>]`, `revoke <id>
<share>`, `revisions <id>`, `restore <id> <n>` (issue #675) and `rm <id>`, each the UI's own read or `POST /ui/api/artifacts/…`; `--with`, since `--user` names the user the
CLI acts as.

**GitHub.** A link to an artifact on GitHub is a link to the hopper, which the publishing rule allows only through the
public URL: `list --markdown` gives links only when the hopper has one, else the titles, said to be on the hopper.

**Limits and retention.** Per artifact (default 10 MB) and per user (500 MB), checked at each put; a retention sweep
(at start, then hourly) removes artifacts older than the user keeps (30 days) with their shares (`artifact.removed`,
`retention`); since issue #675 it goes by the latest revision's time, and removes older revisions first ("Revisions").

| dir | owns | must not import |
|-----|------|-----------------|
| `src/artifacts/` | one user's artifacts — put, revise, restore, pin, share, revoke, remove, the limits, the masking, the retention sweep (`service.ts`); the content policy per kind and the signed content URL (`content.ts`); the bundled libraries and their route (`libs.ts`, issue #675); `hopper-artifact` and the skill's text (`script.ts`); the job stream types and the events put on it (`stream.ts`). Its rows through the `ArtifactRepository` port; its routes `src/http/artifacts.ts`, `src/http/job-artifacts.ts`, `src/http/ui/artifacts.ts` | engine, http, store, plugins, executors, decider |

Settled without asking, each one place to change: content in Postgres, not a volume (no config file, nothing on the
machine); a content URL's key is a system secret of its owner's, kept across restarts (issue #673); a public link is on by default and expires in a day, at most a
week; views are not recorded in Access's decisions (they would drown the mint decisions); a job lists its own artifacts
unless `--all`, and may get, share or remove any of its user's (the same person's work); SVG is neutralised by the
policy rather than rewritten.

Tests: `test/integration/artifacts.test.ts` (the real daemon, a joined machine, the real `hopper-artifact`: put an HTML
chart and get a URL, recorded with its job, issue and hash, on the timeline and the job stream, served under the
sandbox; a share with another user that works and stops after a revoke; a public link without a session, its most
hours, public links off and on, revoked; the size limit, a PNG byte for byte, a GitHub token masked, list and markdown,
rm, a token that is no job's, a bad call; the retention sweep), `test/integration/artifact-revisions.test.ts` (issue #675: a
put to an artifact is revision 2 under the same id, revision 1 readable, the API and the events; restore as a new revision;
the quota counts revisions; pin and the sweep; a public link follows the latest or pins one; the CLI),
`test/integration/artifact-pages.test.ts` (issue #675: the libraries copied and served to an opaque origin, a missing one
refused at start; an HTML page's script source is `/artifact-lib/` at the address used; the warnings; the share page;
the skill help), `test/ui/artifacts.test.ts` (the UI's model).

## A connection's health (issue #647, 2026-10-10)

On one evening a GitHub connection stopped for 45 minutes and the owner was not told. A sign-in replaced the stored
grant; GitHub then refused the new token; the renewer read GitHub's `incorrect_client_credentials` as a setup problem
and tried again about 52 times without saying "reconnect needed". A second sign-in fixed the connection, but jobs
already running kept the dead token until the next renewal, 7 hours later. #597 removed the revoke and the wrong
reading. This change closes the gaps that remained.

**Every new token reaches running jobs at once.** The connected accounts call `onToken` after every new token they
keep — a renewal, a connect from Sources, a sign-in (taken at once or from a held grant) — and the user runtime runs
`engine.renewCredentials` on it: each job at work with a **credentials dir** has its files (`gh/hosts.yml`) rewritten
through its machine's own connection, as after a renewal (#441). A job whose files cannot be rewritten gets a progress
line and `Job.credentialsWarning` (the job card shows it, `CredentialsFlag`); a later rewrite clears it.

**GitHub refusing the connection reads "reconnect needed".** The connection ends (`state: 'expired'`,
`connected_account.expired`, the header's "GitHub: reconnect needed") when GitHub refuses the refresh token
(`bad_refresh_token`), when it answers `incorrect_client_credentials` to a renewal sent with no client secret (#597),
and now also when GitHub answers 401 to a token the renewer renewed less than `FRESH_REFUSED_MS` (5 min) before: a
second renewal would not help. A source or proxy call that gets a 401 on the token it was just given reports it to
the renewer the same way. The header banner follows the source's status, pushed at the end, so it shows within the
renewer's minute.

**Renewals are recorded.** `connected_account.renewed { provider, account, expiresAt? }` for each renewal kept, and
`connected_account.renewal_failed { provider, account, code }` for each failed try: GitHub's OAuth error, else
`http_<status>`, `renewal_blocked` or `no_answer`. Never a token. The stored account keeps `renewedAt` and
`connectedBy` (`sources` or `sign-in`); the status adds them, `grantedBy`, `nextRenewalAt` (an hour before expiry, or
the retry of a failed renewal) and `lastError` (`{ at, error }`, kept after later renewals succeed, cleared by a new
grant). Sources shows them under the account (`ConnectionHealth`).

**A 401 skips the backoff at most once a minute** (`SKIP_BACKOFF_EVERY_MS`, per account). Before, every 401 asked
GitHub again during a failed renewal's backoff; a busy source made the backoff void.

**A sign-in never quietly replaces a healthy connection** (`src/connected-accounts/held.ts`). A GitHub sign-in made
while the connection is connected, readable, not ended and with no failed renewal waiting is checked at GitHub and then
**held** in memory, one per provider: the status shows `held { account, at }`, Sources asks Use this sign-in
(`take-held`: it replaces the connection, and running jobs get its token) or Keep this connection (`drop-held`: its
token is deleted at GitHub, best effort). Nobody acting within `HELD_MS` (15 min) drops it. A restart drops it
without deleting it; it then expires at GitHub on its own. A sign-in over a connection that is not healthy replaces
it at once, as before. Connect in Sources is the person's own act and replaces at once.

**Why a UI session is unknown is logged.** A request whose session token names no live session logs why: `expired:
<reason>` (it expired on this request), `ended: <reason>` (it ended earlier in this process: logout, connection-ended,
…), or `not found` (before this process started, a database reset, another hopper's). The cause of the session loss
on that evening is still unknown; this is what finds it the next time.

**The start check says which key is missing.** At start each connection the runtime cannot open logs `start check:`
with what is missing: `HOPPER_MASTER_KEY` (the runtime gives none), or the key it was sealed under (neither
`HOPPER_MASTER_KEY` nor `HOPPER_MASTER_KEY_PREVIOUS` opens it). It never asks for a new sign-in: that would mint another
grant toward GitHub's ten.

Tests: `test/connected-accounts/connection-health.test.ts` (renewed and failed renewals told, no token; a 401 on a
fresh token ends it; the backoff skipped once a minute; the status facts; a held sign-in taken, dropped, refused; a
sign-in over an ended connection replaces it and hands the token on; the start check), `test/integration/
connected-account-renewal.test.ts` (connecting again and a held sign-in taken reach a running job's `hosts.yml` within
10 s; one `connected_account.renewed` event with no token; `connected_account.renewal_failed` with its code; a job
whose files cannot be rewritten gets a progress line and a warning, cleared by the next rewrite),
`test/http/ui-sessions.test.ts` (why a session is unknown), `test/ui/sources-view.test.ts`,
`test/ui/credentials-warning.test.ts`.

## Agent text as Markdown (issue #569, 2026-10-10)

Owner requirement: questions, proposals, research reports and the like are long, and hard to read as plain text. The
UI renders them as Markdown, and the agents are told to write Markdown. Part 1 of the issue; the model-written summary
(below, "Not built") is carried.

**Where.** Every place the UI shows **agent text**: the question card (the question, each level's answer and reason),
the question history (the question and its answer), a parked job's question (Parked, issue #565), a proposal's or a
research report's parts and the review trail's notes, earlier versions too, Needs a person's assessment summary and a
resolution's note (issue #551), a recent failure's summary, and a phase shift's note — a fork's and a suggestion's
(issue #548). A line that is cut short (the question line of a parked row, a history row, an earlier review item's
headline, a note) renders its inline Markdown only. The raw error and the recent output stay as written: they are a
program's output, not agent text.

**Safe, two layers, each enough alone** (`ui/src/lib/markdown.ts`). The text comes from agents and, through issues, from
people the hopper does not know. The renderer (marked, already the artifacts' Markdown preview) makes only safe HTML: raw
HTML in the text is escaped and shows as text, block or inline; an image is never loaded — it is a link to its URL, named
by its alt text; a link goes only to `http:`, `https:`, `mailto:` or `#` (a view of the UI), with `target="_blank"` and
`rel="noopener noreferrer"`, and any other link is its text alone; a task list's box is a character, no form input.
DOMPurify then keeps only the tags a card needs (paragraphs, breaks, emphasis, code, blocks, lists, headings, rules,
links, tables) and the attributes `href`, `title`, `start`, `align`, `target`, `rel`, with the same link rule, and
sets the new-tab attributes on every link it keeps. The renderer is tested on its own: DOMPurify needs a browser's DOM,
and in happy-dom (the UI tests' DOM) it lets HTML through unchecked; the live check runs it in Chromium. `.md` in
`ui/src/index.css` keeps rendered text compact: the card's text size, small headings, tight lists, scrolled code
blocks and tables.

**Compact cards** (`ui/src/model/card-text.ts`, `CardText`). A text of at most 600 characters and 8 lines shows whole.
A longer one shows its **summary** — its first paragraph that is not a heading, a leading code block skipped, cut at
400 characters — and **Show all** opens the whole text (**Show less** folds it again). A review item's newest version
shows its first part (a proposal's Goal, a report's Question: the summary the pre-check asks for, issue #631), at its
summary, and Show all opens every part; an earlier version, already behind its own fold, shows whole. A question's
compact line (`firstLine`) is the first line of its summary, so a heading never stands in for the question.

**Agents write Markdown.** The default job rules carry one more line, `MARKDOWN_RULE` (`src/job-rules/`): "[hopper
formatting] Format the text you write for a person in the hopper (a question, a research report, a proposal, a note)
in Markdown: a short summary first, then sections and lists. Put names, paths and commands in code spans. Do not use
raw HTML or images." Saved job rules are the owner's: they carry it only if the owner adds it. The fixed protocol lines
say it whatever the saved rules say: the question line asks for one short sentence that says what is needed first, then
the context, with the options as a numbered list (the list Jev's `question-answer` point reads, issue #550); the
research and proposal lines ask for each part in Markdown, with a short summary first. A part's label may be a
Markdown heading or bold: `reviewSections` reads it either way (issue #537).

**Notifications and webhooks** carry the Markdown source as written, so a receiver can render it as the UI does: the
Grok Bot routine's question body has `question` (the text) and `questionFormat: 'markdown'`; the events keep `text`
(`question.asked`), `goal` (`proposal.submitted`) and `question` (`research.submitted`) as the agent wrote them.

The TL;DR on top of a long card is the next section's.

Tests: `test/ui/markdown.test.ts` (the renderer: every element kind, line breaks, raw HTML and script escaped, no image,
new-tab links, refused link schemes, inline lines; the summary and the long-text rule), `test/ui/markdown-cards.test.ts`
(a long question folded and opened, its HTML and script shown as text; a short one whole; a long proposal's Goal first
and the rest behind Show all; reviewer notes), `test/job-rules/markdown-format.test.ts`, `test/herdr/screen.test.ts` (the
footer verbatim), `test/plugins/grokbot-payload.test.ts`.


## TL;DR (issue #569, 2026-10-10)

Owner requirement: agents are long-winded, so every long card — a question, a proposal, a research report, a Needs a
person hand-off — leads with a **TL;DR**: one or two plain sentences, what is asked or proposed and what the person must
decide (for a question, its options in a few words each). The agent's Markdown is behind Show all.

- **Which cards** (`src/tldr/text.ts`). A card whose text is long by the card's own rule (more than 600 characters or
  8 lines, "Agent text as Markdown"): a question's text, a research report's newest round, a hand-off's summary and
  reasons. A short card is whole already and gets none. **A proposal is not one of them:** since issue #651 its agent
  writes a `TL;DR:` part first, the pre-check asks for it, and the proposal card shows it on top ("Proposals as paths");
  a second TL;DR from a model would say the same thing twice. Its notifications carry that part. The UI keeps its copy of the long-text and summary rules
  (`ui/src/model/card-text.ts`): it may not import `src/` at run time.
- **The model** (`src/tldr/haiku.ts`). Claude Haiku (the `haiku` alias) through the `claude` CLI in print mode, locked
  down as an escalation level's run is (no tools, MCP, settings or session; the answer bound to a JSON Schema; the prompt
  on stdin), with the user's CLI config dirs, in the user's work dir; 60 s at most. Jev (issue #550) is not asked: it
  picks one of a decision's options and writes no text. Tests put a double at the seam (`UserSeams.tldrWriter`); the
  test app's default fails, so no test starts `claude`. Checked once against the real CLI (`claude-haiku-4-5`): a long
  question with an injected instruction gave a plain two-sentence TL;DR with its options, the instruction ignored.
- **The prompt.** One or two plain sentences, at most 300 characters, in Simplified Technical English (one clause, as
  the protocol lines name it, issue #571), plain text only. The agent's text is fenced as data — it may hold whatever an
  issue's author wrote — and the model is told it is not instructions; a closing fence marker inside it is broken.
- **Plain text, whatever the model says** (`plainText`). Control characters, HTML tags, `<` and `>`, Markdown marks
  are taken out; an image or a link is its words; one line, cut at a word. The UI shows it as text (React escapes it),
  never as HTML; a receiver that renders Markdown finds none in it.
- **Written once, stored with the card** (`src/tldr/service.ts`). A sweep, every tick, over the open questions, research
  reports and hand-offs asks the model, one card at a time, for each long card whose stored TL;DR (`tldr: { text, of,
  model?, at }` in its body; no migration) was not written from its text as it is now — `of` is the SHA-256 of that
  text. So a research report's next round gets a new one, and nothing is written again on a render or a restart. A text
  the model failed on is not asked again for the same text (in memory: a restart tries once more). A card is never
  waited on; a text that changed while the model wrote is left for the next sweep. Each one written is
  `tldr.written { kind, id, text, model? }` on the card's job.
- **Shown while it matches** (`withShownTldr`). The question, research and hand-off routes answer a card's `tldr`
  only while it was written from the card's text as it is now and the setting is on.
- **The card** (`CardText`, `TldrLine`). A long text with a TL;DR shows the TL;DR, marked TL;DR, and Show all opens the
  whole text below it; without one, the summary as before. A research report's newest round: the TL;DR alone, every
  part behind Show all. A hand-off: the TL;DR under what happened.
- **Notifications and webhooks lead with it.** The human-stage events — `question.escalated` with target `human`,
  `question.escalated_to_human`, `proposal.escalated_to_human`, `research.escalated_to_human` — carry `tldr` for a long
  card: its TL;DR when written, else the agent's own summary (`summaryOf`: a review item's first part — a proposal's
  TL;DR part, a report's Question —, else the first paragraph that is not a heading; as plain text).
  The Grok Bot routine's question body has `tldr` first, after the sender and the job. A card that reaches a person
  before the model answers carries the agent's summary: the notification never waits.
- **The setting** (`tldr`, a user setting: `GET /api/tldr`, `POST /ui/api/tldr { enabled }`, admin,
  `tldr.settings_changed`; Settings → TL;DR). On by default. Off: nothing is written, the routes answer none, the
  events carry none; turned on again, the open cards get theirs at once. Read on every sweep and read, so no restart.

Tests: `test/tldr/text.test.ts` (the rules), `test/integration/tldr.test.ts` (written once, stored and shown; a short
question; the answer made plain; the model failing and the agent's summary in the event; a research report's next
round; a proposal led by its own TL;DR part, no model asked; the setting), `test/plugins/grokbot-payload.test.ts` (the body leads with it), `test/ui/markdown-cards.test.ts` (the
card, HTML in the TL;DR as text, the setting).
## A job's own wait (issue #483, 2026-10-10)

A job blocked on something only a person or the outside world can do (write access to be granted, a review, a release)
had no way to say so. The protocol had three end markers: a question, done and failed. A message with none was a status
note, nudged again and again; so a job that waited sent status notes, opened a question only to park itself (a wait on a
person's question list as if it needed an answer), or ended failed though it was not.

- **The marker.** A protocol line (`WAIT_LINE`, `src/job-rules/index.ts`): end the message with a line `HOPPER_WAITING`, then
  `for: <what you wait for>` and, if it can, `until: <how it will know>`. To be woken, the job first starts a command in the
  background that ends when the thing happens (a poll), and names it in `until:`. Never a question only to wait. The status
  note nudge names the marker too. A `HOPPER_WAITING` without a `for:` line is no wait: a status note.
- **Read.** herdr-claude: `readTurn` (`screen.ts`) reads the marker and its fields (`waitFields`); the monitor returns the
  outcome `{ kind: 'wait', wait: { for, until? } }` at once, with no nudge, and saves the turn with `parkedSeq` and
  `markersAfter` (the turn's output lines then). A print-mode agent: the marker, then its fields to the end of the answer
  (`outcomeOf`); its session id is saved, as on a question.
- **Recorded** (`src/engine/outcome.ts`): status `waiting_on`, `wait: { for, until?, since }` on the job, its lane freed,
  `resumeOn` its lane's machine, `job.waiting { for, until? }`. No question opens and none is counted; nothing is cleaned up:
  its pane and agent stay. It is not in the decider's inputs (it is neither queued nor running), and holds no lane.
- **It goes on by itself** (`src/engine/pane-answers.ts`). On every tick the engine probes each `waiting_on` job's pane, as a
  job on a question's (`answeredInPane`): Claude past the wait — working again, text typed in the pane, or new output past
  `markersAfter` (a short turn may be over by the time it is looked at) — ends it. The job runs again on a lane of its machine
  (one more over the cap when none is idle), `wait` cleared, `job.reattached { reason: 'the wait ended in the pane' }`, and the
  runner watches the turn with the wait already taken left out. Its own background poll ending is what wakes Claude: the
  hopper runs no check of its own.
- **A person ends it.** `POST /ui/api/jobs/:id/end-wait { note? }` (least role `operator`; 409 unless `waiting_on`): queued
  again with `waitEndedNote` pending, which pins it to `resumeOn` as an answer does; its claim types it into the pane (`[hopper] A
  person ended your wait: what you waited for (<for>) has happened. The person's note: <note> Check it, then go on with the
  job.`). `job.wait_ended { by: 'person', note? }`. A print-mode job resumes its session with it.
- **Cancel** works as for any job: the pane closes through the normal reap.
- **Live job.** A `waiting_on` job's processes still run on its machine (its background poll): it is in every "at work" list —
  credentials renewed, the GitHub proxy, skills, the vault, the job stream, artifacts, Access, the sweep and the rename guard
  keep it as live — and in `jobsOnMachine`.
- **UI.** The Overview's Waiting panel lists the jobs on their own wait in their own group ("On its own wait"), and the Queue
  view in its own panel (`WaitingOnRows`, `ui/src/views/overview/queue.tsx`): what it waits for, how it will know, its machine,
  since when; **End the wait** (operators) and Cancel. It is no question: not in Questions, its badge or Attention. The Waiting
  card counts it in its line. The lane timeline ends a span at `job.waiting`.
- **Not built.** Parking a job on its own wait; a check the hopper runs itself (the job's own background poll covers it); a
  note field for End the wait in the UI (the route takes one).
- **Persisted state.** No schema change: the status and `wait` are in the job's JSON. A build before this one, on a store
  holding a `waiting_on` job, shows it in no group and never runs it; its pane stays until it is cancelled.

## Item snapshots (issue #662, 2026-10-10)

Run again, the assessor's reruns, a problem's release and an item offered again by hand used to read the issue's live
title, body and comments. An issue edited after its first run then ran with text nobody approved: a way around every
check at intake. Now the text a job runs is the item's **snapshot**, and a live text that differs **holds** the job.

- **Recorded at intake** (`src/engine/item-snapshots.ts` `gateItem`, from `ingest` in `source-host.ts`): the first job of
  an item that can run records its **item text** — title, body and the assignee comments the job sees (`SourceItem.text`)
  — and its SHA-256 (`textHash`), in the user's `item_snapshots` table, one row per item key. `item.snapshot_recorded
  { key, hash, reason: 'intake' }`. A job that is invalid (an empty body) ran nothing and records none.
- **Every later job runs the snapshot.** Run again (`sources/rerun.ts`), the failure assessor's rerun and a problem's
  release (both `rerun(jobId, 'assessor')`), a failure's Retry and a hand-off's Run again, and an item offered again
  because a person removed its end label: each goes through `ingest`. Its item is rendered from the snapshot's text
  (`JobSource.withText`; GitHub: `promptWithText`, the untrusted block of issue #652 made from the snapshot's title, body
  and comments, the context block — priority, yolo mode, done line — as read now). A brief is appended after.
- **Changed → held.** When the live text hashes otherwise, the new job is created with the snapshot's text and a
  **text change** (`Job.textChange`: both texts, who edited it, and the job's text with the new text). The decider holds
  it before every other judgement (`TEXT_CHANGED`): no approval, acceptance or queue order starts it.
  `item.changed_since_snapshot { key, snapshotHash, liveHash, editors, newComments }` — never the text.
- **Edits while queued.** Each sync offers an item whose job has not ended again (`refresh`); a job not started whose
  item's text changed is held the same way (`refreshText`). Its comments are not read then (no extra call per poll), so
  only an edit of the title or body is a change; the comments it last saw stand in. The refresh never changes a job's
  task text: only its priority, and the config parts of its spec (executor, model, work tree, machine, issue #375).
- **Who edited it.** When the text changed, the sync loop asks the source's timeline (`JobSource.editsSince`, GitHub:
  GraphQL `userContentEdits` for the body and `RenamedTitleEvent` for the title, the newest 50 of each) for the edits since
  the snapshot (`sources/item-text.ts` `withEdits`). A timeline that cannot be read leaves them empty; the job still holds.
- **The card** (`ui/src/components/text-change.tsx`, in the Overview's Waiting panel and the Queue view): the title
  change, the body's lines removed and added (the `diff` library), the new assignee comments — not in the prompt unless
  accepted —, who edited it, and three ways on:
  - **Rerun the original** — `POST /ui/api/jobs/:id/keep-original` (operator; `hopper job keep-original <id>`): the hold
    ends, the job runs the snapshot's text, and that live text (`Job.originalKept`) holds it no more. `item.original_kept`.
  - **Accept the new text** — `POST /ui/api/jobs/:id/accept-new-text` (operator, and the owner only; `hopper job
    accept-new-text <id>`): Access asks OpenFGA `item#can_accept_text` for the signed-in user, telling at the check that the
    user whose hopper takes the item is its `owner` (`itemObject`: the owner and the key's SHA-256). Denied — OpenFGA not set
    up or not reached, or a model without `item` (`itemGaps`) — it answers 403 and nothing changes. Allowed, the job's spec
    takes the new text, it is the item's new snapshot, and the job runs it. `item.new_text_accepted { key, fromHash, toHash,
    editors, person, via }`, then `item.snapshot_recorded { reason: 'accepted' }`.
  - **Cancel** — the job's Cancel, as for any job.
- **Agents cannot accept.** A job reaches no `/ui/api/*` route (its proxy token opens only `/job/*`), and the operator CLI's
  call is the UI's route, under Access like a click.
- **Backfill** (tenant migration 35, `store/migration-item-snapshots.ts`): each item's first job gives its snapshot — the
  spec's goal as the title, its body, and the comments its prompt carried, read back (`commentsInPrompt`: from the
  untrusted block, or from the end of the context block for a prompt from before it). A comment cut
  short in the prompt reads back short, so that item's next job holds once: safe, never a run of unapproved text.
- **Not built.** A gate re-entry for the card once the intake gate (issue #655) ships; until then the card stands alone.
  A history of every snapshot (the events keep each hash). A snapshot for a source with no `withText` (the GitHub sources
  are the only ones with item text).
- **Persisted state.** A table only (`item_snapshots`); `textChange` and `originalKept` live in the job's JSON. A build
  before this one runs on the migrated store and ignores both fields: it would start a held job, with the snapshot's
  text, the approved one, never the edited text.

## No checks means ready (issue #677, 2026-10-10)

Issue #652 had yolo mode merge only a pull request with a check that passed. A repository with no checks then never
merged anything: its pull requests waited in the Pull requests list with `no checks`, and yolo mode did nothing there.

**The rule** (`src/domain/pull-requests.ts` `readyToMerge`, `noChecksSettled`, `NO_CHECKS_GRACE_MS`). Ready for the
hopper's merge: not a draft, no merge conflicts, and its checks passed — or it has none, and none started within the
grace window, two minutes after its last push (`pushedAt`: the later of when it was opened and its head commit). The
window keeps a check that starts late from being missed: a check that starts holds the merge until it passes, as
before. A repository's required checks are GitHub's: a merge without them is refused, and the refusal is kept on the
card (`merge refused`), as any refused merge. Yolo mode off: nothing changes, a person merges.

**Card states.** The follow keeps `pushedAt` and `base` (`baseRefName`) on what it saw (`PullRequestSeen`); the list,
given the time now, says why each card waits: `no pull request`, `not checked yet`, `draft`, `conflicts`, `checks
failing`, `yolo off`, `checks pending`, `checks not started`, `merge refused`, `ready`. The UI says each in plain words
(`ui/src/model/pull-requests.ts` `waitsText`): `waiting for a person to merge`, `waiting for checks`, `waiting for checks
to start`, `conflicts with <base>`, `ready, merging`, and so on.

**A pull request the report could not name** (the report names only a ready one) is looked for again at each follow: the
newest open one that closes the issue, else one in its repository that mentions it — a part when it says `Part of #N` —,
else one on a branch named for the issue. Found, it is named in the job's source state and followed as any other, so a
card never stays `not checked yet` or without its pull request for more than one sync.

**Persisted state.** `pushedAt` and `base` are new, optional fields in a job's source state. A build before this one
ignores them; a `seen` without `pushedAt` counts as pushed long ago.

**Not built in this part** (carried in issue #677): spotting repositories with no checks and recommending a job that adds
them (`hopper repo checks`); Merge now and Close PR on each card, with `hopper pr merge` and `hopper pr close`; closing the
linked issue after a merge when the pull request has no closing keyword.

Tests: `test/sources/pull-request-list.test.ts` (each card state, the grace window), `test/sources/github-follow.test.ts`
(no checks merges after the window, waits inside it; a pull request the report missed is found and named, a part as a
part), `test/integration/pull-requests.test.ts` (the real daemon: waits for checks to start, a late check holds it, an old
one with no checks merges), `test/ui/pull-requests-view.test.ts` (the plain words).
