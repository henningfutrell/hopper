// Lane tuning (issue #688, design.md "Lane tuning"): every machine's lane recommendation from its lane load over the
// lane tuning window, the usage it burns now and the usage limits, by the decider's rules (src/decider/lane-tuning.ts).
// A recommendation that changes is recorded as `lanes.recommended`. The hopper applies none by itself: an admin applies
// one — the machine's configured lanes set through `machineLanes`, the path an edit of the machine takes, and
// `lanes.applied` with its reason —, dismisses it until it moves (`lanes.dismissed`), or undoes the last one applied
// (`lanes.undone`). Each machine's settings — auto-tune and the bounds — are the user's, in the database.
import { laneEffect } from '../decider/usage.ts';
import { laneActions, recommendLanes } from '../decider/lane-tuning.ts';
import type { UserStore } from '../domain/ports.ts';
import {
  DEFAULT_LANE_TUNING, LANE_TUNING_WINDOW_DAYS, MAX_TUNED_LANES, RESOURCE_PRESSURE, type LaneChange, type LaneRecommendation, type LaneTuning, type LaneTuningPlan,
} from '../domain/types.ts';
import { policyOf, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

const DAY_MS = 86_400_000;
/** The plan lists this many latest changes. */
const CHANGES_SHOWN = 20;
/** How far back a machine's last change is looked for. */
const CHANGES_READ = 500;

/** A change to one machine's lane tuning settings: a field left out keeps its value. */
export type LaneTuningPatch = Partial<LaneTuning>;

export interface LaneTuningService {
  /** Every machine's lane recommendation now: `GET /api/lanes/plan` and `hopper lanes plan`. */
  plan(): Promise<LaneTuningPlan>;
  /** Record `lanes.recommended` for each tuned machine with a known headroom whose recommended or configured lanes changed. How many events. */
  record(): Promise<number>;
  /** Change one machine's settings; `by` names who. The plan after it. */
  set(machineId: string, patch: LaneTuningPatch, by: string): Promise<LaneTuningPlan>;
  /** Apply one machine's recommendation; `lanes`: the lanes the admin saw, refused when it moved since. The plan after it. */
  apply(machineId: string, by: string, lanes?: number): Promise<LaneTuningPlan>;
  /** Dismiss one machine's recommendation until it moves. The plan after it. */
  dismiss(machineId: string, by: string): Promise<LaneTuningPlan>;
  /** Undo the last recommendation applied to one machine. The plan after it. */
  undo(machineId: string, by: string): Promise<LaneTuningPlan>;
}

const tuningOf = (store: UserStore, machineId: string): LaneTuning => store.settings.getLaneTuning()[machineId] ?? DEFAULT_LANE_TUNING;
const lanesText = (n: number): string => `${n} lane${n === 1 ? '' : 's'}`;

function changeOf(e: { at: string; type: string; data: unknown }): LaneChange {
  const d = e.data as { machineId: string; from: number; to: number; reason?: string; by?: string };
  const base = { at: e.at, machineId: d.machineId, from: d.from, to: d.to };
  return e.type === 'lanes.applied'
    ? { ...base, kind: 'applied', reason: d.reason ?? '', ...(d.by === undefined ? {} : { by: d.by }) }
    : { ...base, kind: 'undone', by: d.by ?? '' };
}

export function createLaneTuning(c: EngineContext): LaneTuningService {
  // The last recorded per machine: read from the event log once, so a restart does not record each machine again.
  let last: Map<string, { lanes: number; configured: number }> | undefined;
  const lastRecorded = (): Map<string, { lanes: number; configured: number }> => {
    if (last) return last;
    last = new Map();
    for (const e of c.store.events.recent(500, ['lanes.recommended'])) {
      const d = e.data as { machineId: string; lanes: number; configured: number };
      if (!last.has(d.machineId)) last.set(d.machineId, { lanes: d.lanes, configured: d.configured });
    }
    return last;
  };
  const setDismissal = (machineId: string, d: { lanes: number; configured: number; at: string; by: string } | undefined): void => {
    const { [machineId]: _, ...rest } = c.store.settings.getLaneDismissals();
    c.store.settings.setLaneDismissals(d ? { ...rest, [machineId]: d } : rest);
  };

  const plan = async (): Promise<LaneTuningPlan> => {
    const [machines, readings] = await Promise.all([c.machines.list(), Promise.all(c.usage().map((u) => u.poll())).then((r) => r.flat())]);
    const now = c.clock.now();
    const at = now.toISOString();
    const policy = policyOf(c);
    const dismissals = c.store.settings.getLaneDismissals();
    const changes = c.store.events.recent(CHANGES_READ, ['lanes.applied', 'lanes.undone']).map(changeOf);
    const loads = c.store.machineHistory.laneLoad({ from: new Date(now.getTime() - LANE_TUNING_WINDOW_DAYS * DAY_MS), to: now, pressure: RESOURCE_PRESSURE });
    const machinesOut: LaneRecommendation[] = machines.map((m) => {
      const r = recommendLanes({
        machine: m, loads, usedFrac: laneEffect(m, readings, policy, at).usedFrac, soft: policy.softLimit, hard: policy.hardLimit, tuning: tuningOf(c.store, m.id),
      });
      return { ...r, ...laneActions(r, dismissals[m.id], changes.find((x) => x.machineId === m.id)) };
    });
    return { at, windowDays: LANE_TUNING_WINDOW_DAYS, machines: machinesOut, changes: changes.slice(0, CHANGES_SHOWN) };
  };

  const recordOne = (r: LaneRecommendation): boolean => {
    if (!r.tuning.autoTune || !r.online || r.headroom === undefined) return false;
    const seen = lastRecorded();
    const was = seen.get(r.machineId);
    if (was && was.lanes === r.lanes && was.configured === r.configured) return false;
    c.store.events.append({
      type: 'lanes.recommended',
      data: { machineId: r.machineId, lanes: r.lanes, configured: r.configured, headroom: r.headroom, reason: r.reason, confidence: r.confidence, usage: r.usage },
    });
    seen.set(r.machineId, { lanes: r.lanes, configured: r.configured });
    return true;
  };

  /** The machine's recommendation now; 404 for a machine not listed. */
  const recommendationOf = async (machineId: string): Promise<LaneRecommendation> => {
    const r = (await plan()).machines.find((m) => m.machineId === machineId);
    if (!r) throw new EngineError('not_found', `no machine ${machineId}`);
    return r;
  };

  return {
    plan,
    async record() {
      if (c.stopping()) return 0;
      const p = await plan();
      if (c.stopping()) return 0;
      return p.machines.filter(recordOne).length;
    },
    async set(machineId, patch, by) {
      if (!(await c.machines.list()).some((m) => m.id === machineId)) throw new EngineError('not_found', `no machine ${machineId}`);
      const from = tuningOf(c.store, machineId);
      const to: LaneTuning = { autoTune: patch.autoTune ?? from.autoTune, minLanes: patch.minLanes ?? from.minLanes, maxLanes: patch.maxLanes ?? from.maxLanes };
      if (!(Number.isInteger(to.minLanes) && Number.isInteger(to.maxLanes) && to.minLanes >= 0 && to.maxLanes <= MAX_TUNED_LANES && to.minLanes <= to.maxLanes)) {
        throw new EngineError('invalid', `the bounds must be whole numbers from 0 to ${MAX_TUNED_LANES}, the least lanes at most the most lanes`);
      }
      if (from.autoTune !== to.autoTune || from.minLanes !== to.minLanes || from.maxLanes !== to.maxLanes) {
        c.store.tx(() => {
          c.store.settings.setLaneTuning({ ...c.store.settings.getLaneTuning(), [machineId]: to });
          c.store.events.append({ type: 'lanes.tuning_changed', machineId, data: { machineId, from, to, by } });
        });
      }
      return plan();
    },
    async apply(machineId, by, lanes) {
      const r = await recommendationOf(machineId);
      if (!r.apply) throw new EngineError('conflict', `no lane recommendation to apply on ${machineId}: ${r.dismissed ? `dismissed by ${r.dismissed.by}` : r.reason}`);
      if (lanes !== undefined && lanes !== r.apply.to) throw new EngineError('conflict', `the recommendation moved: ${machineId} now recommends ${lanesText(r.apply.to)}`);
      await c.machineLanes(machineId, r.apply.to);
      c.store.tx(() => {
        setDismissal(machineId, undefined);
        c.store.events.append({
          type: 'lanes.applied', machineId,
          data: { machineId, from: r.configured, to: r.apply!.to, reason: r.reason, confidence: r.confidence, by },
        });
      });
      return plan();
    },
    async dismiss(machineId, by) {
      const r = await recommendationOf(machineId);
      if (!r.apply) throw new EngineError('conflict', `no lane recommendation to dismiss on ${machineId}`);
      c.store.tx(() => {
        setDismissal(machineId, { lanes: r.lanes, configured: r.configured, at: c.clock.now().toISOString(), by });
        c.store.events.append({ type: 'lanes.dismissed', machineId, data: { machineId, lanes: r.lanes, configured: r.configured, reason: r.reason, by } });
      });
      return plan();
    },
    async undo(machineId, by) {
      const r = await recommendationOf(machineId);
      if (!r.undo) throw new EngineError('conflict', `no applied lane recommendation to undo on ${machineId}`);
      await c.machineLanes(machineId, r.undo.to);
      c.store.events.append({ type: 'lanes.undone', machineId, data: { machineId, from: r.configured, to: r.undo.to, by } });
      return plan();
    },
  };
}
