// The job run as the saga kind `job-run` (issue #1662, design.md "Several hoppers on one database"), keyed by the job and
// its attempt: claim, credentials, pane, run, checkpoint, end. Each step is recorded before the next starts, and what a
// later step needs — the job's way to the hopper as placed on its machine, the executor's session state, the run's
// outcome — is in the saga's data, never only on the host that ran an earlier step. The saga's lease is the hopper's hold
// on the running job: a hopper that stops renews nothing, and once the lease ends another hopper's saga pass goes on from
// the last committed step. A run step tried again watches the pane its first try left (reattach), so the task is sent
// once. Without the saga (no coordinator), the runner drives the same steps itself, in memory.
import type { ExecutionContext, ExecutionOutcome, Executor } from '../domain/ports.ts';
import type { TaskCount } from '../domain/task-count.ts';
import type { Job, LaneId, MachineSnapshot } from '../domain/types.ts';
import { readJobRules, withAsks } from '../job-rules/index.ts';
import { repoJobRulesFor, withRepoJobRules } from '../job-rules/repo-rules.ts';
import { maskGitHubTokens, maskSecret } from '../secrets/mask.ts';
import type { Cleanup } from './cleanup.ts';
import { nowIso, type EngineContext } from './context.ts';
import { agentSignIn, placeCredentials } from './credentials.ts';
import { moveLost, type Lost } from './lost-move.ts';
import { nudgeCheck } from './nudge-check.ts';
import { runNotes } from './notes.ts';
import { recordOutcome } from './outcome.ts';
import { recordPark, releaseParked } from './park.ts';
import { requeuePreempted } from './preemption.ts';
import { requeue } from './recovery.ts';

/** The saga kind of a job's run. */
export const JOB_RUN_SAGA = 'job-run';
/** Its steps, in order. */
export const JOB_RUN_STEPS = ['claim', 'credentials', 'pane', 'run', 'checkpoint', 'end'] as const;
export type JobRunStep = typeof JOB_RUN_STEPS[number];

/** One `job-run` saga per job and attempt: a claim is a new attempt. */
export const jobRunKey = (job: Pick<Job, 'id' | 'attempts'>): string => `${job.id}/${job.attempts}`;

/** How a launch begins: a fresh run (or resume), a reattach, or a reattach once the machine answers. */
export type Launch = 'run' | 'reattach' | 'reattach-when-reachable';

/** Why a run is taken up again: this hopper started, or the hopper that drove it stopped. */
export type TakenUp = 'daemon restart' | 'its hopper stopped';

/** What the saga keeps: its begin's input, then each step's output. No secret: the proxy token is a file on the machine. */
export interface JobRunData {
  jobId: string;
  attempt: number;
  laneId: LaneId;
  launch: Launch;
  /** The claim found the job no longer claimed on its lane at this attempt (cancelled meanwhile): every step is skipped. */
  gone?: true;
  /** The job's way to the hopper as placed on its machine: its scratch dir, and the HOPPER_* and git variables. */
  credentials?: { scratch: string; env: Record<string, string> };
  /** The executor's session state once its pane opened: its pane, the task unsent, and the agent session. */
  session?: { executorState?: Record<string, unknown>; agentSession?: string };
  /** The run's outcome, masked: its end records it. */
  outcome?: ExecutionOutcome;
  /** Its machine lost as the run ended (issue #1569): it may resume rather than fail. */
  lost?: Lost;
  /** Why its machine was lost, when not the outcome's error: what its move records. */
  lostWhy?: string;
  /** A person's cancel (with their reason and note) ended the run. */
  cancel?: { reason: string; note?: string };
  /** A park ended the run (issue #501): its checkpoint step parks it. */
  park?: true;
  /** Taken up again with an executor that is safe to run again from scratch: queued again, as at a restart. */
  requeue?: TakenUp;
}

interface Progress { message?: string | undefined; tasks?: TaskCount | undefined }
const PROGRESS_EVERY_MS = 500;

/** What a run keeps in memory on the hopper that drives it now. */
export interface RunEntry {
  controller: AbortController;
  /** Set by cancel(): the reason recorded on job.cancelled, and a person's own words why (issue #1460). */
  cancelReason?: string;
  cancelNote?: string;
  /** Set by park() (issue #501): the job is parked once its executor has stepped aside, unless it finished meanwhile. */
  parking?: boolean;
  /** Another hopper holds the run now, or this one stops: no step writes its outcome. */
  dropped?: boolean;
  /** The agent's sign-ins given to this run: never in its outcome, as a tool's error may repeat its variables. */
  given: Set<string>;
  /** The credentials the `credentials` step placed: the pane's first start takes them, so they are placed once. */
  placed?: { scratch: string; make: boolean; machine: string; env: Record<string, string> };
  progress?: { report(message?: string, tasks?: TaskCount): void; flush(): void };
}

/** A report leaves out what it does not change (issue #794): a message alone keeps the job's task count. */
function progressReporter(c: EngineContext, jobId: string, laneId: LaneId): NonNullable<RunEntry['progress']> {
  let lastAt = -Infinity;
  let pending: Progress | undefined;
  const emit = (p: Progress): void => {
    lastAt = c.clock.now().getTime();
    pending = undefined;
    const message = p.message !== undefined ? maskGitHubTokens(p.message) : undefined;
    const data = { ...(message !== undefined ? { message } : {}), ...(p.tasks ? { tasks: p.tasks } : {}) };
    c.store.tx(() => {
      c.store.jobs.update(jobId, { ...(message !== undefined ? { progressMessage: message } : {}), ...(p.tasks ? { tasks: p.tasks } : {}) });
      c.store.events.append({ type: 'job.progressed', jobId, laneId, data });
    });
  };
  return {
    report(message, tasks) {
      if (c.stopping() || (message === undefined && !tasks)) return;
      const p = { message: message ?? pending?.message, tasks: tasks ?? pending?.tasks };
      if (c.clock.now().getTime() - lastAt >= PROGRESS_EVERY_MS) emit(p);
      else pending = p;
    },
    flush() { if (pending && !c.stopping()) emit(pending); },
  };
}

export const progressOf = (c: EngineContext, e: RunEntry, d: JobRunData): NonNullable<RunEntry['progress']> => (e.progress ??= progressReporter(c, d.jobId, d.laneId));

/** The machine snapshot of the lane's machine; undefined once it is no longer attached. */
export async function machineOf(c: EngineContext, laneId: LaneId): Promise<MachineSnapshot | undefined> {
  const lane = c.store.lanes.list().find((l) => l.id === laneId);
  return lane ? (await c.machines.list()).find((m) => m.id === lane.machineId) : undefined;
}

/** The run's outcome without the agent's sign-ins it was given. */
export function masked(e: RunEntry, outcome: ExecutionOutcome): ExecutionOutcome {
  if (outcome.kind !== 'failed' || e.given.size === 0) return outcome;
  const mask = (text: string): string => [...e.given].reduce((t, v) => maskSecret(t, v, 'agent sign-in'), text);
  return { ...outcome, error: mask(outcome.error), ...(outcome.tail !== undefined ? { tail: mask(outcome.tail) } : {}) };
}

/** An executor call that never rejects: a throw is the run's failure. */
export async function guarded(e: RunEntry, go: () => Promise<ExecutionOutcome>): Promise<ExecutionOutcome> {
  try {
    return masked(e, await go());
  } catch (err) {
    return masked(e, { kind: 'failed', error: err instanceof Error ? err.message : String(err) });
  }
}

/** The run is left here: this hopper stops, or another one holds it. The step ends with no outcome, and is done again. */
export const left = (c: EngineContext, e: RunEntry): boolean => (c.stopping() || e.dropped === true) && e.cancelReason === undefined;

/** What the executor gets for job `j` on machine `m`. */
export function contextOf(c: EngineContext, e: RunEntry, d: JobRunData, j: Job, m: MachineSnapshot): ExecutionContext {
  const { store } = c;
  const executor = c.executors.get(j.spec.executor);
  const progress = progressOf(c, e, d);
  return {
    // The job rules as they are at this start (issue #172): an edit reaches the next job. Then its repository's (issue #1472).
    job: j, laneId: d.laneId, machine: m, signal: e.controller.signal,
    jobRules: withAsks(withRepoJobRules(readJobRules(store.config), repoJobRulesFor(store.config, j.source?.repo)), j.spec, j.forkOf, j.followOn),
    // A login the job waits on (issue #476) goes to the logins, never into a question.
    logins: c.logins.forRun({ jobId: j.id, laneId: d.laneId, machineId: m.id, run: j.spec.executor }, () => !c.stopping()),
    // The job acts through its source's connection (issue #214), its token kept current on its machine (issue #441).
    // `on`: the machine the job's work is on, when not the lane's (a job pod, issue #1283).
    // The agent's sign-in on a lane pod (issue #1287), from the user's vault: kept to mask it in the outcome.
    // The job's trace context (issue #1486), asked at each start, resume and turn: what the job does joins its run's span.
    // Placed already by the `credentials` step (issue #1662): not placed again.
    credentials: async (scratch, make = false, on = m) => {
      // Once only: a start tried again in a new pane reaped the scratch dir, the credentials too (start.ts).
      const memo = e.placed;
      e.placed = undefined;
      const placed = memo && memo.scratch === scratch && memo.make === make && memo.machine === on.id ? memo.env
        : await placeCredentials(c, j, on, executor?.machineShell?.(on), scratch, make, (line) => progress.report(line));
      const signIn = await agentSignIn(c, j, on);
      for (const value of Object.values(signIn)) e.given.add(value);
      return { ...c.traceContext(j.id), ...placed, ...signIn };
    },
    progress: (msg, tasks) => progress.report(msg, tasks),
    // Before a nudge (issue #627): the job's source, then what it waits on a person for.
    beforeNudge: () => nudgeCheck(c, j),
    // A person's notes (issue #997), read from the store each time: one sent mid-run goes in at the next turn boundary.
    notes: runNotes(c, j.id),
    saveState: (state) => { if (!left(c, e)) store.jobs.update(j.id, { executorState: state }); },
    workTree: (path) => { if (!left(c, e)) store.jobs.update(j.id, { workTree: path }); },
    agentSession: (id) => { if (!left(c, e)) store.jobs.update(j.id, { agentSession: id }); },
    // A missed heartbeat of its machine (issue #1569): its checkpoint now, while the machine may still answer.
    missedHeartbeat: () => c.checkpoints?.soon(j.id),
  };
}

/** The job this step works on, when it is still the claimed or running job of this run's lane and attempt. */
export function runJob(c: EngineContext, d: JobRunData): Job | undefined {
  const job = c.store.jobs.get(d.jobId);
  return job && job.attempts === d.attempt && job.laneId === d.laneId && (job.status === 'claimed' || job.status === 'running') ? job : undefined;
}

/** A fresh run splits its start (issue #1662): its executor opens the pane apart, and the run is not an answer it resumes with. */
const splits = (d: JobRunData, job: Job, executor: Executor | undefined): executor is Executor & Required<Pick<Executor, 'open' | 'credentialsAt' | 'reattach'>> =>
  d.launch === 'run' && job.pendingAnswer === undefined && executor?.open !== undefined && executor.credentialsAt !== undefined && executor.reattach !== undefined;

/** The steps but `run` (run-step.ts). Each reads what it needs from the store and the saga's data, so any host can do it. */
export function jobRunSteps(c: EngineContext, cleanup: Cleanup) {
  const { store } = c;
  return {
    /** The claimed job runs: `job.started`, its preempted mark gone (issue #1525). A reattach starts nothing. */
    claim(_e: RunEntry, d: JobRunData): Partial<JobRunData> {
      return store.tx(() => {
        const job = runJob(c, d);
        if (!job) return { gone: true };
        if (d.launch !== 'run' || job.status === 'running') return {};
        // A preempted job runs again (issue #1525): its mark goes, and its minimum run time counts from now.
        const j = store.jobs.update(job.id, { status: 'running', startedAt: nowIso(c), preempted: undefined });
        store.events.append({ type: 'job.started', jobId: job.id, laneId: d.laneId, data: { attempts: j.attempts } });
        return {};
      });
    },

    /** The job's way to the hopper, placed on its machine (credentials.ts). A failure here is the pane's to report. */
    async credentials(e: RunEntry, d: JobRunData): Promise<Partial<JobRunData>> {
      const job = runJob(c, d);
      const executor = job && c.executors.get(job.spec.executor);
      const machine = job && splits(d, job, executor) ? await machineOf(c, d.laneId) : undefined;
      if (!job || !machine || !splits(d, job, executor)) return {};
      const at = executor.credentialsAt(contextOf(c, e, d, job, machine));
      if (!at) return {};
      try {
        const env = await placeCredentials(c, job, machine, executor.machineShell?.(machine), at.scratch, at.makeWorkTree, (line) => progressOf(c, e, d).report(line));
        e.placed = { scratch: at.scratch, make: at.makeWorkTree, machine: machine.id, env };
        return { credentials: { scratch: at.scratch, env } };
      } catch {
        return {};
      }
    },

    /** The job's pane opened and its agent started, its task saved unsent: the executor's session state, kept. */
    async pane(e: RunEntry, d: JobRunData, again = false): Promise<Partial<JobRunData>> {
      const job = runJob(c, d);
      const executor = job && c.executors.get(job.spec.executor);
      if (!job || !splits(d, job, executor)) return {};
      const machine = await machineOf(c, d.laneId);
      const ended = machine ? await guarded(e, async () => (await executor.open(contextOf(c, e, d, job, machine), again)) ?? { kind: 'finished', result: OPENED })
        : { kind: 'failed' as const, error: `machine of lane ${d.laneId} is not attached` };
      if (left(c, e)) throw new Error('the run is left here');
      if (!(ended.kind === 'finished' && ended.result === OPENED)) return { outcome: ended };
      const now = store.jobs.get(job.id);
      return { session: { ...(now?.executorState ? { executorState: now.executorState } : {}), ...(now?.agentSession ? { agentSession: now.agentSession } : {}) } };
    },

    /** A parked run (issue #501): parked, its lane freed, its agent ended, and its checkpoint taken (issue #921). */
    async checkpoint(_e: RunEntry, d: JobRunData): Promise<Partial<JobRunData>> {
      if (!d.park) return {};
      const job = store.jobs.get(d.jobId);
      const running = runJob(c, d);
      // Parked already by a try a stop cut short: its agent is ended again, which is idempotent.
      const parked = running ? store.tx(() => recordPark(c, running, 'running', d.laneId))
        : job?.status === 'parked' && job.attempts === d.attempt ? job : undefined;
      if (parked) await releaseParked(c, parked);
      return {};
    },

    /** The run's outcome recorded once: a question, a review report, a wait, a lost-machine move, or an end and its cleanup. */
    async end(e: RunEntry, d: JobRunData): Promise<Partial<JobRunData>> {
      if (d.gone) return {};
      // Preempted (issue #1525): queued again at once, to resume where it stopped.
      if (d.park) { requeuePreempted(c, d.jobId); return {}; }
      const job = runJob(c, d);
      if (!job || job.status !== 'running') return {};
      if (d.requeue) { const why = d.requeue; store.tx(() => { const j = runJob(c, d); if (j) requeue(c, j, j.status, why); }); return {}; }
      progressOf(c, e, d).flush();
      const outcome = d.outcome ?? { kind: 'failed', error: 'the run left no outcome' };
      // Its machine lost (issue #1569): it resumes there in its kept work tree, or elsewhere from its checkpoint, when it can.
      if (d.lost && outcome.kind === 'failed' && !d.cancel && moveLost(c, job.id, d.laneId, d.lost, d.lostWhy ?? outcome.error)) return {};
      const recorded = recordOutcome(c, job, d.laneId, outcome, d.cancel, await machineOf(c, d.laneId));
      if (recorded.kind === 'question') c.questions.handle(recorded.questionId);
      else if (recorded.kind === 'report') c.reviews[recorded.review].handle(recorded.itemId);
      // Its own wait (issue #483) keeps its pane: nothing to clean up.
      else if (recorded.kind !== 'wait') await cleanup(job.id);
      return {};
    },
  };
}

/** The result a pane step's `open` stands for when it opened the pane: no outcome yet. */
const OPENED = 'hopper:opened';
