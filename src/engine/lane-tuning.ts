// Lane tuning (issue #688, design.md "Lane tuning"): every machine's lane recommendation from its lane load over the
// lane tuning window, the usage it burns now and the usage limits, by the decider's rules (src/decider/lane-tuning.ts).
// Shadow only: a recommendation that changes is recorded as `lanes.recommended`, next to the configured lanes, and the
// decider keeps the configured lanes. Each machine's settings — auto-tune, the bounds — are the user's, in the database.
import { laneEffect } from '../decider/usage.ts';
import { recommendLanes } from '../decider/lane-tuning.ts';
import {
  DEFAULT_LANE_TUNING, LANE_TUNING_WINDOW_DAYS, MAX_TUNED_LANES, RESOURCE_PRESSURE, type LaneRecommendation, type LaneTuning, type LaneTuningPlan,
} from '../domain/types.ts';
import { policyOf, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

const DAY_MS = 86_400_000;

/** A change to one machine's lane tuning settings: a field left out keeps its value. */
export type LaneTuningPatch = Partial<LaneTuning>;

export interface LaneTuningService {
  /** Every machine's lane recommendation now: `GET /api/lanes/plan` and `hopper lanes plan`. */
  plan(): Promise<LaneTuningPlan>;
  /** Record `lanes.recommended` for each tuned machine with a known headroom whose recommended or configured lanes changed; how many. */
  record(): Promise<number>;
  /** Change one machine's settings; `by` names who. The plan after it. */
  set(machineId: string, patch: LaneTuningPatch, by: string): Promise<LaneTuningPlan>;
}

const tuningOf = (c: Pick<EngineContext, 'store'>, machineId: string): LaneTuning => c.store.settings.getLaneTuning()[machineId] ?? DEFAULT_LANE_TUNING;

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

  const plan = async (): Promise<LaneTuningPlan> => {
    const [machines, readings] = await Promise.all([c.machines.list(), Promise.all(c.usage().map((u) => u.poll())).then((r) => r.flat())]);
    const now = c.clock.now();
    const at = now.toISOString();
    const policy = policyOf(c);
    const loads = c.store.machineHistory.laneLoad({ from: new Date(now.getTime() - LANE_TUNING_WINDOW_DAYS * DAY_MS), to: now, pressure: RESOURCE_PRESSURE });
    const machinesOut: LaneRecommendation[] = machines.map((m) => recommendLanes({
      machine: m, loads, usedFrac: laneEffect(m, readings, policy, at).usedFrac, soft: policy.softLimit, hard: policy.hardLimit, tuning: tuningOf(c, m.id),
    }));
    return { at, mode: 'shadow', windowDays: LANE_TUNING_WINDOW_DAYS, machines: machinesOut };
  };

  return {
    plan,
    async record() {
      if (c.stopping()) return 0;
      const p = await plan();
      if (c.stopping()) return 0;
      const seen = lastRecorded();
      let added = 0;
      for (const r of p.machines) {
        if (!r.tuning.autoTune || !r.online || r.headroom === undefined) continue;
        const was = seen.get(r.machineId);
        if (was && was.lanes === r.lanes && was.configured === r.configured) continue;
        c.store.events.append({
          type: 'lanes.recommended',
          data: {
            machineId: r.machineId, lanes: r.lanes, configured: r.configured, ...(r.headroom !== undefined ? { headroom: r.headroom } : {}),
            reason: r.reason, confidence: r.confidence, usage: r.usage, mode: p.mode,
          },
        });
        seen.set(r.machineId, { lanes: r.lanes, configured: r.configured });
        added += 1;
      }
      return added;
    },
    async set(machineId, patch, by) {
      if (!(await c.machines.list()).some((m) => m.id === machineId)) throw new EngineError('not_found', `no machine ${machineId}`);
      const from = tuningOf(c, machineId);
      const to: LaneTuning = { autoTune: patch.autoTune ?? from.autoTune, minLanes: patch.minLanes ?? from.minLanes, maxLanes: patch.maxLanes ?? from.maxLanes };
      if (!(Number.isInteger(to.minLanes) && Number.isInteger(to.maxLanes) && to.minLanes >= 0 && to.maxLanes <= MAX_TUNED_LANES && to.minLanes <= to.maxLanes)) {
        throw new EngineError('invalid', `the bounds must be whole numbers from 0 to ${MAX_TUNED_LANES}, the least lanes at most the most lanes`);
      }
      if (from.autoTune !== to.autoTune || from.minLanes !== to.minLanes || from.maxLanes !== to.maxLanes) {
        c.store.tx(() => {
          c.store.settings.setLaneTuning({ ...c.store.settings.getLaneTuning(), [machineId]: to });
          c.store.events.append({ type: 'lanes.tuning_changed', data: { machineId, from, to, by } });
        });
      }
      return plan();
    },
  };
}
