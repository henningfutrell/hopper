// The overview's numbers, the lane board and the waiting order, from /api/queue,
// /api/machines and the latest Decision.
import type { Decision, Job, Lane, MachineView, Queue } from './wire.ts';

export interface LaneRow {
  key: string;
  machine: { id: string; label: string };
  lane?: Lane;
  job?: Job;
  /** `unopened`: capacity under maxLanes with no lane open. */
  state: Lane['state'] | 'unopened';
}

export function laneRows(machines: MachineView[], running: Job[]): LaneRow[] {
  const byId = new Map(running.map((j) => [j.id, j]));
  const byLane = new Map(running.filter((j) => j.laneId).map((j) => [j.laneId, j]));
  const placed = new Set<string>();
  const rows: LaneRow[] = [];
  for (const m of machines) {
    const machine = { id: m.id, label: m.label || m.id };
    for (const lane of m.lanes) {
      const job = (lane.jobId && byId.get(lane.jobId)) || byLane.get(lane.id);
      if (job) placed.add(job.id);
      rows.push({ key: lane.id, machine, lane, job, state: lane.state });
    }
    for (let i = m.lanes.length; i < m.maxLanes; i += 1) rows.push({ key: `${m.id}/unopened-${i}`, machine, state: 'unopened' });
  }
  // A running job whose lane /api/machines does not list yet still shows; it never vanishes.
  for (const job of running) {
    if (placed.has(job.id)) continue;
    const machineId = job.laneId?.split('/')[0] ?? '?';
    rows.push({ key: `orphan-${job.id}`, machine: { id: machineId, label: machineId }, job, state: 'busy' });
  }
  return rows;
}

export interface Kpis {
  running: number;
  lanesBusy: number;
  lanesOpen: number;
  lanesMax: number;
  waiting: number;
  held: number;
  onQuestion: number;
  finished: number;
  failed: number;
  cancelled: number;
}

export function kpis(queue: Queue, machines: MachineView[]): Kpis {
  const c = queue.counts;
  const n = (k: keyof Queue['counts']) => c[k] ?? 0;
  const lanes = machines.flatMap((m) => m.lanes);
  return {
    running: n('running') + n('claimed'),
    lanesBusy: lanes.filter((l) => l.state !== 'idle').length,
    lanesOpen: lanes.length,
    lanesMax: machines.reduce((s, m) => s + m.maxLanes, 0),
    waiting: n('queued') + n('held'),
    held: n('held'),
    onQuestion: n('waiting_answer'),
    finished: n('finished'),
    failed: n('failed'),
    cancelled: n('cancelled'),
  };
}

export interface WaitingRow {
  job: Job;
  kind: 'question' | 'waiting';
  /** 1-based place in decider order; null for jobs on a question. */
  position: number | null;
  effectivePriority: number | null;
}

export function waitingRows(queue: Queue, latest: Pick<Decision, 'start'> | undefined): WaitingRow[] {
  const effective = new Map((latest?.start ?? []).map((s) => [s.jobId, s.effectivePriority]));
  return [
    ...queue.waitingAnswer.map((job): WaitingRow => ({ job, kind: 'question', position: null, effectivePriority: null })),
    ...queue.waiting.map((job, i): WaitingRow => ({ job, kind: 'waiting', position: i + 1, effectivePriority: effective.get(job.id) ?? null })),
  ];
}
