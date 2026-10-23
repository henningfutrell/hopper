// Delivery forecasts (issue #2554, design.md "Delivery forecasts"): where a change is on its way to production, and
// when it is expected at the end of each step left. Measured steps take their p50 and p90 from history; with too little
// history a step says so and no later time is given. The promotion sets fix the scheduled steps. Each path chains its
// steps: a step starts when the one before it ends, at p50 and at p90 apart. Pure: the clock is `now`.
import {
  DEFAULT_BLOCKER, DELIVERY_STEPS, MIN_SAMPLES, SCHEDULED_STEPS, stepEstimate, type Blocker, type DeliveryStep,
} from './delivery-steps.ts';
import { nextCutoff, promotionSetOf, type PromotionSetSchedule } from './promotion-sets.ts';

export interface ForecastInput {
  now: string;
  /** The step the change is in, since when, and what holds it when the change knows. */
  current: { step: DeliveryStep; since: string; blocker?: Blocker };
  /** Measured durations in ms of each measured step, of the change's repository. */
  history: Partial<Record<DeliveryStep, readonly number[]>>;
  minSamples?: number;
  /** Absent: the repository has no promotion set schedule, and the scheduled steps are `unknown`. */
  schedule?: PromotionSetSchedule;
  /** The delivery gates: steps that end only by a person's act, each with its owner. */
  gates: Partial<Record<DeliveryStep, { owner: string }>>;
  expedite?: boolean;
}

export interface StepForecast {
  step: DeliveryStep;
  /** `unknown`: too little history for this step, or a step before it is unknown. */
  basis: 'measured' | 'scheduled' | 'unknown';
  samples?: number;
  start?: string;
  /** The end at p50 (a scheduled step: its scheduled end). */
  end?: string;
  /** The end at p90. */
  endP90?: string;
  /** The promotion set, at p50 and at p90. */
  set?: number;
  setP90?: number;
  /** An expedited change's own set, at once. */
  outOfCadence?: true;
  gate?: { owner: string };
}

export interface DeliveryPath {
  steps: StepForecast[];
  productionAt?: string;
  productionAtP90?: string;
  /** The time left at p50: a person's wait at delivery gates, the wait for a cutoff, and the rest. */
  remaining?: { machineMs: number; scheduleMs: number; humanMs: number };
}

export interface DeliveryForecast {
  now: string;
  step: DeliveryStep;
  since: string;
  /** The current step ran past its p90 (a scheduled step: past its scheduled end). */
  slipping?: { blocker: Blocker; expectedEnd: string };
  wait?: { kind: 'human_gate'; owner: string; since: string };
  normal: DeliveryPath;
  /** Only when the change is expedited: the fastest path the schedule allows. */
  expedited?: DeliveryPath;
}

const iso = (ms: number) => new Date(ms).toISOString();
const MINUTE = 60_000;

/** A scheduled step's end from its start: a cutoff (or at once, out of cadence) or the schedule's minutes. */
function scheduledEnd(step: DeliveryStep, startMs: number, s: PromotionSetSchedule | undefined, outOfCadence: boolean): number | undefined {
  if (!s) return undefined;
  if (step === 'promotion_set') return outOfCadence ? startMs : nextCutoff(s, startMs);
  return startMs + (step === 'test_gate' ? s.testGateAfterMinutes : s.productionAfterMinutes) * MINUTE;
}

/** One path from the current step, and the current step's own end at p90 before the clock moved it. */
function pathOf(f: ForecastInput, expedite: boolean): { path: DeliveryPath; currentEndP90?: number } {
  const now = Date.parse(f.now);
  const outOfCadence = expedite && f.schedule?.expedite === 'out_of_cadence';
  let t50: number | undefined = Date.parse(f.current.since);
  let t90 = t50;
  let currentEndP90: number | undefined;
  const steps: StepForecast[] = [];
  for (const step of DELIVERY_STEPS.slice(DELIVERY_STEPS.indexOf(f.current.step))) {
    const gate = f.gates[step];
    const sf: StepForecast = { step, basis: 'unknown', ...(gate ? { gate: { owner: gate.owner } } : {}) };
    steps.push(sf);
    if (t50 === undefined) continue;
    let e50: number | undefined;
    let e90: number | undefined;
    if (SCHEDULED_STEPS.includes(step)) {
      e50 = scheduledEnd(step, t50, f.schedule, outOfCadence);
      e90 = scheduledEnd(step, t90, f.schedule, outOfCadence);
    } else {
      const est = stepEstimate(step, f.history[step] ?? [], f.minSamples ?? MIN_SAMPLES);
      sf.samples = est.samples;
      if (est.confidence === 'measured') {
        e50 = t50 + est.p50Ms;
        e90 = t90 + est.p90Ms;
      }
    }
    sf.start = iso(t50);
    if (e50 === undefined || e90 === undefined) {
      t50 = undefined;
      continue;
    }
    sf.basis = SCHEDULED_STEPS.includes(step) ? 'scheduled' : 'measured';
    if (step === 'promotion_set') {
      if (outOfCadence) sf.outOfCadence = true;
      else Object.assign(sf, { set: promotionSetOf(f.schedule!, iso(t50))?.set, setP90: promotionSetOf(f.schedule!, iso(t90))?.set });
    }
    if (step === f.current.step) {
      currentEndP90 = e90;
      e50 = Math.max(e50, now);
      e90 = Math.max(e90, now);
    }
    // The p90 path is never ahead of the p50 path.
    e90 = Math.max(e90, e50);
    Object.assign(sf, { end: iso(e50), endP90: iso(e90) });
    t50 = e50;
    t90 = e90;
  }
  const path: DeliveryPath = { steps };
  if (t50 !== undefined) {
    const remaining = { machineMs: 0, scheduleMs: 0, humanMs: 0 };
    for (const s of steps) {
      const left = Math.max(0, Date.parse(s.end!) - Math.max(Date.parse(s.start!), now));
      const kind = s.gate ? 'humanMs' : s.step === 'promotion_set' ? 'scheduleMs' : 'machineMs';
      remaining[kind] += left;
    }
    Object.assign(path, { productionAt: iso(t50), productionAtP90: iso(t90), remaining });
  }
  return { path, ...(currentEndP90 === undefined ? {} : { currentEndP90 }) };
}

/** The forecast of one change: its step, a slip with its blocker, a person's wait at a gate, and its paths. */
export function deliveryForecast(f: ForecastInput): DeliveryForecast {
  const { path: normal, currentEndP90 } = pathOf(f, false);
  const gate = f.gates[f.current.step];
  const out: DeliveryForecast = { now: f.now, step: f.current.step, since: f.current.since, normal };
  if (currentEndP90 !== undefined && Date.parse(f.now) > currentEndP90) {
    const blocker = gate ? 'human_gate' : (f.current.blocker ?? DEFAULT_BLOCKER[f.current.step]);
    out.slipping = { blocker, expectedEnd: iso(currentEndP90) };
  }
  if (gate) out.wait = { kind: 'human_gate', owner: gate.owner, since: f.current.since };
  if (f.expedite) out.expedited = pathOf(f, true).path;
  return out;
}
