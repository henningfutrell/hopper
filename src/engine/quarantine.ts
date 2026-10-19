// Quarantine (issue #655, part 2; design.md "Trust stamps"): a person's act on a job that has not ended. The job's stamp
// is signed `quarantined`, so the decider holds it and its proxy token opens no door of the hopper — a running job keeps
// its pane, but reaches no GitHub, git, vault, skill or step through the hopper. Only a person lifts it, to the level the
// job had before. Each is one event, with who acted. A person approves the trust of a job Jev's trust check lowered (part 4).
// A person's deny at gate 2 lowers a job's trust one level, and the second quarantines it (part 5).
// The stamp intake signed at a job's making is `intake.stamped`, after its `job.queued` (part 11).
import { DENY_REASON, JEV_DENY_REASON, stampedEvent } from '../domain/trust-stamp.ts';
import { TERMINAL_STATUSES, type ActingPerson, type Job } from '../domain/types.ts';
import type { UserStore } from '../domain/ports.ts';
import type { EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

function live(c: EngineContext, id: string): Job {
  const job = c.store.jobs.get(id);
  if (!job) throw new EngineError('not_found', `job ${id} not found`);
  if (TERMINAL_STATUSES.includes(job.status)) throw new EngineError('conflict', `job ${id} is already ${job.status}`);
  return job;
}

/** In the tx: the job quarantined. 409 when it is quarantined already, or trust stamps are off. job.quarantined. */
export function recordQuarantine(c: EngineContext, id: string, acting: ActingPerson): Job {
  const job = live(c, id);
  const was = c.store.jobs.trustLevel(job);
  if (was === 'quarantined') throw new EngineError('conflict', `job ${id} is quarantined already`);
  const next = c.store.jobs.quarantine(id);
  if (next.stamp?.level !== 'quarantined') throw new EngineError('conflict', `job ${id} has no trust stamp to quarantine`);
  c.store.events.append({ type: 'job.quarantined', jobId: id, data: { ...(was ? { was } : {}), ...acting } });
  return next;
}

/** In the tx: the quarantine lifted, to the level the job had before. 409 when it is not quarantined. job.unquarantined. */
export function recordLiftQuarantine(c: EngineContext, id: string, acting: ActingPerson): Job {
  const job = live(c, id);
  if (c.store.jobs.trustLevel(job) !== 'quarantined') throw new EngineError('conflict', `job ${id} is not quarantined`);
  const next = c.store.jobs.liftQuarantine(id);
  c.store.events.append({ type: 'job.unquarantined', jobId: id, data: { level: next.stamp!.level, ...acting } });
  return next;
}

/** In the tx: the trust of a job Jev's trust check or a deny lowered below approved, to `approved`. 409 when no check lowered it. job.trust_approved. */
export function recordApproveTrust(c: EngineContext, id: string, acting: ActingPerson): Job {
  const job = live(c, id);
  const from = c.store.jobs.trustLevel(job);
  const next = c.store.jobs.approveTrust(id);
  if (!next || from === undefined) throw new EngineError('conflict', `job ${id} has no trust that Jev's check or a deny lowered to approve: a job of an item of no trusted origin is approved by its request card in Intake`);
  c.store.events.append({ type: 'job.trust_approved', jobId: id, data: { from, ...acting } });
  return next;
}

/**
 * In the tx: a deny at gate 2 lowers the job's trust one level, and the second in the job quarantines it — a person's
 * (part 5: a declined sandbox request) or Jev's (`jev`, part 13: its `sandbox-request` check denied one). Nothing for a
 * job that ended, is quarantined already, or has no stamp that verifies: the deny itself stands. job.trust_lowered, or
 * job.quarantined with the deny as its reason.
 */
export function recordDeny(c: EngineContext, id: string, acting: ActingPerson | 'jev'): Job | undefined {
  const job = c.store.jobs.get(id);
  const from = job ? c.store.jobs.trustLevel(job) : undefined;
  const byJev = acting === 'jev';
  const next = from === undefined ? undefined : c.store.jobs.deny(id, byJev ? 'jev' : 'person');
  if (!next?.stamp || from === undefined) return undefined;
  const reason = byJev ? JEV_DENY_REASON : DENY_REASON, who = byJev ? { by: 'jev' as const } : { by: 'person' as const, ...acting };
  if (next.stamp.level === 'quarantined') c.store.events.append({ type: 'job.quarantined', jobId: id, data: { was: from, reason, ...(byJev ? { by: 'jev' } : acting) } });
  else c.store.events.append({ type: 'job.trust_lowered', jobId: id, data: { from, to: next.stamp.level, reason, ...who } });
  return next;
}

/** In the tx, after the new job's `job.queued`: the stamp intake signed at its making, as `intake.stamped`. None: no stamp. */
export function appendStamped(store: UserStore, job: Job): void {
  const data = stampedEvent(job);
  if (data) store.events.append({ type: 'intake.stamped', jobId: job.id, data });
}
