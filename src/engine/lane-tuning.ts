// Lane tuning (issue #688, design.md "Lane tuning"): every machine's lane recommendation from its lane load over the
// lane tuning window, the usage it burns now and the usage limits, by the decider's rules (src/decider/lane-tuning.ts).
// Shadow mode: a recommendation that changes is recorded as `lanes.recommended`, and the decider keeps the configured
// lanes. Active mode: a recommendation is applied — the machine's applied lanes, `lanes.applied` with its reason —, the
// engine lists the machine with them (`tunedMachines`), and an admin undoes the last change (`lanes.undone`). Each
// machine's settings — auto-tune, the bounds, the mode — are the user's, in the database.
import { laneEffect } from '../decider/usage.ts';
import { laneChange, lanesInUse, recommendLanes } from '../decider/lane-tuning.ts';
import type { MachineSource, UserStore } from '../domain/ports.ts';
import {
  DEFAULT_LANE_TUNING, LANE_TUNING_WINDOW_DAYS, MAX_TUNED_LANES, RESOURCE_PRESSURE, type AppliedLanes, type LaneChange, type LaneRecommendation,
  type LaneTuning, type LaneTuningPlan,
} from '../domain/types.ts';
import { policyOf, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

const DAY_MS = 86_400_000;
/** The plan lists this many latest changes. */
const CHANGES_SHOWN = 20;

/** A change to one machine's lane tuning settings: a field left out keeps its value. */
export type LaneTuningPatch = Partial<LaneTuning>;

export interface LaneTuningService {
  /** Every machine's lane recommendation now: `GET /api/lanes/plan` and `hopper lanes plan`. */
  plan(): Promise<LaneTuningPlan>;
  /**
   * Shadow: record `lanes.recommended` for each tuned machine with a known headroom whose recommended or configured lanes
   * changed. Active: apply each recommendation `laneChange` allows. How many events.
   */
  record(): Promise<number>;
  /** Change one machine's settings; `by` names who. The plan after it. */
  set(machineId: string, patch: LaneTuningPatch, by: string): Promise<LaneTuningPlan>;
  /** Undo the last change active mode applied to one machine; `by` names who. The plan after it. */
  undo(machineId: string, by: string): Promise<LaneTuningPlan>;
}

const tuningOf = (store: UserStore, machineId: string): LaneTuning => store.settings.getLaneTuning()[machineId] ?? DEFAULT_LANE_TUNING;

/** The machines with their lanes in use as `maxLanes` (and `configuredLanes` when lane tuning applied others): what the engine reads. */
export function tunedMachines(store: UserStore, source: MachineSource): MachineSource {
  return {
    async list() {
      const machines = await source.list();
      const applied = store.settings.getAppliedLanes();
      return machines.map((m) => {
        const lanes = lanesInUse(m.maxLanes, tuningOf(store, m.id), applied[m.id]);
        return lanes === m.maxLanes ? m : { ...m, maxLanes: lanes, configuredLanes: m.maxLanes };
      });
    },
  };
}

function changeOf(e: { at: string; type: string; data: unknown }): LaneChange {
  const d = e.data as { machineId: string; from: number; to: number; reason?: string; by?: string };
  const base = { at: e.at, machineId: d.machineId, from: d.from, to: d.to };
  return e.type === 'lanes.applied' ? { ...base, kind: 'applied', reason: d.reason ?? '' } : { ...base, kind: 'undone', by: d.by ?? '' };
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
  const setApplied = (machineId: string, a: AppliedLanes | undefined): void => {
    const { [machineId]: _, ...rest } = c.store.settings.getAppliedLanes();
    c.store.settings.setAppliedLanes(a ? { ...rest, [machineId]: a } : rest);
  };

  const plan = async (): Promise<LaneTuningPlan> => {
    const [machines, readings] = await Promise.all([c.machines.list(), Promise.all(c.usage().map((u) => u.poll())).then((r) => r.flat())]);
    const now = c.clock.now();
    const at = now.toISOString();
    const policy = policyOf(c);
    const applied = c.store.settings.getAppliedLanes();
    const loads = c.store.machineHistory.laneLoad({ from: new Date(now.getTime() - LANE_TUNING_WINDOW_DAYS * DAY_MS), to: now, pressure: RESOURCE_PRESSURE });
    const machinesOut: LaneRecommendation[] = machines.map((m) => {
      const tuning = tuningOf(c.store, m.id);
      const r = recommendLanes({
        machine: { ...m, maxLanes: m.configuredLanes ?? m.maxLanes }, inUse: m.maxLanes, loads,
        usedFrac: laneEffect(m, readings, policy, at).usedFrac, soft: policy.softLimit, hard: policy.hardLimit, tuning,
      });
      const a = applied[m.id];
      return a && !a.undone && tuning.mode === 'active' && tuning.autoTune ? { ...r, undo: { to: a.from } } : r;
    });
    const changes = c.store.events.recent(CHANGES_SHOWN, ['lanes.applied', 'lanes.undone']).map(changeOf);
    return { at, windowDays: LANE_TUNING_WINDOW_DAYS, machines: machinesOut, changes };
  };

  const recordShadow = (r: LaneRecommendation): boolean => {
    if (!r.tuning.autoTune || !r.online || r.headroom === undefined) return false;
    const seen = lastRecorded();
    const was = seen.get(r.machineId);
    if (was && was.lanes === r.lanes && was.configured === r.configured) return false;
    c.store.events.append({
      type: 'lanes.recommended',
      data: {
        machineId: r.machineId, lanes: r.lanes, configured: r.configured, headroom: r.headroom,
        reason: r.reason, confidence: r.confidence, usage: r.usage, mode: 'shadow',
      },
    });
    seen.set(r.machineId, { lanes: r.lanes, configured: r.configured });
    return true;
  };

  const apply = (r: LaneRecommendation, at: string): boolean => {
    const change = laneChange(r, c.store.settings.getAppliedLanes()[r.machineId]);
    if (!change) return false;
    c.store.tx(() => {
      setApplied(r.machineId, { lanes: change.to, from: change.from, at, reason: r.reason });
      c.store.events.append({
        type: 'lanes.applied', machineId: r.machineId,
        data: { machineId: r.machineId, from: change.from, to: change.to, configured: r.configured, reason: r.reason, confidence: r.confidence },
      });
    });
    return true;
  };

  return {
    plan,
    async record() {
      if (c.stopping()) return 0;
      const p = await plan();
      if (c.stopping()) return 0;
      return p.machines.filter((r) => (r.tuning.mode === 'active' ? apply(r, p.at) : recordShadow(r))).length;
    },
    async set(machineId, patch, by) {
      if (!(await c.machines.list()).some((m) => m.id === machineId)) throw new EngineError('not_found', `no machine ${machineId}`);
      const from = tuningOf(c.store, machineId);
      const to: LaneTuning = {
        autoTune: patch.autoTune ?? from.autoTune, minLanes: patch.minLanes ?? from.minLanes, maxLanes: patch.maxLanes ?? from.maxLanes, mode: patch.mode ?? from.mode,
      };
      if (!(Number.isInteger(to.minLanes) && Number.isInteger(to.maxLanes) && to.minLanes >= 0 && to.maxLanes <= MAX_TUNED_LANES && to.minLanes <= to.maxLanes)) {
        throw new EngineError('invalid', `the bounds must be whole numbers from 0 to ${MAX_TUNED_LANES}, the least lanes at most the most lanes`);
      }
      if (from.autoTune !== to.autoTune || from.minLanes !== to.minLanes || from.maxLanes !== to.maxLanes || from.mode !== to.mode) {
        c.store.tx(() => {
          c.store.settings.setLaneTuning({ ...c.store.settings.getLaneTuning(), [machineId]: to });
          // Out of active mode, or auto-tune off: the configured lanes again, and active mode starts from them next time.
          if (to.mode !== 'active' || !to.autoTune) setApplied(machineId, undefined);
          c.store.events.append({ type: 'lanes.tuning_changed', machineId, data: { machineId, from, to, by } });
        });
      }
      return plan();
    },
    async undo(machineId, by) {
      if (!(await c.machines.list()).some((m) => m.id === machineId)) throw new EngineError('not_found', `no machine ${machineId}`);
      const a = c.store.settings.getAppliedLanes()[machineId];
      const tuning = tuningOf(c.store, machineId);
      if (!a || a.undone || tuning.mode !== 'active' || !tuning.autoTune) throw new EngineError('conflict', `no lane change to undo on ${machineId}`);
      c.store.tx(() => {
        setApplied(machineId, { lanes: a.from, from: a.lanes, at: c.clock.now().toISOString(), reason: `undone by ${by}`, undone: true });
        c.store.events.append({ type: 'lanes.undone', machineId, data: { machineId, from: a.lanes, to: a.from, by } });
      });
      return plan();
    },
  };
}
