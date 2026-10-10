// The panes the herdr-claude executor holds (docs/design.md "Phase 2" → "herdr-claude executor"): which herdr a
// pane lives on, the pane a lane holds, the executor state that names it, and a timeout's liveness. Pure; no I/O.
import type { ExecutionContext, Reaped } from '../../domain/ports.ts';
import type { Job, JobLiveness } from '../../domain/types.ts';
import type { Sleep } from './monitor.ts';
import type { PaneState } from './start.ts';

export const realSleep: Sleep = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});

export const lastLineOf = (text: string): string => text.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? text.trim();

export const heldOf = (s: PaneState, jobId: string): HeldPane => ({
  paneId: s.paneId, jobId, agentName: s.agentName, cwd: s.cwd, ...(s.ssh ? { ssh: s.ssh } : {}), ...(s.session ? { session: s.session } : {}),
  ...(s.client ? { client: { machine: s.client.machine } } : {}),
});

export function paneStateOf(job: Job): PaneState | undefined {
  const s = job.executorState as Partial<PaneState> | undefined;
  return s?.paneId && s.agentName ? (s as PaneState) : undefined;
}

/** A client target (design.md "Client targets"): which machine. Its link and token are the runtime's (issue #308). */
export interface ClientTarget { machine: string }

/** An attached machine's herdr: an ssh target's (where, which session; herdr by name there, issue #311), or a client target's. */
export type RemoteHerdr = { ssh: string; session: string } | { client: ClientTarget };

/** Which herdr: a client target's, an ssh target's session, or (neither) this machine's, in `session` when given. */
export interface Where { ssh?: string; session?: string; client?: ClientTarget }

/** Where a job on the lane's machine runs. */
export const whereOn = (m: ExecutionContext['machine']): Where => {
  if (m.client) return { client: { machine: m.id } };
  if (m.ssh) return { ssh: m.ssh, ...(m.herdr ? { session: m.herdr.session } : {}) };
  return m.herdr ? { session: m.herdr.session } : {};
};

/** What the reap does with a job's scratch dir: removes it unless it holds work, keeps it whatever it holds, or leaves it unread. */
export type Scratch = 'remove' | 'keep' | 'none';

/**
 * A timed-out job's liveness (issue #630): when its pane output last changed, and whether the reap at its timeout
 * found a branch it pushed. A reap that did not run says nothing of pushes.
 */
export const timeoutLiveness = (outputAt: number | undefined, reaped: Reaped | undefined): JobLiveness => ({
  ...(outputAt !== undefined ? { outputAt: new Date(outputAt).toISOString() } : {}), ...(reaped ? { pushed: (reaped.pushed?.length ?? 0) > 0 } : {}),
});

/** A pane on one machine: pane ids are per herdr server, so two machines can share one. */
export interface PaneOn extends Where { paneId: string }

/** A pane a lane holds, with the job it runs, for the reap. */
export interface HeldPane extends PaneOn { jobId: string; agentName: string; cwd: string }

export const samePane = (a: PaneOn, b: PaneOn): boolean => a.paneId === b.paneId && a.ssh === b.ssh && a.client?.machine === b.client?.machine
  && (a.ssh !== undefined || a.client !== undefined || a.session === b.session);
