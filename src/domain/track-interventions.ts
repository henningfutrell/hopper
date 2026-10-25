// Interventions on a kept delivery track (issue #2775 part 6, design.md "Part 6: interventions and the delivery hold"): a
// person's act on a job's change — Park, Pick up, Run again, Merge now, the expedite flag, a delivery hold and its
// release — kept on the job's track, with who, the act, the step the track was in and when. The hopper's own acts (an
// auto-park, a move, tending) and a job's own acts are no interventions: a job never steers its own track. `allowedActs`
// says which acts the step a change is in allows. Pure.
import type { DeliveryRepo } from './delivery-settings.ts';
import type { DeliveryStep } from './delivery-steps.ts';
import type { KeptTrack, TrackMarks } from './kept-tracks.ts';
import type { DomainEvent, Job } from './types.ts';

/** The events an intervention is folded from. `delivery_expedite.changed` names a job, an issue or a pull request. */
export const INTERVENTION_EVENTS = [
  'job.parked', 'job.unparked', 'job.rerun', 'job.pull_request_merged', 'delivery_expedite.changed', 'delivery_track.held', 'delivery_track.released',
] as const;

/** Who owns a held change: the step's own owner, which does not act while it is held (`hopper`), or the person who holds it. */
export type HoldOwner = 'hopper' | 'person';

/** A person's act on a job's change, as its track keeps it. */
export interface Intervention {
  seq: number; at: string; by: string; step: DeliveryStep;
  act: 'park' | 'pick_up' | 'run_again' | 'merge_now' | 'expedite' | 'hold' | 'release';
  reason?: string;
  /** A hold's. */
  owner?: HoldOwner;
  /** An expedite flag's: on or off. */
  expedite?: boolean;
}

/** A track's delivery hold: its last hold, if no release came after it. */
export interface DeliveryHold { by: string; at: string; step: DeliveryStep; owner: HoldOwner; reason?: string }

/** An act the step a change is in allows. `hold` pauses it; `take_ownership` is a hold the person owns. */
export type AllowedAct = 'park' | 'pick_up' | 'hold' | 'take_ownership' | 'release' | 'run_again' | 'expedite';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Whether an expedite flag names this track's change: its job, its issue or its pull request. */
export const expediteNames = (d: Record<string, unknown>, jobId: string, m: TrackMarks): boolean =>
  d.job === jobId || (d.issue !== undefined && d.issue === m.issue) || (d.pullRequest !== undefined && d.pullRequest === m.pr);

/** The intervention an event is, at `step`, or none: the hopper's own act, or a job's. */
export function interventionOf(e: DomainEvent, step: DeliveryStep): Intervention | undefined {
  const d = e.data as Record<string, unknown>;
  const base = { seq: e.seq, at: e.at, step };
  const reason = str(d.reason) ? { reason: str(d.reason)! } : {};
  switch (e.type) {
    case 'job.parked': return d.auto || d.move || d.via === 'job' || !str(d.by) ? undefined : { ...base, act: 'park', by: str(d.by)!, ...reason };
    case 'job.unparked': return d.via === 'job' || !str(d.by) ? undefined : { ...base, act: 'pick_up', by: str(d.by)! };
    case 'job.rerun': return d.by === 'user' ? { ...base, act: 'run_again', by: str(d.person) ?? 'user' } : undefined;
    case 'job.pull_request_merged': return str(d.person) ? { ...base, act: 'merge_now', by: str(d.person)! } : undefined;
    case 'delivery_expedite.changed': return { ...base, act: 'expedite', by: String(d.by), expedite: d.expedite === true };
    case 'delivery_track.held': return { ...base, act: 'hold', by: String(d.by), owner: d.owner === 'person' ? 'person' : 'hopper', ...reason };
    case 'delivery_track.released': return { ...base, act: 'release', by: String(d.by), ...reason };
    default: return undefined;
  }
}

/** The hold that holds a change: the last hold, if no release came after it. */
export function holdOf(interventions: readonly Intervention[] | undefined): DeliveryHold | undefined {
  const last = interventions?.findLast((i) => i.act === 'hold' || i.act === 'release');
  if (last?.act !== 'hold') return undefined;
  return { by: last.by, at: last.at, step: last.step, owner: last.owner ?? 'hopper', ...(last.reason ? { reason: last.reason } : {}) };
}

/** A job at work in its pane: Park stops it there. */
const AT_WORK = new Set<Job['status']>(['running', 'waiting_answer', 'waiting_on']);
const ENDED = new Set<Job['status']>(['finished', 'failed', 'cancelled', 'rejected']);
/** The steps Park reaches: while the job's own agent may still work on the change. */
const PARK_STEPS = new Set<DeliveryStep>(['queued', 'coding', 'pr_checks']);
/** The steps an expedite flag still changes: up to the cutoff of the change's promotion set. */
const EXPEDITE_STEPS = new Set<DeliveryStep>(['queued', 'coding', 'pr_checks', 'landing', 'landing_checks', 'promotion_set']);

/**
 * The acts the step a change is in allows, in the order the job page shows them. None on a closed track. A held change is
 * only released. A parked job is only picked up. A job at work in its pane is parked; else, from `pr_checks` on, its change
 * is held or taken over. Run again starts a new job from any step before production, once the job ended. Expedite only
 * while the flag can still change its promotion set, when its schedule allows it, and the flag is not on already. A
 * different target is no act: production is the only target.
 */
export function allowedActs(
  t: Pick<KeptTrack, 'state' | 'current'> & Partial<Pick<KeptTrack, 'hold' | 'interventions'>>,
  job?: Pick<Job, 'status'>,
  delivery?: Pick<DeliveryRepo, 'schedule'>,
): AllowedAct[] {
  if (t.state !== 'open') return [];
  if (t.hold ?? holdOf(t.interventions)) return ['release'];
  if (job?.status === 'parked') return ['pick_up'];
  const step = t.current.step;
  if (job && AT_WORK.has(job.status)) return PARK_STEPS.has(step) ? ['park'] : [];
  const acts: AllowedAct[] = step === 'queued' || step === 'coding' ? [] : ['hold', 'take_ownership'];
  if (job && ENDED.has(job.status) && step !== 'production') acts.push('run_again');
  const flagged = t.interventions?.findLast((i) => i.act === 'expedite')?.expedite === true;
  if (EXPEDITE_STEPS.has(step) && delivery?.schedule?.expedite === 'out_of_cadence' && !flagged) acts.push('expedite');
  return acts;
}

// The hold's effect (part 7): the step's owner — yolo mode, the batch runner, the stable move — reads which changes a hold
// holds from the hold and release events, not from the kept track, so a hold counts from its event on, not from the next
// pass of the tracks.

/** The events a hold is read from. */
export const HOLD_EVENTS = ['delivery_track.held', 'delivery_track.released'] as const;

/** Each job whose change a hold holds: its last hold or release, by seq, is a hold. The events in any order. */
export function heldJobs(events: readonly DomainEvent[]): Map<string, DeliveryHold> {
  const last = new Map<string, DomainEvent>();
  for (const e of events) {
    if (e.jobId === undefined || !(HOLD_EVENTS as readonly string[]).includes(e.type)) continue;
    if ((last.get(e.jobId)?.seq ?? -1) < e.seq) last.set(e.jobId, e);
  }
  const out = new Map<string, DeliveryHold>();
  for (const [jobId, e] of last) {
    const i = interventionOf(e, (e.data as { step: DeliveryStep }).step);
    const hold = i && holdOf([i]);
    if (hold) out.set(jobId, hold);
  }
  return out;
}

/** What the step's owner says while a hold holds a change: who owns it, the step, since when and why. Names no person. */
export const holdWhy = (h: DeliveryHold): string =>
  `its delivery is held: ${h.owner === 'person' ? 'a person took ownership of it' : 'paused'} at ${h.step} since ${h.at}${h.reason ? ` (${h.reason})` : ''}; a release lets it go on`;

/** The numbers of the pull requests of `repo` among these URLs. */
export function heldNumbers(urls: readonly string[], repo: string): Set<number> {
  const out = new Set<number>();
  for (const url of urls) {
    const m = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
    if (m && m[1]!.toLowerCase() === repo.toLowerCase()) out.add(Number(m[2]));
  }
  return out;
}

/**
 * Where a batch run stops for a held change: the landing branch is one line, so the batch run takes it up to the first held
 * merge, the parent before it, and the changes after it wait with it. `commits` oldest first, as a compare answers them.
 */
export function heldCut(commits: readonly { sha: string; parents: string[]; message: string }[], held: ReadonlySet<number>): { pullRequest: number; tip: string } | undefined {
  for (const c of commits) {
    const n = Number(/^Merge pull request #(\d+) /.exec(c.message)?.[1]);
    if (held.has(n) && c.parents[0] !== undefined) return { pullRequest: n, tip: c.parents[0] };
  }
  return undefined;
}
