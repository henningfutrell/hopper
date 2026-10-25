// One event as one line: time, type (coloured by what ended or started), and its subject. An event about a job links to
// its job view (issue #433); one with no job has no link. Live activity shows EventLine; the event stream EventText, in a
// code block; the job timeline, a Trace, takes its tone and detail (issue #1169).
import { clock } from '@/model/format';
import { subjectOf } from '@/model/board';
import { jobHref } from '@/model/job';
import { artifactCreatedDetail, revisedDetail } from '@/model/artifacts';
import { pickedEventDetail } from '@/model/minor-decisions';
import { redBatchDetail } from '@/model/landing-batches';
import { conditionalSkillsChosenLine, skillLoadedLine, workSkillChosenLine } from '@/model/skills';
import type { DomainEvent, MachineView } from '@/model/wire';
import { TEXT, type Tone } from '@/components/status';
import { cn } from '@/lib/utils';

const TYPE_TONE: Record<string, Tone> = {
  'job.started': 'busy', 'job.claimed': 'busy', 'job.reattached': 'busy', 'job.finished': 'ok', 'job.failed': 'bad',
  'job.held': 'warn', 'job.requeued': 'warn', 'job.link_lost': 'warn', 'question.asked': 'question', 'question.escalated': 'question', 'question.escalated_to_human': 'question',
  'question.answered': 'ok', 'question.closed': 'warn', 'question.dismissed': 'muted', 'question.expired': 'bad', 'question.lapsed': 'warn', 'question.cancelled': 'muted', 'lane.opened': 'busy',
  'question.thread_held': 'question', 'question.thread_approved': 'ok', 'question.thread_posted': 'question',
  'update.available': 'warn', 'update.started': 'busy', 'update.applied': 'ok', 'update.failed': 'bad', 'install.seen': 'muted',
  'plugin.installed': 'ok', 'job.accepted': 'ok', 'job.rejected': 'muted', 'queue.gate_changed': 'warn', 'usage.limits_changed': 'warn',
  'priority_lanes.changed': 'warn', 'priority_lanes.settings_changed': 'warn',
  'job.claimed_by_operator': 'operator',
  'minor_decision.picked': 'question', 'minor_decision.overridden': 'warn',
  'job.phase_changed': 'question', 'job.forked': 'question', 'job.fork_resolved': 'ok', 'phase_shifts.settings_changed': 'warn',
  'question.corrected': 'warn', 'auto_answer.settings_changed': 'warn', 'auto_park.settings_changed': 'warn', 'preemption.settings_changed': 'warn', 'job.preempted': 'warn', 'thread_ask.settings_changed': 'warn', 'tldr.settings_changed': 'warn', 'github_rate_limiter.settings_changed': 'warn', 'allowed_hosts.changed': 'warn', 'telemetry.changed': 'warn', 'source_email_match.changed': 'warn', 'infra.applies_changed': 'warn', 'cloud_link.linked': 'warn', 'cloud_link.unlinked': 'warn', 'cloud_link.registration_code_minted': 'warn', 'cloud_link.registered': 'ok', 'cloud_link.unregistered': 'warn', 'cloud_link.message_refused': 'warn', 'display_name.changed': 'warn', 'github_watch.settings_changed': 'warn',
  'job.rerun': 'warn', 'job.pull_request_tended': 'warn', 'job.unassigned': 'warn', 'job.work_kept': 'warn', 'job.cleanup_deferred': 'warn',
  'github_proxy.done': 'ok', 'github_proxy.refused': 'warn', 'github_proxy.failed': 'bad', 'gitlab_proxy.done': 'ok', 'gitlab_proxy.refused': 'warn', 'gitlab_proxy.failed': 'bad', 'job.child_issue_filed': 'ok',
  'skill.loaded': 'ok', 'skill.refused': 'warn', 'hopper.event_loop_stalled': 'warn',
  'step.refused': 'warn', 'vault.step_delivered': 'ok', 'vault.step_refused': 'warn',
  'landing_batch.promoted': 'ok', 'landing_batch.failed': 'bad', 'landing_batches.changed': 'warn',
  'landing_batch.culprit': 'bad', 'landing_batch.reverted': 'ok', 'landing_batch.revert_failed': 'bad', 'landing_batch.fix_filed': 'ok',
  'landing_batch.back_merged': 'ok', 'landing_batch.back_merge_failed': 'bad', 'landing_batch.back_merge_issue_filed': 'ok',
  'landing_batch.canary_held': 'bad', 'landing_batch.canary_issue_filed': 'ok', 'landing_batch.canary_promoted': 'ok', 'landing_batch.beta_moved': 'muted',
  'landing_batch.stuck': 'bad', 'landing_batch.restarted': 'warn',
  'artifact.posted': 'ok', 'artifact.revised': 'ok',
  'lanes.recommended': 'warn', 'lanes.tuning_changed': 'warn', 'lanes.applied': 'warn', 'lanes.undone': 'warn', 'lanes.dismissed': 'warn',
  'bug_report.filed': 'ok', 'bug_report.failed': 'bad',
  'drift.found': 'warn', 'drift.cleared': 'ok', 'drift.issue_filed': 'warn', 'drift.issue_updated': 'muted', 'component_watchers.settings_changed': 'warn',
  'job.note_added': 'question', 'job.note_delivered': 'ok',
  'terminal.opened': 'warn', 'terminal.typed': 'warn',
};
export const eventTone = (type: string): Tone => TYPE_TONE[type] ?? 'muted';

const NOTE_DELIVERY: Record<string, string> = { start: 'in its task', turn: 'at a turn boundary', resume: 'with the answer' };
const noteCount = (ids: unknown): string => (Array.isArray(ids) && ids.length !== 1 ? `${ids.length} notes` : 'note');

export function detailOf(e: DomainEvent): string {
  const d = e.data as Record<string, unknown>;
  if (e.type === 'minor_decision.picked') return pickedEventDetail(d);
  // Notes to a job (issue #997): who sent one and what it says; how it went in; which job took the ones not delivered.
  if (e.type === 'job.note_added') return `note from ${String(d.person)} (${String(d.via)}): ${String(d.text)}`;
  if (e.type === 'job.note_delivered') return `${noteCount(d.noteIds)} typed into its session ${NOTE_DELIVERY[String(d.delivery)] ?? ''}`.trim();
  if (e.type === 'job.note_carried') return `${noteCount(d.noteIds)} carried to job ${String(d.nextJobId).slice(0, 8)}`;
  // The job's terminal (issue #1128): who opened it, and how much they typed — never what.
  if (e.type === 'terminal.opened') return `terminal opened by ${String(d.person)} (${String(d.via)})`;
  if (e.type === 'terminal.typed') return `${String(d.person)} (${String(d.via)}) typed ${Array.isArray(d.keys) ? `keys ${d.keys.join(' ')}` : `${String(d.chars)} characters`}`;
  // Phase shifts (issue #548): from which phase to which, and why; a fork, what it is for.
  if (e.type === 'job.phase_changed') return `${String(d.from)} → ${String(d.to)}: ${String(d.reason)}`;
  if (e.type === 'job.forked') return `${String(d.to)} forked as ${String(d.forkId).slice(0, 8)}${typeof d.note === 'string' ? `: ${d.note}` : ''}`;
  // The GitHub proxy (issue #563): what the hopper did on GitHub for the job, where, or why not.
  if (e.type === 'github_proxy.done') return `${String(d.op)} ${String(d.repo)}#${String(d.number)}: ${String(d.url)}`;
  if (e.type === 'github_proxy.refused') return `${typeof d.op === 'string' ? `${d.op} ` : ''}refused: ${String(d.reason)}`;
  // Issue lineage (issue #729): the child issue the job filed, of which parent, and a sub-issue link GitHub refused.
  if (e.type === 'job.child_issue_filed') {
    const at = (i: unknown) => { const r = i as { repo?: unknown; number?: unknown }; return `${String(r.repo)}#${String(r.number)}`; };
    return `${d.required === true ? 'required child' : 'follow-up'} ${at(d.child)} of ${at(d.parent)}${typeof d.subIssueError === 'string' ? `; not linked: ${d.subIssueError}` : ''}`;
  }
  // Git through the hopper for GitLab (issue #1448 part 3): a GitLab job's push, where, or why not.
  if (e.type === 'gitlab_proxy.done') return `git push to GitLab ${String(d.project)}: ${Array.isArray(d.refs) ? d.refs.join(', ') : ''}`;
  if (e.type === 'gitlab_proxy.refused') return `git push to GitLab refused: ${String(d.reason)}`;
  if (e.type === 'gitlab_proxy.failed') return `git push to GitLab ${String(d.project)}: ${String(d.error)}`;
  if (e.type === 'github_proxy.failed') return `${String(d.op)} ${String(d.repo)}: ${String(d.error)}`;
  // Skills (issue #582): what the job asked the hopper to set up, and the answer.
  if (e.type === 'skill.listed') return 'asked what the hopper can set up';
  if (e.type === 'skill.loaded') return skillLoadedLine(d as unknown as Parameters<typeof skillLoadedLine>[0]);
  // The skill library (issue #1911): the work skill the job got, at which version, and which setting chose it.
  if (e.type === 'job.work_skill_chosen') return workSkillChosenLine(d as unknown as Parameters<typeof workSkillChosenLine>[0]);
  // Conditional skills (issue #1924): which ones the job got beside its work skill, why, and what the hopper checks.
  if (e.type === 'job.conditional_skills_chosen') return conditionalSkillsChosenLine(d as unknown as Parameters<typeof conditionalSkillsChosenLine>[0]);
  if (e.type === 'skill.refused') return `${String(d.skill)}: no: ${String(d.reason)}`;
  // Windows sandbox steps (issue #731): on which host, what ran, how it ended.
  if (e.type === 'step.started') return `${d.box === undefined ? `on ${String(d.host)}` : `in box ${String(d.box)}`}: ${String(d.command)}`;
  if (e.type === 'step.finished') return `${d.box === undefined ? `on ${String(d.host)}` : `in box ${String(d.box)}`}: exit ${String(d.exit)} after ${String(d.seconds)} s${typeof d.problem === 'string' ? `; ${d.problem}` : ''}`;
  if (e.type === 'step.refused') return `no: ${String(d.reason)}`;
  if (e.type === 'vault.step_delivered') return `${String(d.name)} given to a step on ${String(d.host)}`;
  if (e.type === 'vault.step_refused') return `${String(d.name)} for a step on ${String(d.host)}: no: ${String(d.reason)}`;
  // Landing batches (issue #1073): a batch run of the landing branch, how it ended, a job's pull request moved to it.
  if (e.type === 'landing_batch.started') return `${String(d.repo)}: batch run #${String(d.pullRequest)} of ${String(d.landing)} into ${String(d.tested)}`;
  if (e.type === 'landing_batch.pending') return `${String(d.repo)}: ${Array.isArray(d.merges) ? d.merges.map((n) => `#${String(n)}`).join(', ') : ''} wait for a batch run`;
  if (e.type === 'landing_batch.promoted') return `${String(d.repo)}: batch run #${String(d.pullRequest)} moved ${String(d.tested)}`;
  if (e.type === 'landing_batch.failed') return `${String(d.repo)}: batch run #${String(d.pullRequest)} failed: ${String(d.reason)}`;
  if (e.type === 'landing_batch.retargeted') return `${String(d.repo)}#${String(d.pullRequest)} moved from ${String(d.from)} to ${String(d.to)}`;
  if (e.type.startsWith('landing_batch.')) return redBatchDetail(e.type, d);
  // An artifact shown to its owner (issue #673): where its link was posted, or why not.
  if (e.type === 'artifact.posted') return `${String(d.title)}: ${typeof d.comment === 'string' ? `posted on the issue, ${d.comment}` : typeof d.error === 'string' ? `not posted: ${d.error}` : 'no issue to post on'}`;
  if (e.type === 'artifact.created') return artifactCreatedDetail(d);
  if (e.type === 'artifact.revised') return revisedDetail(d);
  if (e.type === 'artifact.revision_pinned') return `revision ${String(d.revision)} ${d.pinned === true ? 'pinned' : 'unpinned'}`;
  if (e.type === 'artifact.revision_removed') return `revision ${String(d.revision)} removed by the retention`;
  // A comment ended the job's own wait (issue #2159): its link.
  if (e.type === 'job.wait_ended' && typeof d.comment === 'string') return `woken by a comment: ${d.comment}`;
  if (e.type === 'job.fork_resolved') return `fork ${String(d.forkId).slice(0, 8)} ${d.decision === 'accept' ? 'accepted' : 'rejected'}${d.delivered ? ': answered the question' : ''}`;
  for (const k of ['error', 'reason', 'message', 'target', 'by', 'mode', 'assignee']) if (typeof d[k] === 'string' && d[k]) return String(d[k]);
  if (e.type.startsWith('update.') && typeof d.to === 'string') return `${typeof d.ref === 'string' ? `${d.ref} ` : ''}${d.to.slice(0, 7)}`;
  return '';
}

type Machines = readonly Pick<MachineView, 'id' | 'label'>[];

/** The event's subject, a link to its job when it has one, then its detail. */
function Subject({ e, nameOf, machines }: { e: DomainEvent; nameOf: (jobId: string) => string; machines: Machines }) {
  const detail = detailOf(e);
  const subject = subjectOf(e, nameOf, machines);
  return (
    <>
      {e.jobId ? <a href={jobHref(e.jobId)} className="underline-offset-4 hover:underline">{subject}</a> : subject}
      {detail && <span className="text-muted-foreground"> — {detail}</span>}
    </>
  );
}

/** One event as plain text, for a copy of a log: seq, time, type, subject and detail. */
export function eventLineText(e: DomainEvent, nameOf: (jobId: string) => string, machines: Machines): string {
  const detail = detailOf(e);
  return `#${e.seq} ${e.at} ${e.type} ${subjectOf(e, nameOf, machines)}${detail ? ` — ${detail}` : ''}`;
}

/** One event as a line of text in a log (issue #1169): time, type (coloured by what ended or started), subject. */
export function EventText({ e, nameOf, machines }: { e: DomainEvent; nameOf: (jobId: string) => string; machines: Machines }) {
  return (
    <>
      <span className="num text-muted-foreground/80" title={e.at}>{clock(e.at)}</span>{' '}
      <span className={cn('font-medium', TEXT[eventTone(e.type)])}>{e.type}</span>{' '}
      <Subject e={e} nameOf={nameOf} machines={machines} />
    </>
  );
}

export function EventLine({ e, nameOf, machines, className }: { e: DomainEvent; nameOf: (jobId: string) => string; machines: Machines; className?: string }) {
  const detail = detailOf(e);
  const subject = subjectOf(e, nameOf, machines);
  return (
    <div data-event-seq={e.seq} className={cn('grid grid-cols-[4.5rem_8.5rem_minmax(0,1fr)] items-baseline gap-2 text-xs', className)}>
      <span className="num font-mono text-muted-foreground/80" title={e.at}>{clock(e.at)}</span>
      <span className={cn('truncate font-mono font-medium', TEXT[eventTone(e.type)])}>{e.type}</span>
      <span className="min-w-0 truncate" title={detail ? `${subject} — ${detail}` : subject}>
        <Subject e={e} nameOf={nameOf} machines={machines} />
      </span>
    </div>
  );
}
