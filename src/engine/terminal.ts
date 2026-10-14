// The job's terminal (issue #1128, design.md "The job's terminal"): a person views a running job's pane and types into it
// from the hopper, through the job's executor and so its machine's own connection. Access decides each use before this is
// asked (the HTTP edge). A terminal session is one person's on one job: it opens at their first read or input, and a new
// one opens after TERMINAL_IDLE_MS with neither. Its events (`terminal.opened`, `terminal.typed`) never carry the text.
import { randomUUID } from 'node:crypto';
import type { Clock, Executor, ExecutorRegistry } from '../domain/ports.ts';
import type { UserStore } from '../domain/store.ts';
import type { ActingPerson, Job, JobStatus } from '../domain/types.ts';

/** A session with no read and no input this long ends; the next use opens a new one. */
export const TERMINAL_IDLE_MS = 2 * 60_000;
/** The lines of a read when the person names none, and the most they may name. */
export const TERMINAL_LINES = 200;
export const TERMINAL_MAX_LINES = 2000;
/** The most text one input writes. */
export const TERMINAL_MAX_TEXT = 4000;
/** herdr's key names a person may press: the ones a terminal needs that are not text. */
export const TERMINAL_KEYS = ['enter', 'esc', 'tab', 'backspace', 'up', 'down', 'left', 'right', 'ctrl+c', 'ctrl+d'] as const;
/** A job holds its pane while it is at work or waits with it (on a question, on its own wait). */
const PANE_STATUSES: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];

export interface TerminalScreen { jobId: string; sessionId: string; screen: string; at: string }
export type TerminalInput = { text: string } | { keys: string[] };
export type TerminalRefusal = { ok: false; reason: 'not_found' | 'no_pane' | 'unreachable'; message: string };

export interface JobTerminal {
  screen(jobId: string, lines: number, acting: ActingPerson): Promise<({ ok: true } & TerminalScreen) | TerminalRefusal>;
  type(jobId: string, input: TerminalInput, acting: ActingPerson): Promise<{ ok: true; sessionId: string } | TerminalRefusal>;
}

export function createJobTerminal(o: { store: Pick<UserStore, 'jobs' | 'events'>; executors: ExecutorRegistry; clock: Clock; idGen?: () => string }): JobTerminal {
  const idGen = o.idGen ?? randomUUID;
  const sessions = new Map<string, { id: string; lastAt: number }>();

  /** The job and its executor's terminal, or why it has none. */
  const reach = (jobId: string): { job: Job; executor: Executor } | TerminalRefusal => {
    const job = o.store.jobs.get(jobId);
    if (!job) return { ok: false, reason: 'not_found', message: `job ${jobId} not found` };
    const executor = o.executors.get(job.spec.executor);
    if (!executor?.paneScreen || !executor.typeInPane) return { ok: false, reason: 'no_pane', message: `job ${jobId} runs on ${job.spec.executor}, which has no terminal` };
    if (!PANE_STATUSES.includes(job.status)) return { ok: false, reason: 'no_pane', message: `job ${jobId} is ${job.status}: only a job at work or waiting holds its pane` };
    return { job, executor };
  };

  /** The person's session on the job: theirs while used, else a new one, opened as an event. */
  const sessionOf = (job: Job, acting: ActingPerson): string => {
    const key = `${job.id}\n${acting.person}\n${acting.via}`;
    const now = o.clock.now().getTime();
    const live = sessions.get(key);
    for (const [k, s] of sessions) if (now - s.lastAt > TERMINAL_IDLE_MS) sessions.delete(k);
    if (live && now - live.lastAt <= TERMINAL_IDLE_MS) {
      live.lastAt = now;
      return live.id;
    }
    const id = idGen();
    sessions.set(key, { id, lastAt: now });
    o.store.events.append({ type: 'terminal.opened', jobId: job.id, ...where(job), data: { sessionId: id, person: acting.person, via: acting.via } });
    return id;
  };

  const unreachable = (job: Job, e: unknown): TerminalRefusal =>
    ({ ok: false, reason: 'unreachable', message: `the pane of job ${job.id} cannot be reached: ${(e as Error).message}` });

  return {
    async screen(jobId, lines, acting) {
      const r = reach(jobId);
      if ('ok' in r) return r;
      let screen: string | undefined;
      try {
        screen = await r.executor.paneScreen!(r.job, lines);
      } catch (e) {
        return unreachable(r.job, e);
      }
      if (screen === undefined) return { ok: false, reason: 'no_pane', message: `job ${jobId} holds no pane` };
      return { ok: true, jobId, sessionId: sessionOf(r.job, acting), screen, at: o.clock.now().toISOString() };
    },

    async type(jobId, input, acting) {
      const r = reach(jobId);
      if ('ok' in r) return r;
      let typed: boolean;
      try {
        typed = await r.executor.typeInPane!(r.job, input);
      } catch (e) {
        return unreachable(r.job, e);
      }
      if (!typed) return { ok: false, reason: 'no_pane', message: `job ${jobId} holds no pane` };
      const sessionId = sessionOf(r.job, acting);
      const what = 'text' in input ? { chars: input.text.length } : { keys: input.keys };
      o.store.events.append({ type: 'terminal.typed', jobId, ...where(r.job), data: { sessionId, person: acting.person, via: acting.via, ...what } });
      return { ok: true, sessionId };
    },
  };
}

const where = (job: Job): { laneId?: string } => (job.laneId ? { laneId: job.laneId } : {});
