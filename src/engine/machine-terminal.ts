// The machine's terminal (issue #1128, design.md "The machine's terminal"): a person reaches the hopper's herdr session on
// a machine from the hopper — every pane of it, the ones no job holds too —, views a pane and types into it, through the
// machine's own connection (this machine, ssh, or the machine's client). Access decides each use before this is asked (the
// HTTP edge). Its sessions are the job terminal's (./terminal.ts): audited, never the text; on a pane a job holds, also on
// that job's timeline.
import type { Clock, ExecutorRegistry } from '../domain/ports.ts';
import { machineOfLane } from '../domain/raised-by.ts';
import type { UserStore } from '../domain/store.ts';
import type { PaneSession, TerminalPane } from '../domain/terminal.ts';
import type { ActingPerson, Job, MachineSnapshot } from '../domain/types.ts';
import { holdsPane, terminalSessions, type TerminalInput, type TerminalPlace } from './terminal.ts';

/** A pane of the machine's herdr session, and the job that holds it, when one does. */
export interface MachinePane extends TerminalPane { jobId?: string }
export interface MachineScreen { machineId: string; paneId: string; sessionId: string; screen: string; at: string }
export type MachineTerminalRefusal = { ok: false; reason: 'not_found' | 'no_pane' | 'unreachable'; message: string };

export interface MachineTerminal {
  panes(machineId: string): Promise<({ ok: true; machineId: string; panes: MachinePane[] }) | MachineTerminalRefusal>;
  screen(machineId: string, paneId: string, lines: number, acting: ActingPerson): Promise<({ ok: true } & MachineScreen) | MachineTerminalRefusal>;
  type(machineId: string, paneId: string, input: TerminalInput, acting: ActingPerson): Promise<{ ok: true; sessionId: string } | MachineTerminalRefusal>;
}

export function createMachineTerminal(o: {
  store: Pick<UserStore, 'jobs' | 'events'>; executors: ExecutorRegistry; machines: () => Promise<readonly MachineSnapshot[]>; clock: Clock; idGen?: () => string;
}): MachineTerminal {
  const sessions = terminalSessions(o);

  /** The machine's herdr session, as the first of its executors that reaches it does, or why there is none. */
  const reach = async (machineId: string): Promise<{ machine: MachineSnapshot; session: PaneSession } | MachineTerminalRefusal> => {
    const machine = (await o.machines()).find((m) => m.id === machineId);
    if (!machine) return { ok: false, reason: 'not_found', message: `machine ${machineId} not found` };
    for (const name of machine.executors) {
      const session = o.executors.get(name)?.paneSession?.(machine);
      if (session) return { machine, session };
    }
    return { ok: false, reason: 'no_pane', message: `machine ${machineId} has no herdr session the hopper reaches` };
  };

  /** The job at work or waiting on the machine whose pane this is. */
  const holder = (machineId: string, paneId: string): Job | undefined => o.store.jobs.list({ status: ['running', 'waiting_answer', 'waiting_on'] })
    .find((j) => holdsPane(j) && machineOfLane(j.laneId) === machineId && (j.executorState as { paneId?: string } | undefined)?.paneId === paneId);

  const place = (machineId: string, paneId: string): TerminalPlace => {
    const job = holder(machineId, paneId);
    return { machineId, paneId, ...(job ? { jobId: job.id, ...(job.laneId ? { laneId: job.laneId } : {}) } : {}) };
  };

  /** A pane gone reads as no pane; anything else as a machine out of reach. */
  const failed = (machineId: string, paneId: string, e: unknown): MachineTerminalRefusal => ((e as { code?: string }).code === 'pane_not_found'
    ? { ok: false, reason: 'no_pane', message: `pane ${paneId} is not in machine ${machineId}'s herdr session` }
    : { ok: false, reason: 'unreachable', message: `machine ${machineId}'s herdr session cannot be reached: ${(e as Error).message}` });

  return {
    async panes(machineId) {
      const r = await reach(machineId);
      if ('ok' in r) return r;
      let panes: TerminalPane[];
      try {
        panes = await r.session.panes();
      } catch (e) {
        return { ok: false, reason: 'unreachable', message: `machine ${machineId}'s herdr session cannot be reached: ${(e as Error).message}` };
      }
      return { ok: true, machineId, panes: panes.map((p) => { const job = holder(machineId, p.paneId); return job ? { ...p, jobId: job.id } : p; }) };
    },

    async screen(machineId, paneId, lines, acting) {
      const r = await reach(machineId);
      if ('ok' in r) return r;
      let screen: string;
      try {
        screen = await r.session.read(paneId, lines);
      } catch (e) {
        return failed(machineId, paneId, e);
      }
      return { ok: true, machineId, paneId, sessionId: sessions.open(place(machineId, paneId), acting), screen, at: o.clock.now().toISOString() };
    },

    async type(machineId, paneId, input, acting) {
      const r = await reach(machineId);
      if ('ok' in r) return r;
      try {
        await r.session.type(paneId, input);
      } catch (e) {
        return failed(machineId, paneId, e);
      }
      return { ok: true, sessionId: sessions.typed(place(machineId, paneId), input, acting) };
    },
  };
}
