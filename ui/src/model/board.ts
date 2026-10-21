// Every job view's data, from the one job store: which group each status is in, the groups as
// lists, the dashboard's numbers counted off those lists, the lane board, the waiting order, and how a lane,
// a machine or an event's subject is named.
import { highFirst, isHighJob } from './priority.ts';
import { raisedByOf, raisedName } from './questions.ts';
import { jobHref } from './job.ts';
import { planHref } from './infra-plans.ts';
import type { Decision, DomainEvent, Job, JobStatus, Lane, MachineLaneEffect, MachineView, WaitCheck, WaitOn, WorkItemState } from './wire.ts';

/** The one definition of each status's group (docs/glossary.md: Waiting, Waiting answer, Operator-led, Parked, Waiting on, Running, Ended). */
export const GROUP = {
  queued: 'waiting', held: 'waiting',
  waiting_answer: 'waitingAnswer',
  operator_led: 'operatorLed',
  parked: 'parked',
  waiting_on: 'waitingOn',
  claimed: 'running', running: 'running',
  finished: 'ended', failed: 'ended', cancelled: 'ended', rejected: 'ended',
} as const satisfies Record<JobStatus, string>;
export type JobGroup = (typeof GROUP)[JobStatus];

/** The jobs the store holds, by group. Every view lists these and every count is a length of one. */
export type JobBoard = Record<JobGroup, Job[]>;

const endOf = (j: Job) => j.finishedAt ?? j.updatedAt;

/**
 * A job on a wait for its own background command (issue #1037): `command` while it runs — running work, not a wait on the
 * outside world —, `stuck` once the hopper flagged it stuck. Undefined for any other job. As the daemon's `ownWaitOf`.
 */
export function ownWaitOf(job: Job): 'command' | 'stuck' | undefined {
  if (job.status !== 'waiting_on' || !job.wait?.ownCommand) return undefined;
  return job.wait.stuckAt ? 'stuck' : 'command';
}

/** A time as `2026-10-17 12:00 UTC`. */
const utc = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/** A wait check (issue #1694) in words: what the hopper checks, when next, what the last check found, and whether it is overdue. */
export function waitCheckText(check: WaitCheck, nowMs: number): { what: string; next: string; last?: string; overdue?: true } {
  const c = check.condition;
  const ref = (r: { kind: 'issue'; repo: string; number: number } | { kind: 'run'; repo: string; runId: number }) => (r.kind === 'issue' ? `${r.repo}#${r.number}` : `${r.repo} run ${r.runId}`);
  const what = c.kind === 'items_ended' ? `the hopper checks whether ${c.refs.map(ref).join(', ')} ended`
    : c.kind === 'job_ended' ? `the hopper checks whether job ${c.jobId} ended`
    : c.kind === 'question_settled' ? `the hopper checks whether question ${c.questionId} is settled`
    : c.kind === 'command_exited' ? 'the hopper checks whether its own command ended'
    : c.kind === 'pr_checks_ended' ? `the hopper checks whether the checks of ${c.repo}#${c.number} ended`
    : c.kind === 'pr_review_ended' ? `the hopper checks whether ${c.repo}#${c.number} got a review`
    : c.kind === 'time_passed' ? `the hopper wakes it at ${utc(c.at)}`
    : c.kind === 'recheck' ? `the hopper cannot see it: it wakes the job at ${utc(c.at)} to look again`
    : 'the hopper has no check for it: only its deadline counts';
  const mins = Math.round((Date.parse(check.nextCheckAt) - nowMs) / 60_000);
  const next = mins <= 0 ? 'next check now' : mins < 60 ? `next check in ${mins} min` : `next check in ${Math.round(mins / 60)} h`;
  return { what: check.wakeAt ? `${what}, and wakes it at ${utc(check.wakeAt)}` : what, next, ...(check.result ? { last: check.result } : {}), ...(check.overdueAt ? { overdue: true as const } : {}) };
}

const PR_ABOUT = { merge: 'to merge', checks: 'checks to end', review: 'review' } as const;
/** Why a person acts on an outside event (issue #1510), as the daemon's `waitOnLabel` says it. */
const OUTSIDE_WHY = { not_managed: 'not managed', gated: 'gated' } as const;

/** What a job's own wait waits on, in a few words, as the daemon's `waitOnLabel` (issue #1245); and where it is, if it is a page. */
export function waitOnLink(job: Job): { label: string; href?: string } | undefined {
  if (job.status !== 'waiting_on' || !job.wait) return undefined;
  return waitOnLinkOf(job.wait.on, job.source?.repo);
}

/** A wait's dependency as words and a link, for the job, the Queue view and the job graph alike; `repo`: the job's own repository. */
export function waitOnLinkOf(on: WaitOn | undefined, ownRepo: string | undefined): { label: string; href?: string } {
  if (!on) return { label: 'nothing recorded' };
  const repo = 'repo' in on ? on.repo ?? ownRepo : ownRepo;
  const gh = (kind: 'pull' | 'issues', n: number) => (repo ? `https://github.com/${repo}/${kind}/${n}` : undefined);
  const with_ = (label: string, href: string | undefined) => (href ? { label, href } : { label });
  switch (on.kind) {
    case 'pull_request': return with_(`${on.repo ? `${on.repo}#` : 'PR #'}${on.number} ${PR_ABOUT[on.about]}`, gh('pull', on.number));
    case 'item': return with_(`${on.repo ? `${on.repo}#` : 'issue #'}${on.number}`, gh('issues', on.number));
    case 'job': return { label: `job ${on.jobId}`, href: jobHref(on.jobId) };
    case 'question': return { label: `a person's answer to question ${on.questionId}`, href: `#question-${encodeURIComponent(on.questionId)}` };
    case 'approval': return { label: `${on.of} approval` };
    case 'grant': return { label: 'a vault grant' };
    // Issue #2205: the plan on Infra, picked, with its Approve.
    case 'plan': return { label: `approval of infra plan ${on.planId.slice(0, 8)}`, href: planHref(on.planId) };
    case 'own_command': return { label: 'its own command' };
    case 'outside': return { label: `outside (${on.why ? OUTSIDE_WHY[on.why] : 'reason not given'}): ${on.what}` };
  }
}

/** `waitingOrder`: the queue order of the waiting jobs as /api/queue gave it; a job it lacks follows, oldest first. */
export function jobBoard(jobs: Iterable<Job>, waitingOrder: readonly string[]): JobBoard {
  const board: JobBoard = { waiting: [], waitingAnswer: [], operatorLed: [], parked: [], waitingOn: [], running: [], ended: [] };
  for (const j of jobs) board[GROUP[j.status]].push(j);
  const place = new Map(waitingOrder.map((id, i) => [id, i]));
  const at = (j: Job) => place.get(j.id) ?? Infinity;
  const oldest = (a: Job, b: Job) => a.createdAt.localeCompare(b.createdAt);
  board.waiting.sort((a, b) => at(a) - at(b) || oldest(a, b));
  board.waitingAnswer.sort(oldest);
  board.operatorLed.sort(oldest);
  board.parked.sort(oldest);
  board.waitingOn.sort(oldest);
  board.running.sort(oldest);
  board.ended.sort((a, b) => endOf(b).localeCompare(endOf(a)));
  return board;
}

/**
 * Whether Run again is offered for a job — one the daemon takes (issues #313, #354, #362, #387, #1352): it failed,
 * finished, was rejected or was cancelled, has a source, its end is reported to the source, and no newer job of its item exists. A
 * closed issue does not stop it: Run again reopens it. The daemon decides.
 */
export function canRerun(job: Job, jobs: Iterable<Job>): boolean {
  const key = job.source?.key;
  if (!['failed', 'finished', 'rejected', 'cancelled'].includes(job.status) || key === undefined || job.sourceState?.sync?.finalReported !== true) return false;
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

/** A parked job that may resume elsewhere (issue #921): its last checkpoint holds its agent session. */
export const canResumeElsewhere = (job: Job): boolean => job.status === 'parked' && job.agentSession !== undefined && job.checkpoint?.session === true;

/** The Parked section's order (issue #565): high-priority jobs first, then the longest parked on top. */
export const parkedOrder = (jobs: readonly Job[], threshold: number | null): Job[] =>
  highFirst([...jobs].sort((a, b) => (a.parked?.at ?? a.updatedAt).localeCompare(b.parked?.at ?? b.updatedAt)), (j) => isHighJob(j, threshold));

/** Whether Pick up is offered (issues #501, #565): a parked job. */
export const canPickUp = (job: Job): boolean => job.status === 'parked';

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
  /** A specialty or tend job's lane past the machine's lanes (issues #762, #967): it elbowed in, and closes when its job ends. */
  elbowIn?: true;
  /** A lane a reattach opened past the machine's lanes (issue #1181): its job came back from its pane with no lane idle. */
  pastCap?: true;
}

const inUse = (m: Pick<MachineView, 'lanes'>): number => m.lanes.filter((l) => l.state !== 'idle').length;

/** The machines with more lanes in use than their lanes (issue #762): specialty or tend jobs elbowed in, e.g. 7 of 6. */
export function overCap(machines: readonly MachineView[]): { machineId: string; inUse: number; lanes: number }[] {
  return machines.filter((m) => inUse(m) > m.maxLanes).map((m) => ({ machineId: m.id, inUse: inUse(m), lanes: m.maxLanes }));
}

/**
 * `jobs`: every job the store holds. A job that waits (on a question or on its own wait) while its lane still names it
 * shows on that lane too (issue #432), never an empty busy lane. An ended or parked job a stale lane names does not.
 */
export function laneRows(machines: MachineView[], running: Job[], jobs: ReadonlyMap<string, Job> = new Map()): LaneRow[] {
  const waits = [...jobs.values()].filter((j) => GROUP[j.status] === 'waitingAnswer' || GROUP[j.status] === 'waitingOn');
  const byId = new Map([...waits, ...running].map((j) => [j.id, j]));
  const byLane = new Map(running.filter((j) => j.laneId).map((j) => [j.laneId, j]));
  const placed = new Set<string>();
  const rows: LaneRow[] = [];
  for (const m of machines) {
    const machine = { id: m.id, label: m.label || m.id };
    const over = inUse(m) > m.maxLanes;
    for (const lane of m.lanes) {
      const job = (lane.jobId && byId.get(lane.jobId)) || byLane.get(lane.id);
      if (job) placed.add(job.id);
      const elbowIn = over && (job?.spec.specialty === true || job?.spec.tend === true) && lane.state !== 'idle';
      const pastCap = over && !elbowIn && lane.pastCap === true && lane.state !== 'idle';
      rows.push({
        key: lane.id, machine, lane, job, ...(job?.workTree ? { workTree: job.workTree } : {}), state: lane.state,
        ...(elbowIn ? { elbowIn: true as const } : {}), ...(pastCap ? { pastCap: true as const } : {}),
      });
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

/** What a lane with a job does now (issue #432): its job starts (claimed), runs, or waits while it holds the lane. */
export type LaneJobState = 'starting' | 'busy' | 'waiting';

export function laneJobState(job: Job): LaneJobState {
  if (job.status === 'claimed') return 'starting';
  return job.status === 'running' ? 'busy' : 'waiting';
}

export interface Kpis {
  /** Lanes holding a job: busy and draining (issue #1181). */
  lanesBusy: number;
  lanesOpen: number;
  /** The machines' effective lane caps (issue #1181): the decider's, usage pacing included. */
  lanesMax: number;
  /** Lanes holding a job past their machine's effective cap, summed over the machines (issue #1181). */
  lanesOver: number;
  waiting: number;
  held: number;
  waitingAnswer: number;
  parked: number;
  /** On their own wait (issue #483) for a person or the outside world: not on their own command. */
  waitingOn: number;
  finished: number;
  /** Work items failed now, as the work-item ledger counts them (issue #1067): no count of job statuses. */
  failed: number;
}

/**
 * A machine's effective lane cap (issue #1181): the decider's lane cap from the usage report, usage pacing included. With
 * no reading of it, or offline (its cap 0 then, while its lanes still run), its lanes.
 */
export function effectiveCap(m: Pick<MachineView, 'id' | 'maxLanes'>, effects: readonly MachineLaneEffect[] | null): number {
  const e = effects?.find((x) => x.machineId === m.id);
  return e && e.band !== 'offline' ? e.cap : m.maxLanes;
}

/** `items`: the work-item ledger's counts (issue #1067), null until read. `effects`: the usage report's machines, null until read. */
export function kpis(board: JobBoard, machines: MachineView[], items: Record<WorkItemState, number> | null, effects: readonly MachineLaneEffect[] | null = null): Kpis {
  const lanes = machines.flatMap((m) => m.lanes);
  const ended = (status: JobStatus) => board.ended.filter((j) => j.status === status).length;
  return {
    lanesBusy: lanes.filter((l) => l.state !== 'idle').length,
    lanesOpen: lanes.length,
    lanesMax: machines.reduce((s, m) => s + effectiveCap(m, effects), 0),
    lanesOver: machines.reduce((s, m) => s + Math.max(0, inUse(m) - effectiveCap(m, effects)), 0),
    waiting: board.waiting.length,
    held: board.waiting.filter((j) => j.status === 'held').length,
    waitingAnswer: board.waitingAnswer.length,
    parked: board.parked.length,
    waitingOn: board.waitingOn.filter((j) => ownWaitOf(j) !== 'command').length,
    finished: ended('finished'),
    failed: items?.failed ?? 0,
  };
}

/**
 * The Lanes card's line under its number (issue #1181): the lanes open, then the room under the cap still unopened, or
 * what is past the cap — lanes holding a job, and idle lanes not closed yet. Never a 0 that hides lanes past the cap.
 */
export function lanesSub(k: Pick<Kpis, 'lanesOpen' | 'lanesMax' | 'lanesOver'>): string {
  const parts = [`${k.lanesOpen} open`];
  if (k.lanesOpen <= k.lanesMax) parts.push(`${k.lanesMax - k.lanesOpen} unopened`);
  else if (k.lanesOpen - k.lanesMax > k.lanesOver) parts.push(`${k.lanesOpen - k.lanesMax - k.lanesOver} idle past the cap`);
  if (k.lanesOver > 0) parts.push(`${k.lanesOver} over the cap`);
  return parts.join(' · ');
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
