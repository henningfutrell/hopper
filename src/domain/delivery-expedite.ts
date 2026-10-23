// The expedite flag (issue #2554 part 4, design.md "Delivery forecasts"): a person flags a change — a job, an issue or a
// pull request — as expedited, recorded as `delivery_expedite.changed`. A delivery track is expedited when the newest flag
// that names its job, its issue or its pull request turned it on; its forecast then shows the expedited path beside the
// normal one. Pure.
import type { DeliveryTrack } from './delivery-history.ts';
import type { DomainEvent } from './types.ts';

/** What a flag names: exactly one of a job id, an issue (`owner/name#N`, lowercased) or a pull request URL. */
export type ExpediteTarget = { job: string } | { issue: string } | { pullRequest: string };
/** The answer to a flag: its target, on or off, and when on, who turned it on and when. */
export type DeliveryExpediteView = ExpediteTarget & { expedite: boolean; by?: string; at?: string };

/** The target a request names (`job`, `issue` or `pr`); the caller checks that it names exactly one. */
export function expediteTargetOf(q: { job?: string; issue?: string; pr?: string }): ExpediteTarget {
  if (q.job !== undefined) return { job: q.job };
  if (q.issue !== undefined) return { issue: q.issue.toLowerCase() };
  return { pullRequest: q.pr! };
}

interface Flag { job?: string; issue?: string; pullRequest?: string; expedite: boolean; by: string }

const names = (f: Flag, t: ExpediteTarget): boolean =>
  'job' in t ? f.job === t.job : 'issue' in t ? f.issue?.toLowerCase() === t.issue.toLowerCase() : f.pullRequest === t.pullRequest;

/** The newest flag of `delivery_expedite.changed` events that names one of `targets`. */
function newestFlag(events: readonly DomainEvent[], targets: readonly ExpediteTarget[]): { flag: Flag; at: string } | undefined {
  let out: { flag: Flag; at: string; seq: number } | undefined;
  for (const e of events) {
    if (e.type !== 'delivery_expedite.changed' || (out && e.seq < out.seq)) continue;
    const flag = e.data as unknown as Flag;
    if (targets.some((t) => names(flag, t))) out = { flag, at: e.at, seq: e.seq };
  }
  return out;
}

/** A target's own newest flag: on (who, and when) or off; never flagged: undefined. */
export function targetFlag(events: readonly DomainEvent[], t: ExpediteTarget): { expedite: boolean; by: string; at: string } | undefined {
  const f = newestFlag(events, [t]);
  return f && { expedite: f.flag.expedite, by: f.flag.by, at: f.at };
}

/** A track is expedited when the newest flag naming its job, its issue or its pull request is on. */
export function expediteOf(events: readonly DomainEvent[], track: DeliveryTrack): { by: string; at: string } | undefined {
  const targets: ExpediteTarget[] = [{ job: track.jobId }];
  if (track.issue) targets.push({ issue: track.issue });
  if (track.pullRequest) targets.push({ pullRequest: track.pullRequest });
  const f = newestFlag(events, targets);
  return f?.flag.expedite ? { by: f.flag.by, at: f.at } : undefined;
}
