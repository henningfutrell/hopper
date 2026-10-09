// Renders docs/events.md from the schemas, so the document cannot drift from them.
import { EVENT_SCHEMA_VERSIONS, EVENT_TYPES, type EventType } from '../domain/types.ts';
import { EVENT_EXAMPLES } from './examples.ts';
import { exportJsonSchemas } from './export.ts';
import { LEGACY_EVENT_SCHEMAS } from './legacy.ts';

export const EVENT_DOCS: Record<EventType, string> = {
  'job.queued': 'A job was created from a source item; it waits at the queue gate until accepted (`job.accepted`).',
  'job.prioritized': 'The router\'s advice arrived for a job; once per job, whatever its status then.',
  'job.held': 'A Decision held a job and its hold reason changed.',
  'job.approved': 'A human approved a job the router held (e.g. `ask_human`).',
  'job.claimed': 'A Decision assigned a job to a lane.',
  'job.started': 'The executor began running a claimed job.',
  'job.progressed': 'An executor reported progress; at most one per job per 500 ms.',
  'job.finished': 'A job ended successfully.',
  'job.failed': 'A job ended with an error. `priority`, `high` (issue #535): the job\'s live priority, and whether it is at or above the high-priority threshold.',
  'job.cancelled': 'A job was cancelled.',
  'job.requeued': 'A job went back to the queue (restart recovery, or a question answered or closed). `reason` is a free string.',
  'job.parked': 'A person parked a running job or one on a question (issue #501): its lane is free, its pane and agent ended, and its work tree, branch, agent session and open question are kept. `machineId`: the machine it returns to when re-queued. A parked job never runs, and its question never expires, until it is re-queued or cancelled.',
  'job.unparked': 'A person re-queued a parked job (issue #501). `to` `queued`: it waits, pinned to its machine, and its claim resumes its agent session there (`claude --resume`), with the answer kept while it was parked, if any. `to` `waiting_answer`: its question is still open; the answer resumes it, and the human timeout starts again.',
  'job.reattached': 'The executor watches a job\'s live external work again (the herdr pane and Claude) without sending anything. `reason` `daemon restart`: restart recovery kept a running job running on its lane. `reason` `answered in the pane`: the owner typed the answer into a waiting job\'s pane; the job runs again on a lane.',
  'job.reprioritized': 'A source re-sorted a waiting job.',
  'job.respecified': 'A sync worked out a job that has not started from the config as it is now (issue #375), and its executor, model, work tree, default work tree, machine pin or routing rule changed. `from` and `to` are what the source and routing rules gave it; a part changed on the job by hand keeps the hand value, so the spec can differ from `to`.',
  'lane.opened': 'A Decision opened a lane.',
  'lane.closed': 'A lane closed (decision reason, `drained`, or `daemon restart`).',
  'decision.made': 'The engine recorded a Decision.',
  'question.asked': 'A running job paused on a question. `priority`, `high` (issue #535): the job\'s live priority, and whether it is at or above the high-priority threshold.',
  'question.escalated': 'A question entered a stage — `target` is an escalation level\'s instance name, or `human` — or the human was re-notified. `reason` says why it climbed: the reply or the failure of the level below, or a risk rule hit. `priority`, `high` (issue #535): the job\'s live priority, and whether it is at or above the high-priority threshold.',
  'question.escalated_to_human': 'A question reached the human stage: every level escalated, there are no levels, or a risk rule hit. Once per question, right after its `question.escalated` with `target` `human`; never on a level hop or a re-notification. Subscribe to it to hear only the questions the owner must answer. `priority`, `high` (issue #535): the job\'s live priority, and whether it is at or above the high-priority threshold.',
  'question.answered': 'An answer was accepted: an escalation level\'s (`by` = the level instance), or the human\'s (`via: "pane"` when they typed it into the job\'s pane: the job already runs again, nothing is typed for them).',
  'question.closed': 'The owner closed an open question without answering (UI Close). The job resumes with `answer`, the fixed close text, typed in; any escalation level call in flight is aborted.',
  'question.dismissed': 'The owner dismissed an open question (UI Dismiss): it needs no action any more. Nothing is typed into the job; a job still waiting on it is cancelled (`job.cancelled`, reason `question dismissed`); any escalation level call in flight is aborted.',
  'question.expired': 'The human stage timed out and the job fails.',
  'question.lapsed': 'Nobody answered a dialog in time: the agent denied it by itself when its countdown ran out (Claude Code\'s auto-deny), and the job went on (`job.reattached`, reason `the dialog lapsed`). `lapsesAt` is when the countdown ended. Not an answer: nothing is typed, and no stage answered; any escalation level call in flight is aborted.',
  'update.available': 'A check found a newer target on the update channel than the installed commit (once per target). `ref` is the branch of the channel; `changes` counts its commits not installed (an operator detail; the UI shows the bullets of WHATS-NEW.md instead).',
  'update.started': 'Applying an update began (UI, or auto-update): the target is built beside the running install. Running jobs keep running.',
  'update.applied': 'The first boot on an applied update: the install now runs `to`. Recovery reattached what was running.',
  'update.failed': 'Applying an update failed (fetch, build, the new build not loading, or the swap) and the install is unchanged — or a boot after an update is not on the applied commit.',
  'plugin.installed': 'A plugin was installed from the plugin store into the plugin dir (UI Install or Update), at the store\'s commit `commit`. A plugin new to this process is loaded at once; one installed again runs its new code after a restart.',
  'plugin.removed': 'A store install was removed from the plugin dir (UI Remove). Nothing in the plugins config named it.',
  'job.accepted': 'A job passed the queue gate and may run: `by` `pre-sort` (the gate auto-accepts, or the user took the pre-sort with Accept pre-sort), or `user` (moved into the user order).',
  'job.rejected': 'A waiting job was turned away at the queue gate: it ends `rejected`, is kept, and never runs. `by` `user` (UI Reject, with the reason the user gave, else `rejected by the user`) or `pre-sort` (the queue sorter rejected it); `reason` is also the job\'s `error`. Its source is told; on GitHub the issue is left as it is — no label, no comment, never closed — and is not taken again until it is assigned to the account again or run again (issue #387).',
  'queue.ordered': 'The user ordered the queue: `jobIds`, first to last, run before every job not in it.',
  'job.claimed_by_operator': 'An operator claimed the waiting job as operator-led (issue #318): the work is done by hand — at a terminal, or in an IDE the hopper has no pane in — not by an executor. The job holds no lane and is never run; it is finished when its closing pull request reaches the completion, as any job is, and cancelled as any job is.',
  'job.rerun': 'The user (`by: "user"`), or the failure assessor (`by: "assessor"`: a retry, a redirect, a held job released — issue #509), asked for an ended job\'s item to run again (UI Run again, a re-run): its source gave the item back (on GitHub: a closed issue reopened, the end labels gone) and the new job was queued in the same step, its `job.queued` just before this event and its `rerunOf` this job. The ended job is kept as it ended; a failed one is no longer a locked entry.',
  'job.dismissed': 'The user dismissed a locked entry (issue #355): the failed job stays failed and leaves the queue. It can still be run again. Its issue keeps `hopper:failed`.',
  'job.unassigned': 'A started job\'s issue is no longer assigned to `assignee`, the account it was taken for (issue #387). The job runs on, flagged (`sourceState.sync.unassignedAt`); the user decides whether to stop it. A waiting job is cancelled `unassigned` instead. Recorded once per flag.',
  'job.reassigned': 'A flagged job\'s issue is assigned to `assignee` again (issue #387): the flag is cleared.',
  'job.work_kept': 'The reap at the job\'s end (issue #401), or a later sweep (issue #410), kept its scratch dir: each of `paths` is a repository in it holding uncommitted or unpushed work. Nothing in it was removed; the job\'s processes were still stopped. The sweep tries again on each pass, and removes it once the work is pushed (`job.work_removed`).',
  'job.work_removed': 'The sweep (issue #410) removed the scratch dir a reap had kept (`job.work_kept`): its work is now committed and pushed. `paths` is the scratch dir removed.',
  'job.cleanup_deferred': 'The job ended, but its cleanup could not reach its machine (`error`), so its pane and agent may still run there. Recorded once per deferral; the cleanup is tried again on every tick, and a waiting job of the same item is held until it goes through.',
  'job.cleaned_up': 'A deferred cleanup went through: the job\'s pane is closed and its work reaped. `deferredAt` is when it was deferred. `by: "user"`: the user marked it cleaned up (they closed the pane by hand, or its machine is gone for good), and it is no longer tried. Recorded only for a deferred cleanup.',
  'source.stalled': 'A job source has been in error since `since` for longer than the stall threshold (30 minutes): nothing new is pulled from it. Recorded once per run of failures; `error` is its last error. The notifiers send it.',
  'connected_account.expired': 'The sign-in of the user\'s connected account ended: GitHub refused its refresh token itself and no newer pair was stored (revoked, or the app\'s authorization removed), or the token expired with nothing to renew it (`reason`). A renewal that failed for a reason that may pass (GitHub not answering, a 5xx, a rate limit) never ends it. The account reads as expired until connected again; its source pauses and asks to connect again; nothing reads GitHub in its place. Recorded once. The notifiers send it.',
  'ui_session.ended': 'A UI session of the user\'s ended (issue #439), with the realm it signed in with and why (`reason`): `expired-idle` (no request for the idle timeout), `expired-absolute` (its maximum passed), `refresh-refused` (a gateway realm\'s session whose forwarded token no longer checks out), `provider-unreachable` (that token\'s issuer stayed out of reach past the grace period), `realm-changed` (the sign-in config changed: its realm gone or off, or no rule grants it a role), `connection-ended` (signed in with GitHub, and the user\'s GitHub connection ended: `connected_account.expired`; issue #513) or `logout`. The session lengths are Settings → Sign-in\'s.',
  'source.claim_released': 'A `hopper:claimed` label (and its `hopper:held-by:<id>` holder label) was removed from an item no job here holds (issue #440). `by: "hopper"`: the claim was this user\'s own, its job gone — the item is taken again; `by: "migration"`: the intake migration released a claim written before claims named their holder, which no user of this hopper has a job for; `by: "user"`: released from Sources. `reason` says which.',
  'source.intake_migrated': 'A job source was moved to the current intake rules, once (issue #440). `changes` lists every item it changed or found needing the user: claims it released, and labelled issues not assigned to the user. Sources shows the same list.',
  'source.issues_assigned': 'The user assigned these labelled items (`keys`) to their connected account from Sources (issue #440): the next sync takes them. `assignee` is the account.',
  'auth.pending': 'A job or run waits on a login (issue #476): a CLI shows a device code to enter at a URL. It goes to the logins, never to the questions or an escalation level. `run` is the executor or escalation level that waits; `questionId` when it is an escalation level\'s run for that question. Again, with the same `loginId` and `renewed: true`, when the same tool shows a new code for the same job: a login is updated, never duplicated. The URL and the code are never in an event, a log or a webhook: only a UI session of the user reads them, from `GET /api/logins`. `priority`, `high` (issue #535): the job\'s live priority, and whether it is at or above the high-priority threshold.',
  'auth.completed': 'The machine went on after the login: the tool proceeded (or ended), and the job works again.',
  'auth.expired': 'The login\'s code ran out (`expiresAt`) before the machine went on. By the logins setting, the job then fails with the reason (the default) or holds for a new code.',
  'auth.cancelled': 'The user cancelled the login. A herdr job is told to stop waiting for it and to go on without it, or to fail.',
  'auth.failed': 'What waited on the login ended first (`reason`: the job ended, the run ended with an error).',
  'job.assessed': 'The failure assessor judged a failed job (issue #509): its error normalised to a `signature`, matched to a known cause (`causeId`), its `class` (`transient`, `shared` or `job`), its `decision` — `retry` (runs again at `retryAt`, within the retry limit), `hold` or `redirect` (grouped into the problem `problemId`; a redirected job runs again at once, kept off the problem\'s machine), or `person` — with its `reasons` and a `summary` for a person. `attempt`: its run in its chain of retries. `auto: false`: that decision\'s automatic action is off in the failures settings, so it waits for a person. Once per failed job. `priority`, `high` (issue #535): the job\'s live priority, and whether it is at or above the high-priority threshold.',
  'failure.grouped': 'A failed job was grouped into a problem (issue #509): one shared cause, shown once with the jobs it hit. `opened: true` for the job that opened it. `general: true`: no known cause, flagged because the same signature failed enough items within the grouping window. While it is open, a new job its `scope` covers (a machine, an executor on it, or every machine) is held — or placed on another machine — with the reason `held by problem: <title>`. `affected`: its jobs so far.',
  'failure.resolved': 'A problem was resolved (issue #509): by a person (`by: "user"`), or by its check (`by: "check"`: the machine is reachable again, or its disk has room again). Its jobs held for it run again through the normal queue (`released` of them), and new jobs are no longer held for it.',
  'handoff.opened': 'A failed job was handed off to a person (issue #516): automatic handling has ended for it, and it waits in Failures, Needs a person, until a person runs it again or clears it — never dropped by age or a restart. `reason`: `retry_limit` (its retries used up), `person` (a job-specific failure), `auto_off` (its decision\'s automatic action is off in the failures settings), `not_retried` (a run again the assessor decided was refused), or `dismissed` (its locked entry dismissed with nothing else to end it). `summary` and `recordId`: its assessment. `notify: false`: the failures setting says not to tell anyone, and no webhook delivers it. Once per hand-off. `priority`, `high` (issue #535): the job\'s live priority, and whether it is at or above the high-priority threshold.',
  'handoff.closed': 'A hand-off ended (issue #516): `end` `run_again` (its item ran again, from Needs a person, the Queue, the failure\'s Retry or its source; `nextJobId` the new job), `cleared` (a person acknowledged it: no more work, its locked entry dismissed too), `finished` (its job ended finished: its issue closed as complete); or, found stale by the sweep or at start (issue #529), `superseded` (a newer job of its item exists; `nextJobId` it), `item_closed` (its item is closed at its source) or `job_gone` (its job is gone).',
  'priority_lanes.changed': 'The priority lanes changed (issue #535): `from` and `to` the lanes high-priority jobs get first, best first. `by`: `reliability` (the hopper measured its lanes again and a lane became more reliable by more than the margin, or one dropped out), `manual` (an admin chose them), `settings` (a settings change, such as the count).',
  'priority_lanes.settings_changed': 'An admin saved the priority lane settings (issue #535): `from` and `to` the high-priority threshold, the count of priority lanes, what a priority lane does while no high-priority job waits (`keep-free` or `share`), the window and the minimum runs lane reliability is measured over, and the lanes an admin chose (`manual`; absent: by reliability).',
  'usage.limits_changed': 'The usage limits were set in the UI (issue #522): `from` the soft and hard limits the decider used, `to` the ones it uses from now on. Each is a fraction of a usage budget, from 0 to 1.',
  'proposal.asked': 'A person asked a job that has not started for a proposal (issue #537): when it starts, its agent is told to write one instead of doing the work. A job from an item labelled `hopper:proposal` is asked from the start, with no event.',
  'proposal.submitted': 'A job came back with a proposal (issue #537): its agent ended with HOPPER_PROPOSAL instead of doing the work. Version 1, or the next version of one sent back. The job waits on it. `goal`: its Goal part; `missing`: the parts it left out.',
  'proposal.escalated': 'A proposal entered a stage of its review (issue #537): `target` is the reviewer level (an escalation level named in the proposal settings) or `human`, and `reason` why it climbed.',
  'proposal.escalated_to_human': 'A proposal reached a person (issue #537): every reviewer level passed it up, there are none, or they asked for changes more often than the settings allow. Once per version.',
  'proposal.reviewed': 'A reviewer level gave its verdict on a proposal (issue #537): `approve`, `request_changes` or `escalate`, with its `notes`. `error`: the review failed, which escalates.',
  'proposal.revision_requested': 'A proposal was sent back to its job (issue #537), by a reviewer level or a person (`stage`; `by` names the person; `decision` `request_changes`): `notes` is what to change. The job is re-queued with it and writes the next version.',
  'proposal.accepted': 'A proposal was signed off as accepted (issue #537), by a person (`stage: "human"`, `by` who) or by the top reviewer level where the proposal settings let it. Its job ends finished, with the decision as its result; the proposal stays linked to the job and its item.',
  'proposal.rejected': 'A person rejected a proposal (issue #537), with why (`notes`). Its job ends finished, with the decision as its result.',
  'proposal.cancelled': 'A proposal waiting on a decision was cancelled because its job ended or is gone (issue #537).',
  'research.asked': 'A person asked a job that has not started to research (issue #543): when it starts, its agent is told to research and write a research report instead of doing the work. A job from an item labelled `hopper:research`, or with a Research heading in its body, is asked from the start, with no event.',
  'research.submitted': 'A job came back with a research report (issue #543): its agent ended with HOPPER_RESEARCH_REPORT instead of doing the work. Round 1 (`version`), or the next round after a dig deeper or a steer. The job waits on it, keeping its session. `question`: its Question part; `missing`: the parts it left out.',
  'research.escalated': 'A research report entered a stage of its review (issue #543): `target` is the reviewer level (an escalation level named in the research settings) or `human`, and `reason` why it climbed.',
  'research.escalated_to_human': 'A research report reached a person (issue #543): every reviewer level passed it up, there are none (the default), or they asked for changes more often than the settings allow. Once per round.',
  'research.reviewed': 'A reviewer level gave its verdict on a research report (issue #543): `approve`, `request_changes` or `escalate`, with its `notes`. `error`: the review failed, which escalates.',
  'research.revision_requested': 'A research report was sent back for another round (issue #543): `decision` `dig_deeper` (a person: deeper on the whole report, or on the open threads `notes` names), `steer` (a person: `notes` is the new direction) or `request_changes` (a reviewer level). The job is re-queued with it, in the same session, and its next report is the next round.',
  'research.accepted': 'A research report was accepted (issue #543), by a person (`stage: "human"`, `by` who) or by the top reviewer level where the research settings let it. A job that also asks for a proposal is re-queued to write it, in the same session; any other ends finished, with the decision as its result.',
  'research.cancelled': 'A research report waiting on a decision was cancelled because its job ended or is gone (issue #543).',
  'queue.gate_changed': 'The queue gate was changed: its mode (`auto-accept` or `review`) or its throttle (`autoAcceptPerHour`, null for none).',
};

type Prop = Record<string, unknown>;

function typeOf(p: Prop): string {
  if (Array.isArray(p.enum)) return p.enum.map((v) => `\`${String(v)}\``).join(' \\| ');
  if (Array.isArray(p.anyOf)) return (p.anyOf as Prop[]).map(typeOf).join(' \\| ');
  if (p.type === 'array') return `${typeOf((p.items ?? {}) as Prop)}[]`;
  if (typeof p.type === 'string') return p.type;
  return 'any';
}

function fieldRows(schema: Prop): string {
  const props = (schema.properties ?? {}) as Record<string, Prop>;
  const required = new Set((schema.required ?? []) as string[]);
  const rows = Object.entries(props).map(([k, p]) => `| \`${k}\` | ${typeOf(p)} | ${required.has(k) ? 'yes' : 'no'} |`);
  return rows.length ? ['| field | type | required |', '|---|---|---|', ...rows].join('\n') : '`data` is `{}`.';
}

export function renderEventsMarkdown(): string {
  const files = exportJsonSchemas();
  const out = [
    '# Events',
    '',
    '<!-- generated by `npm run schemas` from src/events — do not edit -->',
    '',
    'Every event (stored, SSE, `/api/events`, webhook body) is the envelope below. `schemaVersion` is the',
    "version of **that type's** payload schema; the JSON Schema for each is in `docs/schemas/<type>.v<N>.json`.",
    'An additive (optional) field keeps the version; a removed, renamed or retyped field bumps it and adds',
    '`<type>.v<N+1>.json` — the old file stays as documentation of what older consumers received.',
    '',
    'Events stored before phase 3 read as v1 and are not re-validated.',
    '',
    `Stored events are never rewritten. Superseded versions stay readable and documented: ${Object.keys(LEGACY_EVENT_SCHEMAS).map((k) => `\`${k}\``).join(', ')}`,
    '(phase 5 renamed Jev → router: `jev.mode_changed` became `router.mode_changed`; slice 2 made question',
    'stages instance names: `question.escalated.target` and `question.answered.by` were `opus | fable | human` in v1;',
    'issue #211 removed the router mode: `router.mode_changed` is retired, and v3 of `job.prioritized` and',
    '`decision.made` carry no `mode` / `routerMode`).',
    '',
    '```json',
    '{ "schemaVersion": 1, "seq": 1, "id": "uuid", "type": "job.queued", "at": "ISO",',
    '  "jobId": "…", "laneId": "…", "machineId": "…", "decisionId": "…", "questionId": "…", "data": { … } }',
    '```',
    '',
    'Schema: `docs/schemas/envelope.v1.json`. Payloads are strict: unknown keys are rejected.',
    '',
    'Every `question.*` event names the **raising machine** — the machine the question was asked on — as the',
    '`machineId` subject (and `laneId`, where the lane is known) and as `raisedBy` (`machineId`, `name`, `laneId`)',
    'in its data: a snapshot taken when the question was asked, so it stays right after the job moves or the',
    'machine is renamed or removed. Absent on a question asked before it was recorded, with nothing to fill it from.',
  ];
  for (const t of EVENT_TYPES) {
    const v = EVENT_SCHEMA_VERSIONS[t];
    out.push('', `## \`${t}\``, '', `Version ${v} (\`docs/schemas/${t}.v${v}.json\`). ${EVENT_DOCS[t]}`, '',
      fieldRows(files[`${t}.v${v}.json`] as Prop), '', '```json', JSON.stringify(EVENT_EXAMPLES[t], null, 2), '```');
  }
  return `${out.join('\n')}\n`;
}
