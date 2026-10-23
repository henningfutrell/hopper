// Delivery forecasts' read (issue #2554 part 2, design.md "Delivery forecasts"): GET /api/delivery-forecast, for a job,
// an issue or a pull request, the step its change is in and the expected end of each step left, from the step durations
// measured on its repository's jobs of the last HISTORY_DAYS days; or a promotion set by its number, with the changes in
// it. The scheduled steps take their times from the repository's delivery settings (part 3), else they are `unknown`. An
// expedited change (part 4, a person's flag) also has the expedited path. A gate cleared for the change's promotion set
// (part 5, a person's act) ends that step from the clearance. Read only.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { deliveryForecast, scheduledPlace, type DeliveryForecast, type ForecastInput } from '../domain/delivery-forecast.ts';
import { DEFAULT_DELIVERY_SETTINGS, deliveryOf, type DeliveryRepo } from '../domain/delivery-settings.ts';
import type { DeliveryStep } from '../domain/delivery-steps.ts';
import { MAX_SET, promotionSetNumbered, promotionSetOf, type PromotionSet } from '../domain/promotion-sets.ts';
import { deliveryTracks, stepHistory, TRACK_EVENTS, type DeliveryTrack } from '../domain/delivery-history.ts';
import { expediteOf } from '../domain/delivery-expedite.ts';
import { gateClearancesOf } from '../domain/delivery-gates.ts';
import type { DomainEvent } from '../domain/types.ts';
import type { Clock } from '../domain/ports.ts';
import { HttpError, parseWith } from './errors.ts';
import type { Operation } from './openapi-operation.ts';
import type { TenantParts } from './tenants.ts';

/** How far back the step durations are measured. */
export const HISTORY_DAYS = 30;
const DAY = 86_400_000;
/** A job that ended so, with no merged pull request, carries no change. */
const ENDED = new Set(['failed', 'cancelled', 'rejected']);

export const deliveryForecastQuery = z.object({
  job: z.string().min(1).max(200).optional(),
  issue: z.string().regex(/^[\w.-]+\/[\w.-]+#\d+$/).optional(),
  pr: z.url().max(500).optional(),
  set: z.coerce.number().int().min(1).max(MAX_SET).optional(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
}).refine((q) => [q.job, q.issue, q.pr, q.set].filter((v) => v !== undefined).length === 1, { message: 'name one of job, issue, pr or set' })
  .refine((q) => (q.set === undefined) === (q.repo === undefined), { message: 'a set needs its repo, and only a set takes one' });

export interface DeliveryForecastView {
  jobId: string;
  repo?: string;
  issue?: string;
  pullRequest?: string;
  historyDays: number;
  /** A person flagged the change as expedited: who, and when. Then `forecast.expedited` is its expedited path. */
  expedited?: { by: string; at: string };
  /** Past the end of production by its schedule, with no delivery gate holding it: then no forecast. */
  deliveredAt?: string;
  forecast?: DeliveryForecast;
}

/** A change in a promotion set, or expected in it: where it is now. */
export interface PromotionSetChange { jobId: string; issue?: string; pullRequest?: string; step: DeliveryStep | 'delivered'; expected?: true; expedited?: true }

export interface PromotionSetForecastView {
  repo: string;
  set: PromotionSet;
  opensAt: string;
  deliveredAt?: string;
  /** Where the set is: its scheduled steps, from its opening. */
  forecast?: DeliveryForecast;
  changes: PromotionSetChange[];
}

export const DELIVERY_FORECAST_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/delivery-forecast', tag: 'Jobs', summary: 'Where a change is on its way to production, and when each step left is expected to end', description: `The delivery forecast (issue #2554) of one change, named by exactly one of \`job\` (a job id), \`issue\` (\`owner/name#N\`: its newest job) or \`pr\` (a pull request URL: the job that opened or followed it). The steps: \`queued\`, \`coding\`, \`pr_checks\` (the checks and the wait for the merge), \`landing\` (the merge itself), \`landing_checks\` (the batch run into the tested branch), \`promotion_set\`, \`test_gate\`, \`production\`. \`forecast.step\` and \`since\`: the step the change is in. \`forecast.normal.steps\`: each step left, with \`start\`, its \`end\` at p50 and \`endP90\` at p90, \`basis\` \`measured\` and \`samples\` — the step durations of the repository's jobs of the last ${HISTORY_DAYS} days (\`historyDays\`) —, or \`unknown\` with no time: fewer than 5 samples, a step before it unknown, or a scheduled step with no promotion set schedule. A later step never ends before the step before it. \`slipping\` (the current step past its p90 end, with its \`blocker\`). The scheduled steps take their times from the repository's promotion set \`schedule\` in \`/api/delivery-settings\` (part 3): \`basis\` \`scheduled\`, the \`set\` at p50 and \`setP90\`. A scheduled step with no delivery gate ends at its scheduled end; a step with a gate holds the change until a person clears the gate for its promotion set (part 5, \`POST /ui/api/delivery-gate\`; then the step ends at the clearance, not before it starts): \`wait\` \`{ kind: human_gate, owner, since }\`, and \`remaining\` splits the time left at p50 into \`humanMs\`, \`scheduleMs\` and \`machineMs\`. Past the end of production with no gate holding it: \`deliveredAt\` and no \`forecast\`. Or \`set\` (a number) with its \`repo\` (\`owner/name\`): that promotion set — \`PromotionSetForecastView\` \`{ repo, set: { set, cutoffAt, testGateAt, productionAt }, opensAt, deliveredAt?, forecast?, changes }\`, its own step and the ends of its steps left, and \`changes\`: each change of the window in it (since its landing checks ended) or \`expected\` in it by its p50 path, with its \`step\` and \`expedited\`. An expedited change (part 4, \`POST /ui/api/delivery-expedite\`): \`expedited\` \`{ by, at }\`, and \`forecast.expedited\` its fastest path by its promotion set schedule's \`expedite\` (\`out_of_cadence\`: the \`promotion_set\` step ends at once, \`outOfCadence\`), beside \`forecast.normal\` and never later. Times are UTC ISO strings. 400: not exactly one of them, or a bad one. 404: no such job, no job of that issue or pull request, or no promotion set schedule for that repository. 409: the job ended with no merged pull request.`, query: deliveryForecastQuery, returns: '`DeliveryForecastView` `{ jobId, repo?, issue?, pullRequest?, historyDays, expedited?, deliveredAt?, forecast?: DeliveryForecast }`, or `PromotionSetForecastView`', errors: [400, 404, 409] },
];

const newest = (tracks: Iterable<DeliveryTrack>, match: (t: DeliveryTrack) => boolean): DeliveryTrack | undefined => {
  let out: DeliveryTrack | undefined;
  for (const t of tracks) if (match(t) && (!out || t.actuals[0]!.start >= out.actuals[0]!.start)) out = t;
  return out;
};

/** Every gate clearance, as the expedite flags: not bound to the window. */
const clearancesOf = (t: TenantParts): DomainEvent[] => t.store.events.between(['delivery_gate.cleared'], new Date(0).toISOString());

/** When each gate of the promotion set a change is in was cleared; none before its landing checks end. */
function clearedOf(clearances: readonly DomainEvent[], d: DeliveryRepo, repo: string | undefined, current: DeliveryTrack['current'], set?: number): Partial<Record<DeliveryStep, string>> {
  const n = set ?? (d.schedule && current.step === 'promotion_set' ? promotionSetOf(d.schedule, current.since)?.set : undefined);
  if (n === undefined || !repo) return {};
  return Object.fromEntries(Object.entries(gateClearancesOf(clearances, repo, n)).map(([step, c]) => [step, c.at]));
}

/** A change's place and forecast at `now`, by its repository's delivery settings and its set's gate clearances. */
function forecastOf(track: DeliveryTrack, d: DeliveryRepo, history: ForecastInput['history'], now: string, cleared: Partial<Record<DeliveryStep, string>>, expedite = false): { deliveredAt: string } | { forecast: DeliveryForecast } {
  const place = scheduledPlace(d.schedule, track.current, d.gates, now, cleared);
  if ('deliveredAt' in place) return place;
  return { forecast: deliveryForecast({ now, current: place, history, gates: d.gates, ...(d.schedule ? { schedule: d.schedule } : {}), ...(expedite ? { expedite } : {}) }) };
}

/** Every expedite flag: a flag is not bound to the window, since a change may be flagged before its newest job. */
const flagsOf = (t: TenantParts): DomainEvent[] => t.store.events.between(['delivery_expedite.changed'], new Date(0).toISOString());

/** The tracks of the window: from its start, or `from` when that is earlier. */
function tracksOf(t: TenantParts, now: Date, from?: string): { tracks: Map<string, DeliveryTrack>; windowStart: string } {
  const windowStart = new Date(now.getTime() - HISTORY_DAYS * DAY).toISOString();
  return { tracks: deliveryTracks(t.store.events.between(TRACK_EVENTS, from && from < windowStart ? from : windowStart)), windowStart };
}

/** Measured only from the window: an old job's own early steps are no history. */
const historyOf = (tracks: Map<string, DeliveryTrack>, windowStart: string, repo: string | undefined): ForecastInput['history'] =>
  repo ? stepHistory([...tracks.values()].filter((x) => x.actuals[0]!.start >= windowStart), repo) : {};

/** A job that ended with no merged pull request carries no change. */
const carriesNoChange = (t: TenantParts, track: DeliveryTrack): string | undefined => {
  const status = t.store.jobs.get(track.jobId)?.status;
  return status && ENDED.has(status) && !track.actuals.some((a) => a.step === 'landing') ? status : undefined;
};

/** The forecast of the change the query names, or of the promotion set it names, at `now`. */
export function deliveryForecastOf(t: TenantParts, query: unknown, now: Date): DeliveryForecastView | PromotionSetForecastView {
  const q = parseWith(deliveryForecastQuery, query);
  if (q.set !== undefined) return promotionSetForecastOf(t, q.repo!, q.set, now);
  const job = q.job === undefined ? undefined : t.store.jobs.get(q.job);
  if (q.job !== undefined && !job) throw new HttpError(404, `job ${q.job} not found`);
  const { tracks, windowStart } = tracksOf(t, now, job?.createdAt);
  const track = job ? tracks.get(job.id)
    : q.issue ? newest(tracks.values(), (x) => x.issue?.toLowerCase() === q.issue!.toLowerCase())
      : newest(tracks.values(), (x) => x.pullRequest === q.pr);
  if (!track) throw new HttpError(404, job ? `job ${job.id} has no delivery track` : `no job of ${q.issue ?? q.pr}`);
  const ended = carriesNoChange(t, track);
  if (ended) throw new HttpError(409, `job ${track.jobId} ended ${ended} with no merged pull request`);
  const d = deliveryOf(t.store.settings.getDeliverySettings() ?? DEFAULT_DELIVERY_SETTINGS, track.repo);
  const expedited = expediteOf(flagsOf(t), track);
  return {
    jobId: track.jobId,
    ...(track.repo ? { repo: track.repo } : {}), ...(track.issue ? { issue: track.issue } : {}), ...(track.pullRequest ? { pullRequest: track.pullRequest } : {}),
    historyDays: HISTORY_DAYS, ...(expedited ? { expedited } : {}),
    ...forecastOf(track, d, historyOf(tracks, windowStart, track.repo), now.toISOString(), clearedOf(clearancesOf(t), d, track.repo, track.current), expedited !== undefined),
  };
}

/** Set `n` of `repo`: its times, where it is by its schedule and gates, and the changes of the window in it or expected in it. */
function promotionSetForecastOf(t: TenantParts, repo: string, n: number, now: Date): PromotionSetForecastView {
  const d = deliveryOf(t.store.settings.getDeliverySettings() ?? DEFAULT_DELIVERY_SETTINGS, repo);
  if (!d.schedule) throw new HttpError(404, `${repo} has no promotion set schedule`);
  const s = d.schedule;
  const found = promotionSetNumbered(s, n);
  if (!found) throw new HttpError(404, `${repo} has no promotion set ${n}`);
  const at = now.toISOString();
  const { tracks, windowStart } = tracksOf(t, now);
  const history = historyOf(tracks, windowStart, repo);
  const flags = flagsOf(t);
  const clearances = clearancesOf(t);
  const changes: PromotionSetChange[] = [];
  for (const track of [...tracks.values()].sort((a, b) => a.actuals[0]!.start.localeCompare(b.actuals[0]!.start))) {
    if (track.repo?.toLowerCase() !== repo.toLowerCase() || carriesNoChange(t, track)) continue;
    const f = forecastOf(track, d, history, at, clearedOf(clearances, d, repo, track.current));
    // In the set once its landing checks ended (the promotion set step's start); else expected in it by its p50 path.
    const inSet = track.current.step === 'promotion_set' ? promotionSetOf(s, track.current.since)?.set : undefined;
    const expected = inSet === undefined && 'forecast' in f ? f.forecast.normal.steps.find((x) => x.step === 'promotion_set')?.set : undefined;
    if ((inSet ?? expected) !== n) continue;
    changes.push({
      jobId: track.jobId, ...(track.issue ? { issue: track.issue } : {}), ...(track.pullRequest ? { pullRequest: track.pullRequest } : {}),
      step: 'forecast' in f ? f.forecast.step : 'delivered', ...(inSet === undefined ? { expected: true as const } : {}),
      ...(expediteOf(flags, track) ? { expedited: true as const } : {}),
    });
  }
  const current = { step: 'promotion_set' as const, since: found.opensAt };
  const set = forecastOf({ jobId: `set-${n}`, actuals: [], current }, d, {}, at, clearedOf(clearances, d, repo, current, n));
  return { repo: repo.toLowerCase(), set: found.set, opensAt: found.opensAt, ...set, changes };
}

export function deliveryForecastRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts; clock: Clock }): void {
  app.get('/api/delivery-forecast', async (req): Promise<DeliveryForecastView | PromotionSetForecastView> => deliveryForecastOf(o.tenant(req), req.query, o.clock.now()));
}
