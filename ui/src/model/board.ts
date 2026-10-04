// Every job view's data, from the one job store: which group each status is in, the groups as
// lists, the overview's numbers counted off those lists, the lane board and the waiting order.
import type { Decision, Job, JobStatus, Lane, MachineView } from './wire.ts';

/** The one definition of each status's group (docs/glossary.md: Waiting, Waiting answer, Running, Ended). */
export const GROUP = {
  queued: 'waiting', held: 'waiting',
  waiting_answer: 'waitingAnswer',
  claimed: 'running', running: 'running',
  finished: 'ended', failed: 'ended', cancelled: 'ended',
} as const satisfies Record<JobStatus, string>;
export type JobGroup = (typeof GROUP)[JobStatus];

/** The jobs the store holds, by group. Every view lists these and every count is a length of one. */
export type JobBoard = Record<JobGroup, Job[]>;

const endOf = (j: Job) => j.finishedAt ?? j.updatedAt;

/** `waitingOrder`: the queue order of the waiting jobs as /api/queue gave it; a job it lacks follows, oldest first. */
export function jobBoard(jobs: Iterable<Job>, waitingOrder: readonly string[]): JobBoard {
  const board: JobBoard = { waiting: [], waitingAnswer: [], running: [], ended: [] };
  for (const j of jobs) board[GROUP[j.status]].push(j);
  const place = new Map(waitingOrder.map((id, i) => [id, i]));
  const at = (j: Job) => place.get(j.id) ?? Infinity;
  const oldest = (a: Job, b: Job) => a.createdAt.localeCompare(b.createdAt);
  board.waiting.sort((a, b) => at(a) - at(b) || oldest(a, b));
  board.waitingAnswer.sort(oldest);
  board.running.sort(oldest);
  board.ended.sort((a, b) => endOf(b).localeCompare(endOf(a)));
  return board;
}

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
  waitingAnswer: number;
  finished: number;
  failed: number;
  cancelled: number;
}

export function kpis(board: JobBoard, machines: MachineView[]): Kpis {
  const lanes = machines.flatMap((m) => m.lanes);
  const ended = (status: JobStatus) => board.ended.filter((j) => j.status === status).length;
  return {
    running: board.running.length,
    lanesBusy: lanes.filter((l) => l.state !== 'idle').length,
    lanesOpen: lanes.length,
    lanesMax: machines.reduce((s, m) => s + m.maxLanes, 0),
    waiting: board.waiting.length,
    held: board.waiting.filter((j) => j.status === 'held').length,
    waitingAnswer: board.waitingAnswer.length,
    finished: ended('finished'),
    failed: ended('failed'),
    cancelled: ended('cancelled'),
  };
}

export interface WaitingRow {
  job: Job;
  /** 1-based place in queue order. */
  position: number;
  effectivePriority: number | null;
}

export function waitingRows(board: JobBoard, latest: Pick<Decision, 'start'> | undefined): WaitingRow[] {
  const effective = new Map((latest?.start ?? []).map((s) => [s.jobId, s.effectivePriority]));
  return board.waiting.map((job, i) => ({ job, position: i + 1, effectivePriority: effective.get(job.id) ?? null }));
}
