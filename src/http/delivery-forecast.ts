// Delivery forecasts' read (issue #2554 part 2, design.md "Delivery forecasts"): GET /api/delivery-forecast, for a job,
// an issue or a pull request, the step its change is in and the expected end of each step left, from the step durations
// measured on its repository's jobs of the last HISTORY_DAYS days. No promotion set schedule, delivery gate or expedite
// flag yet (later parts): the scheduled steps are `unknown`. Read only.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { deliveryForecast, type DeliveryForecast } from '../domain/delivery-forecast.ts';
import { deliveryTracks, stepHistory, TRACK_EVENTS, type DeliveryTrack } from '../domain/delivery-history.ts';
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
}).refine((q) => [q.job, q.issue, q.pr].filter((v) => v !== undefined).length === 1, { message: 'name one of job, issue or pr' });

export interface DeliveryForecastView {
  jobId: string;
  repo?: string;
  issue?: string;
  pullRequest?: string;
  historyDays: number;
  forecast: DeliveryForecast;
}

export const DELIVERY_FORECAST_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/delivery-forecast', tag: 'Jobs', summary: 'Where a change is on its way to production, and when each step left is expected to end', description: `The delivery forecast (issue #2554) of one change, named by exactly one of \`job\` (a job id), \`issue\` (\`owner/name#N\`: its newest job) or \`pr\` (a pull request URL: the job that opened or followed it). The steps: \`queued\`, \`coding\`, \`pr_checks\` (the checks and the wait for the merge), \`landing\` (the merge itself), \`landing_checks\` (the batch run into the tested branch), \`promotion_set\`, \`test_gate\`, \`production\`. \`forecast.step\` and \`since\`: the step the change is in. \`forecast.normal.steps\`: each step left, with \`start\`, its \`end\` at p50 and \`endP90\` at p90, \`basis\` \`measured\` and \`samples\` — the step durations of the repository's jobs of the last ${HISTORY_DAYS} days (\`historyDays\`) —, or \`unknown\` with no time: fewer than 5 samples, a step before it unknown, or a scheduled step with no promotion set schedule. A later step never ends before the step before it. \`slipping\` (the current step past its p90 end, with its \`blocker\`). Times are UTC ISO strings. 400: not exactly one of them, or a bad one. 404: no such job, or no job of that issue or pull request. 409: the job ended with no merged pull request.`, query: deliveryForecastQuery, returns: '`DeliveryForecastView` `{ jobId, repo?, issue?, pullRequest?, historyDays, forecast: DeliveryForecast }`', errors: [400, 404, 409] },
];

const newest = (tracks: Iterable<DeliveryTrack>, match: (t: DeliveryTrack) => boolean): DeliveryTrack | undefined => {
  let out: DeliveryTrack | undefined;
  for (const t of tracks) if (match(t) && (!out || t.actuals[0]!.start >= out.actuals[0]!.start)) out = t;
  return out;
};

/** The forecast of the change the query names, at `now`. */
export function deliveryForecastOf(t: TenantParts, query: unknown, now: Date): DeliveryForecastView {
  const q = parseWith(deliveryForecastQuery, query);
  const job = q.job === undefined ? undefined : t.store.jobs.get(q.job);
  if (q.job !== undefined && !job) throw new HttpError(404, `job ${q.job} not found`);
  // From the window's start, or the job's own queueing when that is earlier.
  const windowStart = now.getTime() - HISTORY_DAYS * DAY;
  const since = new Date(job ? Math.min(windowStart, Date.parse(job.createdAt)) : windowStart).toISOString();
  const tracks = deliveryTracks(t.store.events.between(TRACK_EVENTS, since));
  const track = job ? tracks.get(job.id)
    : q.issue ? newest(tracks.values(), (x) => x.issue?.toLowerCase() === q.issue!.toLowerCase())
      : newest(tracks.values(), (x) => x.pullRequest === q.pr);
  if (!track) throw new HttpError(404, job ? `job ${job.id} has no delivery track` : `no job of ${q.issue ?? q.pr}`);
  const status = (job ?? t.store.jobs.get(track.jobId))?.status;
  if (status && ENDED.has(status) && !track.actuals.some((a) => a.step === 'landing')) throw new HttpError(409, `job ${track.jobId} ended ${status} with no merged pull request`);
  // Measured only from the window: an old job's own early steps are no history.
  const history = stepHistory([...tracks.values()].filter((x) => x.actuals[0]!.start >= new Date(windowStart).toISOString()), track.repo ?? '');
  return {
    jobId: track.jobId,
    ...(track.repo ? { repo: track.repo } : {}), ...(track.issue ? { issue: track.issue } : {}), ...(track.pullRequest ? { pullRequest: track.pullRequest } : {}),
    historyDays: HISTORY_DAYS,
    forecast: deliveryForecast({ now: now.toISOString(), current: track.current, history: track.repo ? history : {}, gates: {} }),
  };
}

export function deliveryForecastRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts; clock: Clock }): void {
  app.get('/api/delivery-forecast', async (req): Promise<DeliveryForecastView> => deliveryForecastOf(o.tenant(req), req.query, o.clock.now()));
}
