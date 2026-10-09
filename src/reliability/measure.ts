// Lane reliability (issue #535): runs read from the event log — a claim on a lane, its start, and how it ended there —
// and each lane's figures over a window. Pure: the events and the time are given.
import type { DomainEvent, LaneId, LaneReliability, MachineId } from '../domain/types.ts';
import { isLaneFault } from './fault.ts';

/** How a run on a lane ended: finished, failed, paused on a question, or cancelled. */
export type RunOutcome = 'finished' | 'failed' | 'question' | 'cancelled';

export interface LaneRun {
  laneId: LaneId;
  machineId: MachineId;
  /** Absent when its claim is older than the events read. */
  claimedAt?: string;
  startedAt?: string;
  endedAt: string;
  outcome: RunOutcome;
  error?: string;
}

/** The event types a run is read from. */
export const RUN_EVENTS = ['job.claimed', 'job.started', 'job.finished', 'job.failed', 'job.cancelled', 'question.asked'] as const;

const ENDS: Partial<Record<DomainEvent['type'], RunOutcome>> = {
  'job.finished': 'finished', 'job.failed': 'failed', 'job.cancelled': 'cancelled', 'question.asked': 'question',
};

const machineOfLane = (laneId: string): MachineId => laneId.slice(0, laneId.lastIndexOf('/lane-'));

/** Runs in the order they ended, from events oldest first. An end with no lane (a job ended off its lane) is no run. */
export function runsFrom(events: readonly DomainEvent[]): LaneRun[] {
  const open = new Map<string, { laneId: LaneId; machineId: MachineId; claimedAt: string; startedAt?: string }>();
  const runs: LaneRun[] = [];
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!e.jobId) continue;
    if (e.type === 'job.claimed' && e.laneId) {
      open.set(e.jobId, { laneId: e.laneId, machineId: e.machineId ?? machineOfLane(e.laneId), claimedAt: e.at });
      continue;
    }
    if (e.type === 'job.started') {
      const c = open.get(e.jobId);
      if (c && c.startedAt === undefined) c.startedAt = e.at;
      continue;
    }
    const outcome = ENDS[e.type];
    if (!outcome || !e.laneId) continue;
    const c = open.get(e.jobId);
    open.delete(e.jobId);
    const claim = c?.laneId === e.laneId ? c : undefined;
    const error = outcome === 'failed' ? (e.data as { error?: string }).error : undefined;
    runs.push({
      laneId: e.laneId, machineId: claim?.machineId ?? machineOfLane(e.laneId),
      ...(claim ? { claimedAt: claim.claimedAt } : {}), ...(claim?.startedAt ? { startedAt: claim.startedAt } : {}),
      endedAt: e.at, outcome, ...(error !== undefined ? { error } : {}),
    });
  }
  return runs.sort((a, b) => a.endedAt.localeCompare(b.endedAt));
}

const DAY_MS = 86_400_000;

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Each lane's figures over the `windowDays` before `at`, lanes in id order. The score is the share of its runs
 * without a lane fault, each run weighing half as much per quarter of the window it is old: recent stability counts most.
 */
export function measure(runs: readonly LaneRun[], o: { at: string; windowDays: number }): LaneReliability[] {
  const now = Date.parse(o.at);
  const since = now - o.windowDays * DAY_MS;
  const halfLife = (o.windowDays * DAY_MS) / 4;
  const byLane = new Map<LaneId, LaneRun[]>();
  for (const r of runs) {
    const t = Date.parse(r.endedAt);
    if (t < since || t > now || r.outcome === 'cancelled') continue;
    byLane.set(r.laneId, [...(byLane.get(r.laneId) ?? []), r]);
  }
  return [...byLane.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([laneId, mine]) => {
    let weight = 0;
    let clean = 0;
    let finished = 0;
    let failed = 0;
    let laneFaults = 0;
    let recentFaults = 0;
    const starts: number[] = [];
    for (const r of mine) {
      const fault = r.outcome === 'failed' && isLaneFault(r.error ?? '');
      const w = 0.5 ** ((now - Date.parse(r.endedAt)) / halfLife);
      weight += w;
      if (!fault) clean += w;
      if (r.outcome === 'finished') finished += 1;
      if (r.outcome === 'failed') failed += 1;
      if (fault) laneFaults += 1;
      if (fault && now - Date.parse(r.endedAt) <= DAY_MS) recentFaults += 1;
      if (r.claimedAt && r.startedAt) starts.push(Date.parse(r.startedAt) - Date.parse(r.claimedAt));
    }
    const medianStartMs = median(starts);
    const last = mine.reduce((a, b) => (b.endedAt > a ? b.endedAt : a), mine[0]!.endedAt);
    return {
      laneId, machineId: mine[0]!.machineId, runs: mine.length, finished, failed, laneFaults, recentFaults,
      ...(finished + failed > 0 ? { successRate: finished / (finished + failed) } : {}),
      ...(medianStartMs !== undefined ? { medianStartMs } : {}),
      score: weight > 0 ? clean / weight : 0, lastRunAt: last,
    };
  });
}
