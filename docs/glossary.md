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
| **Executor** | Runs one job on one lane (`test` today; `herdr-claude` later). | runner |
| **Jev** | grok-bot-jev's usage router: classifies a request and returns an action. | |
| **Jev advice** | Jev's action + reason + details for one job. | |
| **Advisor** | The adapter producing Jev advice: `router` (the real one) or `fake`. | |
| **Jev mode** | `shadow`: advice recorded, never applied. `active`: advice shapes admission and order. | |
| **Divergence** | A job where the Jev verdict differs from the native one. Recorded in both modes. | |
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
