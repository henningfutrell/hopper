// Every job view's data, from the one job store: which group each status is in, the groups as
// lists, the overview's numbers counted off those lists, the lane board, the waiting order, and how a lane,
// a machine or an event's subject is named.
import { highFirst, isHighJob } from './priority.ts';
import { raisedByOf, raisedName } from './questions.ts';
import type { Decision, DomainEvent, Job, JobStatus, Lane, MachineView } from './wire.ts';

/** The one definition of each status's group (docs/glossary.md: Waiting, Waiting answer, Operator-led, Parked, Running, Ended). */
export const GROUP = {
  queued: 'waiting', held: 'waiting',
  waiting_answer: 'waitingAnswer',
  operator_led: 'operatorLed',
  parked: 'parked',
  claimed: 'running', running: 'running',
  finished: 'ended', failed: 'ended', cancelled: 'ended', rejected: 'ended',
} as const satisfies Record<JobStatus, string>;
export type JobGroup = (typeof GROUP)[JobStatus];

/** The jobs the store holds, by group. Every view lists these and every count is a length of one. */
export type JobBoard = Record<JobGroup, Job[]>;

const endOf = (j: Job) => j.finishedAt ?? j.updatedAt;

/** `waitingOrder`: the queue order of the waiting jobs as /api/queue gave it; a job it lacks follows, oldest first. */
export function jobBoard(jobs: Iterable<Job>, waitingOrder: readonly string[]): JobBoard {
  const board: JobBoard = { waiting: [], waitingAnswer: [], operatorLed: [], parked: [], running: [], ended: [] };
  for (const j of jobs) board[GROUP[j.status]].push(j);
  const place = new Map(waitingOrder.map((id, i) => [id, i]));
  const at = (j: Job) => place.get(j.id) ?? Infinity;
  const oldest = (a: Job, b: Job) => a.createdAt.localeCompare(b.createdAt);
  board.waiting.sort((a, b) => at(a) - at(b) || oldest(a, b));
  board.waitingAnswer.sort(oldest);
  board.operatorLed.sort(oldest);
  board.parked.sort(oldest);
  board.running.sort(oldest);
  board.ended.sort((a, b) => endOf(b).localeCompare(endOf(a)));
  return board;
}

/**
 * Whether Run again is offered for a job — one the daemon takes (issues #313, #354, #362, #387): it failed,
 * finished or was rejected, has a source, its end is reported to the source, and no newer job of its item exists. A
 * closed issue does not stop it: Run again reopens it. The daemon decides.
 */
export function canRerun(job: Job, jobs: Iterable<Job>): boolean {
  const key = job.source?.key;
  if (!['failed', 'finished', 'rejected'].includes(job.status) || key === undefined || job.sourceState?.sync?.finalReported !== true) return false;
  for (const j of jobs) if (j.id !== job.id && j.source?.key === key && j.createdAt > job.createdAt) return false;
  return true;
}

/**
 * Why Park does not apply to a job, as the daemon refuses it (issues #501, #530), or undefined: a running job or one on
 * a question, its executor one of `parkingExecutors` (GET /api/health). An agent session is not needed. The daemon decides.
 */
export function parkRefusal(job: Job, parkingExecutors: readonly string[]): string | undefined {
  if (job.status !== 'running' && job.status !== 'waiting_answer') return `it is ${job.status}: only a running job or one on a question can be parked`;
  if (!parkingExecutors.includes(job.spec.executor)) return `its executor ${job.spec.executor} cannot park a job`;
  return undefined;
}

/** Whether Park is offered (issues #501, #530): where the daemon takes it. */
export const canPark = (job: Job, parkingExecutors: readonly string[]): boolean => parkRefusal(job, parkingExecutors) === undefined;

/** A parked job with no agent session to resume (issue #530): picked up, it starts a fresh one, and asks first. */
export const startsFresh = (job: Job): boolean => job.status === 'parked' && job.agentSession === undefined;

/** The Parked section's order (issue #565): high-priority jobs first, then the longest parked on top. */
export const parkedOrder = (jobs: readonly Job[], threshold: number | null): Job[] =>
  highFirst([...jobs].sort((a, b) => (a.parked?.at ?? a.updatedAt).localeCompare(b.parked?.at ?? b.updatedAt)), (j) => isHighJob(j, threshold));

/** Whether Pick up is offered (issues #501, #565): a parked job. */
export const canPickUp = (job: Job): boolean => job.status === 'parked';

/** What Run again made, as its toast says it (issue #354): the new job queued — waiting for acceptance, or held and why — or failed at once. */
export function rerunOutcome(job: Job): { ok: boolean; message: string } {
  if (job.status === 'failed') return { ok: false, message: `Run again: the new job failed at once: ${job.error ?? 'no reason given'}` };
  if (job.accepted === false) return { ok: true, message: 'Queued again: waiting for acceptance in Queue' };
  if (job.holdReason) return { ok: true, message: `Queued again, held: ${job.holdReason}` };
  return { ok: true, message: 'Queued again' };
}

/** A machine as people read it: its label, and its id too where they differ, since two machines can share a label (issue #166). */
export function machineName(id: string, machines: readonly Pick<MachineView, 'id' | 'label'>[]): string {
  const label = machines.find((m) => m.id === id)?.label;
  return label && label !== id ? `${label} (${id})` : id;
}

/** A lane as people read it: its machine, then its number — `lane-1` alone is on every machine (issue #166). */
export function laneName(laneId: string, machines: readonly Pick<MachineView, 'id' | 'label'>[]): string {
  const cut = laneId.lastIndexOf('/');
  return `${machineName(laneId.slice(0, cut), machines)} · ${laneId.slice(cut + 1)}`;
}

/** Where a Decision starts a job, as people read it: its lane by `laneName`, or its machine and a new lane (issue #166). */
export function startTarget(s: { machineId: string; laneId?: string | null }, machines: readonly Pick<MachineView, 'id' | 'label'>[]): string {
  return s.laneId ? laneName(s.laneId, machines) : `${machineName(s.machineId, machines)} · new lane`;
}

/** An event's subject as people read it: its job's name, else its lane or machine named by `laneName`/`machineName` (issue #166). */
export function subjectOf(e: DomainEvent, nameOf: (jobId: string) => string, machines: readonly Pick<MachineView, 'id' | 'label'>[]): string {
  // A question event names the machine that raised it (issue #485), as it was then.
  if (e.type.startsWith('question.')) return `${e.jobId ? `${nameOf(e.jobId)} · ` : ''}on ${raisedName(raisedByOf(e))}`;
  if (e.jobId) return nameOf(e.jobId);
  if (e.laneId) return laneName(e.laneId, machines);
  if (e.machineId) return machineName(e.machineId, machines);
  return e.decisionId?.slice(0, 8) ?? '';
}

export interface LaneRow {
  key: string;
  machine: { id: string; label: string };
  lane?: Lane;
  job?: Job;
  /** The work tree of the job it runs (issue #166). */
  workTree?: string;
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
      rows.push({ key: lane.id, machine, lane, job, ...(job?.workTree ? { workTree: job.workTree } : {}), state: lane.state });
    }
    for (let i = m.lanes.length; i < m.maxLanes; i += 1) rows.push({ key: `${m.id}/unopened-${i}`, machine, state: 'unopened' });
  }
  // A running job whose lane /api/machines does not list yet still shows; it never vanishes.
  for (const job of running) {
    if (placed.has(job.id)) continue;
    const machineId = job.laneId?.split('/')[0] ?? '?';
    rows.push({ key: `orphan-${job.id}`, machine: { id: machineId, label: machineId }, job, ...(job.workTree ? { workTree: job.workTree } : {}), state: 'busy' });
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
  parked: number;
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
    parked: board.parked.length,
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
