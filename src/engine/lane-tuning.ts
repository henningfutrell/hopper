// Lane tuning (issue #688, design.md "Lane tuning"): every machine's lane recommendation from its lane load over the
// lane tuning window, the usage it burns now and the usage limits, what its memory holds (issue #2499), by the decider's rules (src/decider/lane-tuning.ts).
// A recommendation that changes is recorded as `lanes.recommended`. The hopper applies none by itself: an admin applies
// one — the machine's configured lanes set through `machineLanes`, the path an edit of the machine takes, and
// `lanes.applied` with its reason —, dismisses it until it moves (`lanes.dismissed`), or undoes the last one applied
// (`lanes.undone`). Each machine's settings — auto-tune and the bounds — are the user's, in the database. When the rules'
// recommendation changes, Jev is asked first (`lane-count`, issue #550): its applied pick is the machine's recommendation
// until the rules' recommendation or the configured lanes move.
import { laneEffect, machinePolicy } from '../decider/usage.ts';
import { jobCostGroups, jobCostKind, jobCostProfiles } from '../decider/job-costs.ts';
import { laneActions, laneProgress, recommendLanes } from '../decider/lane-tuning.ts';
import { withJevLanes } from '../decider/lane-calls.ts';
import { memoryLaneCaps } from '../decider/memory-floor.ts';
import { expectedCost } from '../decider/placement-cost.ts';
import type { UserStore } from '../domain/ports.ts';
import {
  DEFAULT_LANE_TUNING, type ExpectedCost, type JevLanes, type Job, type JobCostGroup, JOB_COST_WINDOW_DAYS, LANE_CHANGE_EVENTS, laneChangeOf, JOB_COSTS_LISTED, LANE_TUNING_WINDOW_DAYS, type JobCosts, MAX_TUNED_LANES, RESOURCE_PRESSURE, type LaneRecommendation, type LaneTuning, type LaneTuningPlan,
} from '../domain/types.ts';
import { policyOf, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';
import { askLaneCount, type LaneCallDeps } from './lane-calls.ts';

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
  /** The job cost profiles over the job cost window, and grouped: `GET /api/lanes/costs` and `hopper lanes costs`. */
  costs(): Promise<JobCosts>;
  /** A job's expected cost from the job cost groups as last read (by `costs` or `record`); undefined: none known. Synchronous, for each Decision. */
  expected(job: Job): ExpectedCost | undefined;
  /** Read the job cost groups again, then record `lanes.recommended` for each tuned machine with a known headroom whose recommended or configured lanes changed. How many events. */
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

export function createLaneTuning(c: EngineContext, calls: LaneCallDeps): LaneTuningService {
  // The job cost groups as last read: each Decision reads a job's expected cost from them, never the runs themselves.
  let groups: { repo: JobCostGroup[]; kind: JobCostGroup[] } = { repo: [], kind: [] };
  // The rules' recommendation last recorded per machine, and Jev's applied pick at it: read from the event log once, so
  // a restart neither records each machine again nor loses a pick.
  let last: Map<string, { rulesLanes: number; configured: number }> | undefined;
  const jev = new Map<string, JevLanes>();
  const lastRecorded = (): Map<string, { rulesLanes: number; configured: number }> => {
    if (last) return last;
    last = new Map();
    for (const e of c.store.events.recent(500, ['lanes.recommended'])) {
      const d = e.data as { machineId: string; lanes: number; configured: number; confidence: number; decidedBy?: 'jev'; rules?: { lanes: number } };
      if (last.has(d.machineId)) continue;
      const rulesLanes = d.rules?.lanes ?? d.lanes;
      last.set(d.machineId, { rulesLanes, configured: d.configured });
      if (d.decidedBy === 'jev') jev.set(d.machineId, { lanes: d.lanes, confidence: d.confidence, rulesLanes, configured: d.configured });
    }
    return last;
  };
  // One record at a time: a pick is asked once per change, whoever records.
  let recording: Promise<number> = Promise.resolve(0);
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
    lastRecorded();
    const changes = c.store.events.recent(CHANGES_READ, [...LANE_CHANGE_EVENTS]).map(laneChangeOf);
    const from = new Date(now.getTime() - LANE_TUNING_WINDOW_DAYS * DAY_MS);
    const loads = c.store.machineHistory.laneLoad({ from, to: now, pressure: RESOURCE_PRESSURE });
    const progress = laneProgress(c.store.machineHistory.jobRuns({ from, to: now }));
    const memory = memoryLaneCaps(machines);
    const machinesOut: LaneRecommendation[] = machines.map((m) => {
      const mem = memory.get(m.id);
      const rules = recommendLanes({
        machine: m, loads, progress, usedFrac: laneEffect(m, readings, policy, at).usedFrac, soft: machinePolicy(m, policy).softLimit, hard: machinePolicy(m, policy).hardLimit, tuning: tuningOf(c.store, m.id),
        ...(mem ? { memory: mem } : {}),
      });
      const r = withJevLanes(rules, jev.get(m.id));
      return { ...r, ...laneActions(r, dismissals[m.id], changes.find((x) => x.machineId === m.id)) };
    });
    return { at, windowDays: LANE_TUNING_WINDOW_DAYS, machines: machinesOut, changes: changes.slice(0, CHANGES_SHOWN) };
  };

  /** Record a machine whose rules' recommendation `r` changed, Jev asked first. Whether it recorded. */
  const recordOne = async (r: LaneRecommendation, history: () => Parameters<typeof askLaneCount>[3]): Promise<boolean> => {
    if (!r.tuning.autoTune || !r.online || r.headroom === undefined || r.decidedBy) return false;
    const seen = lastRecorded();
    const was = seen.get(r.machineId);
    if (was && was.rulesLanes === r.lanes && was.configured === r.configured) return false;
    const pick = await askLaneCount(c, calls, r, history());
    if (c.stopping()) return false;
    const out = withJevLanes(r, pick);
    if (pick) jev.set(r.machineId, pick);
    else jev.delete(r.machineId);
    c.store.events.append({
      type: 'lanes.recommended',
      data: {
        machineId: r.machineId, lanes: out.lanes, configured: r.configured, headroom: r.headroom, reason: out.reason, confidence: out.confidence, usage: r.usage,
        ...(out.decidedBy ? { decidedBy: out.decidedBy, rules: out.rules } : {}),
      },
    });
    seen.set(r.machineId, { rulesLanes: r.lanes, configured: r.configured });
    return true;
  };

  const record = async (): Promise<number> => {
    if (c.stopping()) return 0;
    await costs();
    const p = await plan();
    if (c.stopping()) return 0;
    // What Jev reads of the history, read once and only when a machine's recommendation changed.
    let read: Parameters<typeof askLaneCount>[3] | undefined;
    const history = (): Parameters<typeof askLaneCount>[3] => {
      if (read) return read;
      const now = c.clock.now();
      const from = new Date(now.getTime() - LANE_TUNING_WINDOW_DAYS * DAY_MS);
      const policy = policyOf(c);
      read = {
        loads: c.store.machineHistory.laneLoad({ from, to: now, pressure: RESOURCE_PRESSURE }),
        progress: laneProgress(c.store.machineHistory.jobRuns({ from, to: now })), soft: policy.softLimit, hard: policy.hardLimit,
      };
      return read;
    };
    let n = 0;
    for (const r of p.machines) if (await recordOne(r, history)) n += 1;
    return n;
  };

  /** The machine's recommendation now; 404 for a machine not listed. */
  const recommendationOf = async (machineId: string): Promise<LaneRecommendation> => {
    const r = (await plan()).machines.find((m) => m.machineId === machineId);
    if (!r) throw new EngineError('not_found', `no machine ${machineId}`);
    return r;
  };

  const costs = async (): Promise<JobCosts> => {
    const machines = await c.machines.list();
    const now = c.clock.now();
    const runs = c.store.machineHistory.jobRuns({ from: new Date(now.getTime() - JOB_COST_WINDOW_DAYS * DAY_MS), to: now });
    const profiles = jobCostProfiles(runs, (id) => {
      const job = c.store.jobs.get(id);
      return job && { ...(job.source?.repo ? { repo: job.source.repo } : {}), kind: jobCostKind(job.spec) };
    }, (id) => machines.find((m) => m.id === id)?.template?.name);
    const all = jobCostGroups(profiles);
    groups = { repo: all.repo, kind: all.kind };
    return { at: now.toISOString(), windowDays: JOB_COST_WINDOW_DAYS, jobs: profiles.slice(0, JOB_COSTS_LISTED), groups: all };
  };

  return {
    plan,
    costs,
    expected: (job) => expectedCost(job, groups),
    record() {
      recording = recording.catch(() => 0).then(record);
      return recording;
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
