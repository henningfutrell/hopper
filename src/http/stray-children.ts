// Stray children (issue #2623): the processes whose parent is the hopper's process but which it did not start itself.
// Node waits on every child it starts (libuv reaps it at its exit), so a child of the hopper that stays a zombie, or a
// live one it never started, is a grandchild given to the hopper when its own parent ended. That happens only when the
// hopper's process is PID 1 of its container, with no init to take them (the image runs tini first), or a subreaper. Each
// zombie holds a PID until the hopper ends. Read from /proc every 30 s at most; above the limit, `/api/health` shows the
// count (`strayChildren`) and the top bar a badge. The processes the hopper started are told by Node's `child_process`
// diagnostics channel, as event-loop-processes.ts counts them, so every caller is known.
import { readdirSync, readFileSync } from 'node:fs';
import { subscribe } from 'node:diagnostics_channel';
import type { ChildProcess } from 'node:child_process';

/** More stray children than this is a problem. */
export const STRAY_CHILDREN_LIMIT = 5;
/** How long one /proc read is used. */
const READ_EVERY_MS = 30_000;
/** How many programs the count names. */
const PROGRAMS_NAMED = 3;
/** The started children kept before the ended ones are dropped. */
const PRUNE_AT = 256;

/** The stray children of one process: zombies, live ones, and the programs most of them are. */
export interface StrayChildren { zombies: number; orphans: number; programs: string[] }

/** A process's parent, state and program name from `/proc/<pid>/stat`; undefined when it is gone. */
function statOf(procRoot: string, pid: string): { ppid: number; state: string; comm: string } | undefined {
  let text: string;
  try { text = readFileSync(`${procRoot}/${pid}/stat`, 'utf8'); } catch { return undefined; }
  // The program name is in parentheses and can hold spaces and parentheses itself: the fields follow the last ')'.
  const open = text.indexOf('('), close = text.lastIndexOf(')');
  if (open < 0 || close < open) return undefined;
  const [state, ppid] = text.slice(close + 2).split(' ');
  return { ppid: Number(ppid), state: state ?? '', comm: text.slice(open + 1, close) };
}

/** The children of `pid` that are not in `started`: the zombies, and the live ones (orphans). */
export function strayChildrenOf(pid: number, started: ReadonlySet<number>, procRoot = '/proc'): StrayChildren {
  let zombies = 0, orphans = 0;
  const programs = new Map<string, number>();
  let entries: string[];
  try { entries = readdirSync(procRoot); } catch { return { zombies, orphans, programs: [] }; }
  for (const e of entries) {
    if (!/^\d+$/.test(e) || started.has(Number(e))) continue;
    const s = statOf(procRoot, e);
    if (!s || s.ppid !== pid) continue;
    if (s.state === 'Z') zombies++; else orphans++;
    programs.set(s.comm, (programs.get(s.comm) ?? 0) + 1);
  }
  const named = [...programs].sort((a, b) => b[1] - a[1]).slice(0, PROGRAMS_NAMED).map(([what]) => what);
  return { zombies, orphans, programs: named };
}

export interface StrayWatch {
  /** The pids of the children this process started that have not ended yet. */
  started(): Set<number>;
  /** This process's stray children now, read at most every 30 s. */
  read(now?: number): StrayChildren;
  /** The count when it is above the limit, else undefined; logged once each time it goes over. */
  problem(now?: number): StrayChildren | undefined;
}

export function watchStrayChildren(o: { pid?: number; procRoot?: string; log?: (line: string) => void } = {}): StrayWatch {
  const children = new Set<ChildProcess>();
  // A child's pid is set once it spawned, its exit code or signal once Node waited on it: then it is no longer kept.
  const prune = (keep?: ChildProcess): void => {
    for (const c of children) if (c !== keep && (c.pid === undefined || c.exitCode !== null || c.signalCode !== null)) children.delete(c);
  };
  subscribe('child_process', (message) => {
    const child = (message as { process?: ChildProcess }).process;
    if (!child) return;
    children.add(child);
    if (children.size > PRUNE_AT) prune(child);
  });
  const pid = o.pid ?? process.pid;
  let last: { at: number; reading: StrayChildren } | undefined;
  let over = false;
  const started = (): Set<number> => {
    prune();
    return new Set([...children].map((c) => c.pid!));
  };
  const read = (now = Date.now()): StrayChildren => {
    if (!last || now - last.at >= READ_EVERY_MS) last = { at: now, reading: strayChildrenOf(pid, started(), o.procRoot) };
    return last.reading;
  };
  return {
    started,
    read,
    problem(now) {
      const r = read(now);
      const isOver = r.zombies + r.orphans > STRAY_CHILDREN_LIMIT;
      if (isOver && !over) (o.log ?? console.warn)(`hopper: ${r.zombies} zombie and ${r.orphans} orphaned child processes (${r.programs.join(', ')}) are the hopper's own: its process takes the orphans of its children. Run it with an init (the image's tini, or --init)`);
      over = isOver;
      return isOver ? r : undefined;
    },
  };
}

/** This hopper process's stray children: one watch, as the children are the process's. */
export const strayChildren: StrayWatch = watchStrayChildren();
