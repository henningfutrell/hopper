# job-hopper glossary

The application's words. Code, tests, events, API fields and UI use these and no
synonyms. Rename here first, in the same commit as everything else.

| term | meaning | not |
|------|---------|-----|
| **Job** | One unit of work pushed through the API: an executor name, a payload, a priority. | task, run |
| **Priority** | `0..100` on the job, higher first. Default 50. | rank |
| **Effective priority** | Priority after Jev's boost, which applies only in active mode. | score |
| **Machine** | A host that can run jobs. Today: this laptop (`local`). Supplied by a `MachineSource`. | node, worker |
| **Lane** | One concurrent job slot on a machine. Opened and closed by Decisions. `idle`, `busy`, `draining`. | slot, worker, thread |
| **Draining** | A busy lane the Decision wants gone; it closes when its job ends. | |
| **Usage reading** | One budget measurement: `used` of `limit` in a `unit`, optionally for one machine. Supplied by a `UsageSource`. | quota |
| **Soft limit / hard limit** | Usage fractions. Past soft, the lane cap scales down; at hard, lanes stop. | |
| **Lane cap** | The most lanes a machine may run given its usage. | |
| **Decider** | The pure function `decide()`: inputs in, one Decision out. | scheduler |
| **Engine** | The loop that gathers inputs, calls the decider, applies the Decision. | daemon (the daemon is the whole process) |
| **Trigger** | What woke the engine: `tick` or an event type. | |
| **Decision** | The decider's single answer over all inputs: lane plans, starts, holds, Jev divergences, reasons, and the inputs themselves. | plan |
| **Admission** | Whether a waiting job may start now. | |
| **Hold** | A Decision keeping a waiting job out, with a reason. Status `held`. | block, defer |
| **Waiting** | Status `queued` or `held`. | pending |
| **Claim** | A Decision assigning a job to a lane, before the executor runs. | |
| **Executor** | Runs one job on one lane: `test` (built in) or `herdr-claude` (Claude Code in a herdr pane). | runner |
| **Jev** | grok-bot-jev's usage router: classifies a request and returns an action. | |
| **Jev advice** | Jev's action + reason + details for one job. | |
| **Advisor** | The adapter producing Jev advice: `router` (the real one) or `fake`. | |
| **Jev mode** | `shadow`: advice recorded, never applied. `active`: advice shapes admission and order. | |
| **Divergence** | A job where the Jev verdict differs from the native one. Recorded in both modes. | |
| **Waiting answer** | Status `waiting_answer`: a job paused on a question. Holds no lane; its pane stays open. | blocked, paused |
| **Question** | What a running job needs answered before it continues, with its escalation trail. | prompt, query |
| **Answer tier** | Who may answer, in order: `opus`, `fable`, `human`. | level |
| **Escalation** | Passing a question to the next tier because the last was not confident or the question is risky. | |
| **Attempt** | One tier's try at a question: answer, confident, risky, risk rules, reason. | |
| **Risk rule** | A named pattern (delete, deploy, force-push, spend, credentials, send-message) that makes a question risky regardless of the model. | |
| **Rules file** | the owner's standing rules, given to every model tier. | policy |
| **Resume** | Delivering an accepted answer to a job's parked pane and continuing it. | restart |
| **herdr session** | The named herdr server (`job-hopper`) that hosts job panes. Never the user's default session. | |
| **Pane** | The herdr terminal a herdr-claude job runs in; one tab per job run. | window |
| **Parked pane** | The pane of a job waiting on an answer. | |
| **Job source** | Where the hopper pulls jobs from (`github` today). Nothing pushes jobs. | inbox, feed |
| **Source item** | One eligible thing a source offers — for GitHub, an open issue labelled `hopper` by an allowlisted author. | |
| **Source key** | The unique id of a source item (the issue URL); dedupes jobs. | |
| **Claim** (of an issue) | Labelling it `hopper:claimed` and commenting, when the hopper takes it. Distinct from a lane claim. | |
| **Sync** | One pass of a source: discover, check active jobs, retry reports. | poll |
| **Report** | Telling the source what happened to its job (comments, labels). | |
| **Signal** | What a source tells the hopper: cancel, or a human answer. | |
| **Hopper marker** | The hidden first line of every hopper comment; tells its comments from the owner's replies. | |
| **UI session** | A browser session created from the one-time login code; the only way to mutate. | |
| **Payload version** | `schemaVersion` on every event: the version of that event type's payload schema. | |
| **Event** | One recorded state change, `seq`-ordered, in the event log. Wire type dotted (`job.queued`). | message |
| **Webhook subscription** | A URL + event filter + HMAC secret that receives events. | hook |
| **Delivery** | One attempt series sending one event to one subscription. `pending`, `retrying`, `delivered`, `failed`. | |

## Events

| domain name | wire type |
|-------------|-----------|
| JobQueued | `job.queued` |
| JobPrioritized (by Jev) | `job.prioritized` |
| JobHeld | `job.held` |
| JobApproved | `job.approved` |
| JobClaimed | `job.claimed` |
| JobStarted | `job.started` |
| JobProgressed | `job.progressed` |
| JobFinished | `job.finished` |
| JobFailed | `job.failed` |
| JobCancelled | `job.cancelled` |
| JobRequeued (via restart) | `job.requeued` |
| LaneOpened | `lane.opened` |
| LaneClosed | `lane.closed` |
| DecisionMade | `decision.made` |
| JevModeChanged | `jev.mode_changed` |
| QuestionAsked | `question.asked` |
| QuestionEscalated (to a tier) | `question.escalated` |
| QuestionAnswered (by a tier) | `question.answered` |
| QuestionExpired | `question.expired` |
