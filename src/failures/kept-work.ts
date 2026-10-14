// Work not pushed (issue #1010, design.md "Work not pushed"): the ended jobs whose reap kept work not pushed, as the
// Failures view lists them, and Push it — the failed, finished or cancelled job goes on in its own agent session and kept work tree, told to
// push its work and open the pull request. Through its open hand-off when it has one (resolved as Continue), else as a
// Continue of its own (`job.continued` with `keptWork`). Discard is the engine's (`Engine.discardWork`): it reaches
// the job's machine.
import type { RerunResult, UserStore } from '../domain/ports.ts';
import { keptWorkOf, machineRanOn, PUSHABLE_ENDS, TERMINAL_STATUSES, WORK_EVENTS, type ActingPerson, type Allowed, type ContinuedBy, type HandoffView, type Job, type KeptWorkView } from '../domain/types.ts';
import type { HandoffResolve } from './handoffs.ts';
import { handoffView, newestOfItem, type TakesBack } from './view.ts';

/** The work trail read back: the newest this many events. */
const KEPT_SCAN = 1000;
const OK: Allowed = { ok: true };
const no = (why: string): Allowed => ({ ok: false, why });

type Reads = Pick<UserStore, 'events' | 'jobs' | 'handoffs' | 'failures'>;

/** What the job is told when it goes on (its own session, its kept work tree), with the person's note. */
export function pushBrief(note: string | undefined): string {
  return [
    'This job ended with work in its work tree that was not pushed. A person asks you to push it, in this same session and work tree.',
    'Look at what is there first (git status, git log, the branch on the remote). Commit what is not committed, and push the branch.',
    'Then open the pull request the task asks for. Open it as a draft when the work is not finished. Do not start over.',
    ...(note ? ['', 'The person\'s note:', note] : []),
  ].join('\n');
}

/** Whether Push it is taken now, and why not: a failed, finished or cancelled job whose own session resumes, the newest of its item. */
function pushAllowed(store: Reads, job: Job, handoff: ReturnType<Reads['handoffs']['forJob']>, resumable: (job: Job) => boolean, takesBack: TakesBack): Allowed {
  if (!PUSHABLE_ENDS.includes(job.status)) return no(`it is ${job.status}: only a failed, finished or cancelled job goes on in its work tree`);
  if (!resumable(job)) return no('its agent session cannot resume: open its work tree on its machine, or discard it');
  if (handoff?.status === 'open') return handoffView(store, handoff, resumable, takesBack).actions.continue;
  const newest = newestOfItem(store, job.id);
  return newest.ok ? takesBack(job.id) : newest;
}

/** Every ended job whose work is kept, newest first, with its ways out. */
export function keptWorkViews(store: Reads, resumable: (job: Job) => boolean, takesBack: TakesBack): KeptWorkView[] {
  const out: KeptWorkView[] = [];
  for (const k of keptWorkOf(store.events.recent(KEPT_SCAN, [...WORK_EVENTS]))) {
    const job = store.jobs.get(k.jobId);
    if (!job || !TERMINAL_STATUSES.includes(job.status)) continue;
    const handoff = store.handoffs.forJob(job.id);
    const machineId = machineRanOn(job);
    out.push({
      ...k, status: job.status,
      ...(job.source?.title ? { title: job.source.title } : {}), ...(job.source?.url ? { url: job.source.url } : {}),
      ...(machineId ? { machineId } : {}), ...(handoff?.status === 'open' ? { handoffId: handoff.id } : {}),
      actions: { push: pushAllowed(store, job, handoff, resumable, takesBack), discard: OK },
    });
  }
  return out;
}

export type PushResult = { ok: true; value: { job: Job; handoff?: HandoffView } } | { ok: false; reason: 'not_found' | 'conflict'; message: string };

/** Push it: through its open hand-off (Continue, with the brief as the note), else a Continue of its own. */
export async function pushKeptWork(
  d: {
    store: Reads; resumable(job: Job): boolean; takesBack: TakesBack;
    continueJob(jobId: string, brief: string, by: ContinuedBy): Promise<RerunResult>;
    resolveHandoff(id: string, input: HandoffResolve, by: ActingPerson): Promise<{ ok: true; value: { handoff: HandoffView; job?: Job } } | { ok: false; reason: 'not_found' | 'conflict'; message: string }>;
  },
  jobId: string, note: string | undefined, by: ActingPerson,
): Promise<PushResult> {
  const kept = keptWorkViews(d.store, d.resumable, d.takesBack).find((k) => k.jobId === jobId);
  if (!kept) return d.store.jobs.get(jobId) ? { ok: false, reason: 'conflict', message: `job ${jobId} has no work kept` } : { ok: false, reason: 'not_found', message: `job ${jobId} not found` };
  if (!kept.actions.push.ok) return { ok: false, reason: 'conflict', message: `job ${jobId}'s work cannot be pushed: ${kept.actions.push.why}` };
  if (kept.handoffId) {
    const r = await d.resolveHandoff(kept.handoffId, { action: 'continue', note: pushBrief(note) }, by);
    if (!r.ok) return r;
    return r.value.job ? { ok: true, value: { job: r.value.job, handoff: r.value.handoff } } : { ok: false, reason: 'conflict', message: `job ${jobId} did not go on` };
  }
  const r = await d.continueJob(jobId, pushBrief(note), { keptWork: true });
  if (!r.ok) return { ok: false, reason: r.reason === 'not_found' ? 'not_found' : 'conflict', message: r.message };
  return { ok: true, value: { job: r.job } };
}
