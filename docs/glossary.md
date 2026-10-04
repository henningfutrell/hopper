# job-hopper glossary

The application's words. Code, tests, events, API fields and UI use these and no
synonyms. Rename here first, in the same commit as everything else.

| term | meaning | not |
|------|---------|-----|
| **Job** | One unit of work pushed through the API: an executor name, a payload, a priority. | task, run |
| **Priority** | `0..100` on the job, higher first. Default 50. | rank |
| **Backburner** | The `hopper:backburner` label on an issue: the GitHub sources never pick it up while it is set, and cancel a waiting job whose issue gets it. Not a priority. | parked, paused |
| **Effective priority** | Priority after the router's boost (cheap advice), which applies only in active mode, or the resume boost of a job resuming with an answer. The decider's notion (`effectivePriority`, `src/decider/assign.ts`); the queue sorter is given it. | score |
| **Queue sorter** | The role that orders the waiting jobs (`QueueSorter` port: `sort(entries) → job ids`). Live, exactly one instance (plugins.yaml `queueSorter:`; absent → the built-in `priority`). Built-in plugins `priority` (effective priority, then oldest, then id — the decider's own rule), `oldest-first`, `newest-first`. It orders; it never admits or holds. One that cannot run, throws, or returns anything but distinct waiting job ids → `priority` answers, `fallback` in `/api/plugins`. | scheduler, ranker |
| **Queue order** | The queue sorter's order of the waiting jobs for one Decision (`DecisionInputs.queueOrder`: sorter instance + job ids). Step 6 orders admissible jobs by it; jobs it leaves out follow by the decider's own rule. `/api/queue` `waiting` is in the same order. | ranking |
| **Machine** | A host that can run jobs: this laptop (`local`) and every attached machine. This one is supplied by the machine source: the `machine-source` role's one instance (plugins.yaml `machines:`, built-in plugin `local`, named after the instance; its `lanes` option is the lane count). None that can run → no machine here; attached machines still run what they list. | node, worker |
| **Attached machine** | Another host that runs jobs in its own herdr session, reached over ssh; plugins.yaml `attachedMachines:` (beside the machine source's machine, followed without a restart). Online while that session answers. Added, edited and removed from the UI by a **machine edit**. | remote, worker, consumer (issue #10's word) |
| **ssh target** | The ssh destination of an attached machine: a `~/.ssh/config` alias or `user@host`. | host |
| **Detected ssh target** | A `Host` alias of `~/.ssh/config` (patterns excluded, `Include` followed): the only ssh target a machine edit may add. | known host |
| **Machine edit** | A UI change to plugins.yaml `attachedMachines:` (`POST /ui/api/machines`): add, edit (lanes, executors, label) or remove one attached machine, against the file's `version`. Never sets `ssh` beyond a detected ssh target, nor `herdrBin` (resolved over ssh) or `session`. | machine config |
| **Lane** | One concurrent job slot on a machine. Opened and closed by Decisions. `idle`, `busy`, `draining`. | slot, worker, thread |
| **Draining** | A busy lane the Decision wants gone; it closes when its job ends. | |
| **Usage reading** | One budget measurement: `used` of `limit` in a `unit`, optionally for one machine, optionally of one usage window, optionally informational. Supplied by usage sources: the `usage-source` role's 0..n instances (plugins.yaml `usageSources:`; an absent section → the built-in `claude` instance of `claude-plan`; the fake is a test double). | quota |
| **Usage window** | The period a usage reading measures, as its source names it (`window`): claude-plan's `session` (5 h), `week` (all models), `week (Fable)`. | period, bucket |
| **Informational reading** | A usage reading that is shown but never throttles lanes (`informational: true`): its budget limits one model, not every job — claude-plan's `week (Fable)`, or a window it does not know. The decider's step 1 skips it. | advisory |
| **Account** | Who a part acts as on an outside service: the Claude account a usage source reads usage for (email, plan), the GitHub user the `github-gh` source acts as, the GitHub App bot the `github-app` source acts as and its installation repos. `GET /api/accounts`. Facts only, never a token. | identity (in UI copy), credentials |
| **Lane effect** | What usage does to one machine's lanes now: its used fraction, lane cap and band (`free`, `soft`, `hard`, `offline`) — the decider's steps 1-2 over the current readings. `GET /api/usage` `machines`. | |
| **Soft limit / hard limit** | Usage fractions. Past soft, the lane cap scales down; at hard, lanes stop. | |
| **Lane cap** | The most lanes a machine may run given its usage. | |
| **Decider** | The pure function `decide()`: inputs in, one Decision out. | scheduler |
| **Engine** | The loop that gathers inputs, calls the decider, applies the Decision. | daemon (the daemon is the whole process) |
| **Trigger** | What woke the engine: `tick` or an event type. | |
| **Decision** | The decider's single answer over all inputs: lane plans, starts, holds, divergences (`advice`), reasons, and the inputs themselves. | plan |
| **Admission** | Whether a waiting job may start now. | |
| **Overlap** | Two jobs whose work touches the same thing. The jobs settle it, never the hopper: a job states the assumptions it made about the other work, or makes the needed fix in the other project, annotated with which way the dependency runs. Nothing holds a job for an overlap. | dependency hold, blocked-by |
| **Hold** | A Decision keeping a waiting job out, with a reason. Status `held`. | block, defer |
| **Waiting** | Status `queued` or `held`. | pending |
| **Ended** | Status `finished`, `failed` or `cancelled` (`TERMINAL_STATUSES`). `/api/queue` `ended` lists the 20 most recent, newest end first. *Finished* is only the success status. | done, completed, terminal (in UI copy) |
| **Lane span** | One run of one job on one lane: from `job.started` (or `job.reattached`) to the event that ended it — `finished`, `failed`, `cancelled`, `requeued`, `question` — or still `running`. Derived in the UI from the event log; drawn as a bar on the lane timeline. | slot, run |
| **Attention** | The UI list of what wants a human now: open questions, a router in fallback, sources in error, recent failures. Derived; nothing stored. | alerts, notifications |
| **Claim** | A Decision assigning a job to a lane, before the executor runs. | |
| **Executor** | Runs one job on one lane. The role whose 1..n instances are named in plugins.yaml `executors:`; a job names an executor instance (`spec.executor`). Built-in plugins `herdr-claude` (Claude Code in a herdr pane) and `test`. One that cannot run holds the jobs naming it (`executor <name> unavailable: …`); never fails or re-routes them. | runner, task (issue #6's "task" is an executor instance) |
| **Plugin** | One module implementing one role: built in (`src/plugins/<role>/<id>/`) or custom (one directory under the plugin dir). Default export a `PluginDefinition`. | extension, addon, adapter (an adapter is the code behind a port; a plugin is the swappable unit) |
| **Role** | A slot the engine calls through one port. Today: `router`, `queue-sorter`, `answerer`, `assessor`, `executor`, `job-source`, `machine-source`, `usage-source`, `notifier`. A **live** role (`router`, `queue-sorter`, `answerer`, `assessor`) swaps its instance between calls when plugins.yaml changes; a **restart** role (`executor`, `job-source`, `machine-source`, `usage-source`, `notifier`) is built at start, and a change shows `changed — restart pending` in `/api/plugins` — except the machine source's options (its lane count), which apply live. A **list role** (`executor`, `job-source`, `usage-source`, `notifier`) holds 0..n instances (executors 1..n), each added or removed from the UI under its own name; the others hold one instance (the answerer 0..1). | slot type, kind |
| **Plugin instance** | A plugin plus validated options, under a name (`jev`), chosen in `plugins.yaml`. | config, profile |
| **Command-bearing option** | A plugin option naming a program, its arguments, a working directory, an interpreter or a sourced file (`bin`, `args`, `cwd`, `defaultCwd`, `repoPaths`, `python`, `jevSrc`, …), or the endpoint a credential is sent to (`apiUrl`), or the file that selects an identity's key (`appFile`) or holds a key and the URL it is sent to (`envFile`). Marked `.meta({ commandBearing: true })`, carried into its JSON Schema; the UI never edits it (design.md "UI and mutation"). | |
| **Detection** | A plugin's cheap check that it can run here: `available`, `unavailable` + reason, or `needs-setup` + the command to run. A job source or notifier that needs setup still runs (it waits, then works without a restart); any other role's does not. | health check |
| **Plugin dir** | `~/.config/job-hopper/plugins` (`JOB_HOPPER_PLUGIN_DIR`): custom plugins, one directory each. | |
| **Plugins file** | `~/.config/job-hopper/plugins.yaml` (`JOB_HOPPER_PLUGINS_FILE`): which instance fills which role, and every part's options — the only configuration of a part (env holds process settings only). Re-read on change. Always present: the boot that finds none writes it (mode 600) — the **plugins-file migration**, from sources.yaml and the removed env vars, or the built-in instances; it never replaces one. A section left out means the built-in instances. Also written by the UI's **options edit** (one instance's options; never a command-bearing one), **select** (a plugin for a one-instance role), **add** and **remove** (an instance of a list role) and **machine edit**, each against the file's `version` (sha-256 of its bytes). | config file |
| **Rescan** | Re-read the plugin dir and re-run every detection, from the UI (`POST /ui/api/plugins` `rescan`). | refresh |
| **Router** | The role that advises admission and order per job (`Router` port). Built-in plugins `jev-router` and `pass-through`. When the one named in `plugins.yaml` cannot run, `pass-through` answers and its advice is `source: fallback`. Not the assessor: the router never sees a question. | advisor, classifier |
| **Router selection** | How the router instance was chosen: `file` (named in `plugins.yaml`) or `detected` (none named: the first router plugin that can run here, built-ins first, then custom; `pass-through` when none can — chosen, not a fallback). | auto, default router |
| **Advice** | A router's action + reason + details for one job; `source` names the plugin, or `fallback`. | classification, verdict |
| **Router mode** | `shadow`: advice recorded, never applied. `active`: advice shapes admission and order. Decider state, in the store (`JOB_HOPPER_ROUTER_MODE` only seeds it). | Jev mode |
| **Jev** | grok-bot-jev's usage router; one router plugin (`jev-router`). | |
| **Jev gate** | One named judgement Jev's router asks about a job (`intent`, `reuse_cache`, `needs_subagent`, `stop_retry`, `complexity`), answered by TypeSafe or Haiku; `details.gatesBy` says which. Jev's own code calls them questions; here **question** is a job's question to a human. | question, classification |
| **TypeSafe** | Jev's own gate service (`typesafe_sdk`); answers the gates in `typesafeGates` when its key is set (`TYPESAFE_API_KEY` or `typesafeKeyFile`, read per call). The owner calls it "the decider"; here **Decider** is `decide()`. | decider |
| **Divergence** | A job where the advice's verdict differs from the native one. Recorded in both modes. | |
| **Waiting answer** | Status `waiting_answer`: a job stopped on a question. Holds no lane; its pane stays open. | blocked, paused (a *paused* source is something else) |
| **Question** | What a running job needs answered before it continues, with its escalation trail. | prompt, query |
| **Answerer** | The role that drafts an answer to a question: `{ answer, confident, reason }` (`Answerer` port). 0..1 instance; built-in `claude-cli`. None, or not confident, or failing → the question goes straight to the human. | answer tier, opus (`opus` is one instance name) |
| **Draft** | The answerer's proposed answer. Typed into the job only if the assessor does not escalate and no risk rule matches. | suggestion |
| **Assessor** | The role that decides whether the owner must see a question, given the request and the draft: `{ escalate, reason }` (`Assessor` port). Never answers. Fails closed: anything but a schema-valid `escalate: false` escalates. Built-in `claude-cli-assessor`; `always-escalate` stands in when the configured one cannot run. | reviewer, judge, fable (`fable` is one instance name) |
| **Assessment** | The assessor's verdict on one draft: `escalate` + `reason`; recorded as an attempt with `role: assessor`. | review, verdict |
| **Stage** | Where an open question is: the answerer's instance name (drafting), the assessor's (assessing), or `human`. Stored as the question's `tier`; `question.escalated.target` names the stage entered. | tier, level |
| **Escalation** | Sending a question to the human: no answerer, answerer not confident or failing, assessor escalating or failing, or a risk rule hit. (`question.escalated` also announces the answer and assess stages.) | |
| **Closed** (question) | Status `closed`: The owner ended an open question without answering (UI Close). The **close text** ("The owner closed this question without answering. Continue on your own judgement; if you cannot, end with JOB_HOPPER_FAILED and say why.") is typed into the job in place of an answer; any stage in flight is aborted. `question.closed`. | dismissed, skipped |
| **Attempt** | One entry in a question's trail: an answerer's draft, an assessor's assessment, or the human's answer. `tier` = who, `role`, `outcome` `drafted` / `accepted` / `escalated`. Rows before slice 2 have no `role` and may carry `risky`. | try |
| **Risk rule** | A named pattern (delete, deploy, force-push, spend, credentials, send-message) over question and draft; a hit after the assessor escalates to the human whatever it said. Code, not configuration. | |
| **Rules file** | the owner's standing rules, given to the answerer and the assessor: `JOB_HOPPER_RULES_FILE` (default `~/.config/job-hopper/rules.md`), read on every ask. Edited by hand or whole from the UI (`POST /ui/api/rules-file`, against its `version`, the sha-256 of its bytes). | policy |
| **Question gates** | The chain an open question goes through: answerer → assessor → risk rules → the owner. The UI's panel of that name (Questions view) shows each stage's state and edits the answerer, the assessor and the rules file; `GET /api/question-gates` reads the rules file and the risk rules. | escalation chain, pipeline settings |
| **Reattach** | The executor watching a job's live pane again without sending anything: restart recovery keeping a running job running (its pane and Claude outlived the daemon), or a parked job *answered in the pane*. Never a re-run. | resume (that delivers an answer), restart |
| **Answered in the pane** | the owner typed the answer straight into a parked pane. The hopper sees Claude working again, marks the question answered by `human` (`question.answered { via: "pane" }`) with the typed text, or `(answered in the pane)` when it cannot be read, and reattaches the job on a lane. | |
| **Resume** | Delivering an accepted answer to a job's parked pane and continuing it. | restart |
| **herdr session** | The named herdr server (`job-hopper`) that hosts job panes. Never the user's default session. | |
| **Pane** | The herdr terminal a herdr-claude job runs in; one tab per job run. | window |
| **Parked pane** | The pane of a job waiting on an answer. | |
| **Job source** | Where the hopper pulls jobs from: the `job-source` role's 0..n instances (plugins.yaml `jobSources:`). Built-in plugins `github-gh` (instance `github`) and `github-app` (instance `github-app`); the instance name keys its jobs and sync state. Nothing pushes jobs. | inbox, feed |
| **Source item** | One eligible thing a source offers — for GitHub, an open issue labelled `hopper` by an allowlisted author. | |
| **Routing rule** | One entry of plugins.yaml `routing:`, an ordered list (absent: none): a `name`, a `match` (any of `source` — the job-source instance —, `repo` with `*` globs, `label`, `author`, `title` substring; all case-insensitive; every field given must match, none given matches every item) and a `set` (any of `machine` — the job's machine pin —, `executor`, `priority` 0..100). Applied at intake, when a source item becomes a job: the **first** matching rule wins. A matching rule naming a machine or executor that is not configured is skipped with a warning, never failing intake. A change applies to new jobs only. Never a lane. Edited in the UI (`POST /ui/api/routing`). | route, filter, lane rule |
| **Routed by** | `spec.routedBy` `{ rule, set }`: the routing rule that set a job's machine, executor or priority at intake, and what it set. A source's re-sort leaves a priority a rule set alone. | |
| **Source key** | The id of a source item (the issue URL). Many jobs may share one (see re-run); the newest is the key's job. | |
| **Re-run** | A new job for a source key whose newest job failed or was cancelled and whose end the source already reported — offered again because a human cleared the marker (`hopper:failed`). Never from `finished`. | retry, resubmit |
| **Claim** (of an issue) | Labelling it `hopper:claimed` when the hopper takes it (no comment). Distinct from a lane claim. | |
| **Sync** | One pass of a source: discover, check active jobs, retry reports. | poll |
| **Report** | Telling the source what happened to its job: the claim and the end. On GitHub: labels only; the hopper posts no comment. | |
| **Signal** | What a source tells the hopper: cancel. Questions are answered in the UI, never through a source. | |
| **Hopper marker** | The hidden first line of a comment the hopper once posted (it posts none now); lets the context filter tell old ones from the owner's text. | |
| **Leftover variable** | A `JOB_HOPPER_*` variable that is set but read by nothing (a removed part-choosing one, or a typo). One loud warning at boot names them all. | |
| **UI session** | A browser session created from the one-time login code; the only way to mutate. | |
| **LAN name** | A host name or address the UI answers to from other machines (`JOB_HOPPER_LAN_NAMES`), with the port. A request naming one is a **LAN request**: it reads `/api/` only with a UI session. | remote host |
| **LAN peer** | A CIDR range a LAN request may come from (`JOB_HOPPER_LAN_PEERS`). Any other non-loopback peer is refused. | allowlist |
| **Device link** | `http://<LAN name>:<port>/#login=<code>`: the current login code as a link a logged-in browser hands another device. Works once. | pairing link, invite |
| **Payload version** | `schemaVersion` on every event: the version of that event type's payload schema. | |
| **GitHub App** | job-hopper's own GitHub identity (`job-hopper-<owner>[bot]`), created by the owner via the manifest flow. | bot account |
| **Installation** | Where the owner installed the app; its repos are the only ones the `github-app` source scans. | |
| **Bot login** | The app's author name on GitHub; how old hopper comments are identified for the context filter (the marker is secondary). | |
| **Paused** (source) | A job source that must not discover new items right now — the gh source while a GitHub App is configured, the app source while none is. It still checks and reports its own active jobs. Only for sources; a job waiting on a question is *waiting answer*, never "paused". | |
| **Manifest flow** | GitHub's create-app-from-a-manifest flow, driven by `create-github-app.sh`. | |
| **Event** | One recorded state change, `seq`-ordered, in the event log. Wire type dotted (`job.queued`). | message |
| **Webhook subscription** | A URL + event filter + HMAC secret that receives events. One entry of the *webhooks file*, keyed by its `name`; *active* or paused. | hook |
| **Webhooks file** | `~/.config/job-hopper/webhooks.yaml` (`JOB_HOPPER_WEBHOOKS_FILE`): every webhook subscription — the only source of them. Re-read on change. Also written by the UI's webhooks edits (**add**, **edit** — url, events, active; **rotate-secret**; **remove**), one entry each, against the file's `version` (sha-256 of its bytes, or `missing`). | config file |
| **Rotate secret** | Replace a subscription's HMAC secret with a new one the daemon makes (32 random bytes, hex). The new secret is shown once, in the answer; a `secretFile` secret is rotated in that file only. | regenerate, reset |
| **Notifier** | The role that tells something outside about events (`Notifier` port: `start(events)`, `stop()`). 0..n instances (plugins.yaml `notifiers:`; absent → the built-in `grok-bot` instance). Built-in plugin `grokbot-routine`. One that cannot run is dropped, its reason in `/api/plugins`. Not a *Webhook subscription*: no store row, no delivery. | connector (issue #6's word for a source or notifier instance) |
| **Grok Bot routine webhook** | The one POST (bearer key, from the `grokbot-routine` notifier's `envFile`, default `grokbot-webhook.env` beside plugins.yaml) to a Grok Bot routine when a question reaches the human. Questions only. Not a *Webhook subscription*; nothing stored. | |
| **Delivery** | One attempt series sending one event to one subscription. `pending`, `retrying`, `delivered`, `failed`. | |

## Events

| domain name | wire type |
|-------------|-----------|
| JobQueued | `job.queued` |
| JobPrioritized (by the router) | `job.prioritized` |
| JobHeld | `job.held` |
| JobApproved | `job.approved` |
| JobClaimed | `job.claimed` |
| JobStarted | `job.started` |
| JobProgressed | `job.progressed` |
| JobFinished | `job.finished` |
| JobFailed | `job.failed` |
| JobCancelled | `job.cancelled` |
| JobRequeued (via restart) | `job.requeued` |
| JobReattached (via restart) | `job.reattached` |
| LaneOpened | `lane.opened` |
| LaneClosed | `lane.closed` |
| DecisionMade | `decision.made` |
| RouterModeChanged | `router.mode_changed` (was `jev.mode_changed`; stored ones keep that type) |
| QuestionAsked | `question.asked` |
| QuestionEscalated (to a stage) | `question.escalated` |
| QuestionAnswered (by an answerer instance, or the human) | `question.answered` |
| QuestionClosed (by the human, without an answer) | `question.closed` |
| QuestionExpired | `question.expired` |
