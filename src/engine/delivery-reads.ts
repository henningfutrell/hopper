// Delivery forecasts' reads of the store (issue #2554, design.md "Delivery forecasts"): the delivery tracks of the last
// HISTORY_DAYS days, the measured step durations, the expedite flags and gate clearances, and the forecast of one change at
// a time. GET /api/delivery-forecast and the delivery ledger pass both read through them. Read only.
import { deliveryForecast, scheduledPlace, type DeliveryForecast, type ForecastInput } from '../domain/delivery-forecast.ts';
import type { DeliveryRepo } from '../domain/delivery-settings.ts';
import type { DeliveryStep } from '../domain/delivery-steps.ts';
import { promotionSetOf } from '../domain/promotion-sets.ts';
import { deliveryTracks, stepHistory, TRACK_EVENTS, type DeliveryTrack } from '../domain/delivery-history.ts';
import { gateClearancesOf } from '../domain/delivery-gates.ts';
import type { UserStore } from '../domain/store.ts';
import type { DomainEvent } from '../domain/types.ts';

/** How far back the step durations are measured. */
export const HISTORY_DAYS = 30;
const DAY = 86_400_000;
/** A job that ended so, with no merged pull request, carries no change. */
const ENDED = new Set(['failed', 'cancelled', 'rejected']);

type Store = { store: UserStore };

/** Every gate clearance, as the expedite flags: not bound to the window. */
export const clearancesOf = (s: Store): DomainEvent[] => s.store.events.between(['delivery_gate.cleared'], new Date(0).toISOString());

/** When each gate of the promotion set a change is in was cleared; none before its landing checks end. */
export function clearedOf(clearances: readonly DomainEvent[], d: DeliveryRepo, repo: string | undefined, current: DeliveryTrack['current'], set?: number): Partial<Record<DeliveryStep, string>> {
  const n = set ?? (d.schedule && current.step === 'promotion_set' ? promotionSetOf(d.schedule, current.since)?.set : undefined);
  if (n === undefined || !repo) return {};
  return Object.fromEntries(Object.entries(gateClearancesOf(clearances, repo, n)).map(([step, c]) => [step, c.at]));
}

/** A change's place and forecast at `now`, by its repository's delivery settings and its set's gate clearances. */
export function forecastOf(track: DeliveryTrack, d: DeliveryRepo, history: ForecastInput['history'], now: string, cleared: Partial<Record<DeliveryStep, string>>, expedite = false): { deliveredAt: string } | { forecast: DeliveryForecast } {
  const place = scheduledPlace(d.schedule, track.current, d.gates, now, cleared);
  if ('deliveredAt' in place) return place;
  return { forecast: deliveryForecast({ now, current: place, history, gates: d.gates, ...(d.schedule ? { schedule: d.schedule } : {}), ...(expedite ? { expedite } : {}) }) };
}

/** Every expedite flag: a flag is not bound to the window, since a change may be flagged before its newest job. */
export const flagsOf = (s: Store): DomainEvent[] => s.store.events.between(['delivery_expedite.changed'], new Date(0).toISOString());

/** The tracks of the window: from its start, or `from` when that is earlier. */
export function tracksOf(s: Store, now: Date, from?: string): { tracks: Map<string, DeliveryTrack>; windowStart: string } {
  const windowStart = new Date(now.getTime() - HISTORY_DAYS * DAY).toISOString();
  return { tracks: deliveryTracks(s.store.events.between(TRACK_EVENTS, from && from < windowStart ? from : windowStart)), windowStart };
}

/** Measured only from the window: an old job's own early steps are no history. */
export const historyOf = (tracks: Map<string, DeliveryTrack>, windowStart: string, repo: string | undefined): ForecastInput['history'] =>
  repo ? stepHistory([...tracks.values()].filter((x) => x.actuals[0]!.start >= windowStart), repo) : {};

/** A job that ended with no merged pull request carries no change. */
export const carriesNoChange = (s: Store, track: DeliveryTrack): string | undefined => {
  const status = s.store.jobs.get(track.jobId)?.status;
  return status && ENDED.has(status) && !track.actuals.some((a) => a.step === 'landing') ? status : undefined;
};
