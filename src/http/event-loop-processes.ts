// The processes the hopper starts, counted by program for the event loop watchdog (issue #2367, event-loop.ts). Each
// process the hopper starts holds the event loop while it forks, longer the larger the process is: the update check once
// started about 2,400 git processes a minute, stalls of 2–4 s with almost no store time in them. Node publishes each
// ChildProcess it makes on the `child_process` diagnostics channel, so every caller is counted, not only the ones that
// remember to. A program is named by its file name only (`git`, `herdr`, `ssh`), never its path or its arguments.
// spawnSync makes no ChildProcess and is not counted.
import { basename } from 'node:path';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { ChildProcess } from 'node:child_process';

const CHANNEL = 'child_process';
/** How many programs a stall names. */
const PROGRAMS_NAMED = 3;

/** The processes started during a stall: how many in all, and the programs started most. */
export interface StallProcesses { count: number; programs: { what: string; count: number }[] }

export interface ProcessWatch {
  /** The processes started since the watch began, by program. */
  totals(): ReadonlyMap<string, number>;
  end(): void;
}

export function watchProcesses(): ProcessWatch {
  const totals = new Map<string, number>();
  // The channel names a child before it spawns, so its file is read later: at the next child, which is made only after
  // it spawned, or at the next totals. One child waits at most.
  let pending: ChildProcess | undefined;
  const fold = (): void => {
    if (!pending) return;
    const what = pending.spawnfile ? basename(pending.spawnfile) : '(not started)';
    totals.set(what, (totals.get(what) ?? 0) + 1);
    pending = undefined;
  };
  const on = (message: unknown): void => {
    fold();
    pending = (message as { process?: ChildProcess }).process;
  };
  subscribe(CHANNEL, on);
  return {
    totals: () => { fold(); return new Map(totals); },
    end: () => { unsubscribe(CHANNEL, on); },
  };
}

/** The processes this hopper process started, for its watchdog: one watch, as the processes are the process's. */
export const startedProcesses: ProcessWatch = watchProcesses();

/** The processes started between two totals, by program, most first. */
export function processesBetween(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): StallProcesses | undefined {
  const all = [...after].map(([what, n]) => ({ what, count: n - (before.get(what) ?? 0) })).filter((p) => p.count > 0).sort((a, b) => b.count - a.count);
  if (!all.length) return undefined;
  return { count: all.reduce((n, p) => n + p.count, 0), programs: all.slice(0, PROGRAMS_NAMED) };
}
