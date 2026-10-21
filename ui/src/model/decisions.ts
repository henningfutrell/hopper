// A Decision in plain words (issue #2375), pure: the jobs it is about, its kind, and its outcome as one sentence
// ("started 1 job, held 3: awaiting acceptance"). The Decisions view's table reads these; the raw ids stay in its detail.
import type { Decision } from '@/model/wire';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The jobs a Decision is about, each once, in the order: started, held, left waiting for a lane, parked. */
export function decisionJobs(d: Decision): string[] {
  const ids = [...d.start, ...d.hold, ...(d.wait ?? []), ...(d.preempt ?? []), ...(d.memoryPause ?? [])].map((x) => x.jobId);
  return [...new Set(ids)];
}

/** What woke the decider, in words: a tick is the regular check; an event type reads with spaces (job.queued → job queued). */
export const decisionKind = (d: Decision): string => d.trigger === 'tick' ? 'regular check' : d.trigger.replace(/[._]/g, ' ');

/** The outcome as a sentence: what it started, held (with the reason when all share one), left waiting and parked. */
export function decisionOutcome(d: Decision): string {
  const parts: string[] = [];
  if (d.start.length) parts.push(`started ${plural(d.start.length, 'job', 'jobs')}`);
  if (d.hold.length) {
    const reasons = [...new Set(d.hold.map((h) => h.reason))];
    parts.push(`held ${d.hold.length}${reasons.length === 1 ? `: ${reasons[0]}` : ` for ${reasons.length} reasons`}`);
  }
  const wait = d.wait ?? [];
  if (wait.length) parts.push(`${wait.length} ${wait.length === 1 ? 'waits' : 'wait'} for a lane`);
  const parked = (d.preempt?.length ?? 0) + (d.memoryPause?.length ?? 0);
  if (parked) parts.push(`parked ${parked}`);
  if (!parts.length) return d.lanes.some((p) => p.target !== p.current) ? 'changed lanes only' : 'no change';
  // The reason of a hold may hold a comma: it goes last.
  const held = parts.findIndex((p) => p.startsWith('held'));
  if (held >= 0 && held < parts.length - 1) parts.push(...parts.splice(held, 1));
  return parts.join(', ');
}
