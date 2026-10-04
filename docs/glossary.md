# job-hopper glossary

The application's words. Code, tests, events, API fields and UI use these and no
synonyms. Rename here first, in the same commit as everything else.

| term | meaning | not |
|------|---------|-----|
| **Job** | One unit of work pushed through the API: an executor name, a payload, a priority. | task, run |
| **Priority** | `0..100` on the job, higher first. Default 50. | rank |
| **Effective priority** | Priority after the router's boost (cheap advice), which applies only in active mode. | score |
| **Machine** | A host that can run jobs. Today: this laptop (`local`). Supplied by a `MachineSource`. | node, worker |
| **Lane** | One concurrent job slot on a machine. Opened and closed by Decisions. `idle`, `busy`, `draining`. | slot, worker, thread |
| **Draining** | A busy lane the Decision wants gone; it closes when its job ends. | |
| **Usage reading** | One budget measurement: `used` of `limit` in a `unit`, optionally for one machine. Supplied by a `UsageSource`. | quota |
| **Soft limit / hard limit** | Usage fractions. Past soft, the lane cap scales down; at hard, lanes stop. | |
| **Lane cap** | The most lanes a machine may run given its usage. | |
| **Decider** | The pure function `decide()`: inputs in, one Decision out. | scheduler |
| **Engine** | The loop that gathers inputs, calls the decider, applies the Decision. | daemon (the daemon is the whole process) |
| **Trigger** | What woke the engine: `tick` or an event type. | |
| **Decision** | The decider's single answer over all inputs: lane plans, starts, holds, divergences (`advice`), reasons, and the inputs themselves. | plan |
| **Admission** | Whether a waiting job may start now. | |
| **Hold** | A Decision keeping a waiting job out, with a reason. Status `held`. | block, defer |
| **Waiting** | Status `queued` or `held`. | pending |
| **Claim** | A Decision assigning a job to a lane, before the executor runs. | |
| **Executor** | Runs one job on one lane. The role whose 1..n instances are named in plugins.yaml `executors:`; a job names an executor instance (`spec.executor`). Built-in plugins `herdr-claude` (Claude Code in a herdr pane) and `test`. One that cannot run holds the jobs naming it (`executor <name> unavailable: …`); never fails or re-routes them. | runner, task (issue #6's "task" is an executor instance) |
| **Plugin** | One module implementing one role: built in (`src/plugins/<role>/<id>/`) or custom (one directory under the plugin dir). Default export a `PluginDefinition`. | extension, addon, adapter (an adapter is the code behind a port; a plugin is the swappable unit) |
| **Role** | A slot the engine calls through one port. Today: `router`, `answerer`, `assessor`, `executor`. A **live** role swaps its instance between calls when plugins.yaml changes; a **restart** role (`executor`) is built at start, and a change shows `changed — restart pending` in `/api/plugins`. | slot type, kind |
| **Plugin instance** | A plugin plus validated options, under a name (`jev`), chosen in `plugins.yaml`. | config, profile |
| **Command-bearing option** | A plugin option naming a program, its arguments, a working directory, an interpreter or a sourced file (`bin`, `args`, `cwd`, `python`, `jevSrc`, …). Marked `.meta({ commandBearing: true })`, carried into its JSON Schema; the UI never edits it (design.md "UI and mutation"). | |
| **Detection** | A plugin's cheap check that it can run here: `available`, `unavailable` + reason, or `needs-setup` + the command to run. | health check |
| **Plugin dir** | `~/.config/job-hopper/plugins` (`JOB_HOPPER_PLUGIN_DIR`): custom plugins, one directory each. | |
| **Plugins file** | `~/.config/job-hopper/plugins.yaml` (`JOB_HOPPER_PLUGINS_FILE`): which instance fills which role. Re-read on change. | |
| **Router** | The role that advises admission and order per job (`Router` port). Built-in plugins `jev-router` and `pass-through`. When the configured one cannot run, `pass-through` answers and its advice is `source: fallback`. | advisor, classifier |
| **Advice** | A router's action + reason + details for one job; `source` names the plugin, or `fallback`. | classification, verdict |
| **Router mode** | `shadow`: advice recorded, never applied. `active`: advice shapes admission and order. Decider state, in the store. | Jev mode |
| **Jev** | grok-bot-jev's usage router; one router plugin (`jev-router`). | |
| **Divergence** | A job where the advice's verdict differs from the native one. Recorded in both modes. | |
| **Waiting answer** | Status `waiting_answer`: a job stopped on a question. Holds no lane; its pane stays open. | blocked, paused (a *paused* source is something else) |
| **Question** | What a running job needs answered before it continues, with its escalation trail. | prompt, query |
| **Answerer** | The role that drafts an answer to a question: `{ answer, confident, reason }` (`Answerer` port). 0..1 instance; built-in `claude-cli`. None, or not confident, or failing → the question goes straight to the human. | answer tier, opus (`opus` is one instance name) |
| **Draft** | The answerer's proposed answer. Typed into the job only if the assessor does not escalate and no risk rule matches. | suggestion |
| **Assessor** | The role that decides whether the owner must see a question, given the request and the draft: `{ escalate, reason }` (`Assessor` port). Never answers. Fails closed: anything but a schema-valid `escalate: false` escalates. Built-in `claude-cli-assessor`; `always-escalate` stands in when the configured one cannot run. | reviewer, judge, fable (`fable` is one instance name) |
| **Assessment** | The assessor's verdict on one draft: `escalate` + `reason`; recorded as an attempt with `role: assessor`. | review, verdict |
| **Stage** | Where an open question is: the answerer's instance name (drafting), the assessor's (assessing), or `human`. Stored as the question's `tier`; `question.escalated.target` names the stage entered. | tier, level |
| **Escalation** | Sending a question to the human: no answerer, answerer not confident or failing, assessor escalating or failing, or a risk rule hit. (`question.escalated` also announces the answer and assess stages.) | |
| **Attempt** | One entry in a question's trail: an answerer's draft, an assessor's assessment, or the human's answer. `tier` = who, `role`, `outcome` `drafted` / `accepted` / `escalated`. Rows before slice 2 have no `role` and may carry `risky`. | try |
| **Risk rule** | A named pattern (delete, deploy, force-push, spend, credentials, send-message) over question and draft; a hit after the assessor escalates to the human whatever it said. Code, not configuration. | |
| **Rules file** | the owner's standing rules, given to the answerer and the assessor. | policy |
| **Reattach** | Restart recovery keeping a running job running: its pane and Claude outlived the daemon, so the executor watches the same turn again. Never a re-run. | resume (that delivers an answer), restart |
| **Resume** | Delivering an accepted answer to a job's parked pane and continuing it. | restart |
| **herdr session** | The named herdr server (`job-hopper`) that hosts job panes. Never the user's default session. | |
| **Pane** | The herdr terminal a herdr-claude job runs in; one tab per job run. | window |
| **Parked pane** | The pane of a job waiting on an answer. | |
| **Job source** | Where the hopper pulls jobs from (`github` today). Nothing pushes jobs. | inbox, feed |
| **Source item** | One eligible thing a source offers — for GitHub, an open issue labelled `hopper` by an allowlisted author. | |
| **Source key** | The id of a source item (the issue URL). Many jobs may share one (see re-run); the newest is the key's job. | |
| **Re-run** | A new job for a source key whose newest job failed or was cancelled and whose end the source already reported — offered again because a human cleared the marker (`hopper:failed`). Never from `finished`. | retry, resubmit |
| **Claim** (of an issue) | Labelling it `hopper:claimed` and commenting, when the hopper takes it. Distinct from a lane claim. | |
| **Sync** | One pass of a source: discover, check active jobs, retry reports. | poll |
| **Report** | Telling the source what happened to its job (comments, labels). | |
| **Signal** | What a source tells the hopper: cancel, or a human answer. | |
| **Hopper marker** | The hidden first line of every hopper comment; tells its comments from the owner's replies. | |
| **UI session** | A browser session created from the one-time login code; the only way to mutate. | |
| **Payload version** | `schemaVersion` on every event: the version of that event type's payload schema. | |
| **GitHub App** | job-hopper's own GitHub identity (`job-hopper-<owner>[bot]`), created by the owner via the manifest flow. | bot account |
| **Installation** | Where the owner installed the app; its repos are the only ones the `github-app` source scans. | |
| **Bot login** | The app's author name on GitHub; how hopper comments are identified (the marker is secondary). | |
| **Paused** (source) | A job source that must not discover new items right now — the gh source while a GitHub App is configured, the app source while none is. It still checks and reports its own active jobs. Only for sources; a job waiting on a question is *waiting answer*, never "paused". | |
| **Token keeper** | The part of the app source that mints, refreshes and deletes job token files. | |
| **Job token file** | A per-job file holding a short-lived installation token scoped to one repo, `issues: write`. | |
| **hopper-comment** | The helper a job runs to comment on its own issue as the app. | |
| **Manifest flow** | GitHub's create-app-from-a-manifest flow, driven by `create-github-app.sh`. | |
| **Event** | One recorded state change, `seq`-ordered, in the event log. Wire type dotted (`job.queued`). | message |
| **Webhook subscription** | A URL + event filter + HMAC secret that receives events. | hook |
| **Grok Bot routine webhook** | The one POST (bearer key, from `grokbot-webhook.env`) to a Grok Bot routine when a question reaches the human. Questions only. Not a *Webhook subscription*; nothing stored. | |
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
| QuestionExpired | `question.expired` |
