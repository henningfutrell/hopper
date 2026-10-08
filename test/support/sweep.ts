// What a test run leaves behind, and how it is removed (issue #401, design.md "Database"): the run
// root `jh-run-<pid>-*` in the tmpdir, the processes carrying the run's marker HOPPER_TEST_RUN, and
// the containers a test started — named `jh-<kind>-<pid>` or labelled `hopper.test-pid=<pid>`. A
// pid that is alive belongs to a run still going (maybe a concurrent one), so only a dead pid's
// leftovers are removed.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const RUN_MARKER = 'HOPPER_TEST_RUN';
export const PID_LABEL = 'hopper.test-pid';
const RUN_ROOT = /^jh-run-(\d+)-/;
const CONTAINER = /^jh-.*-(\d+)$/;

/** Whether a pid names a live process (EPERM: alive, another user's). */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Gone: no such process, or a zombie (dead, not yet reaped by its parent). */
export function gone(pid: number, proc = '/proc'): boolean {
  try {
    const stat = readFileSync(join(proc, String(pid), 'stat'), 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z';
  } catch {
    return !alive(pid);
  }
}

/** Removes the run roots in `dir` whose pid is dead; returns their paths. */
export function sweepRunRoots(dir: string, isAlive: (pid: number) => boolean = alive): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const stale = names.filter((n) => { const m = RUN_ROOT.exec(n); return m !== null && !isAlive(Number(m[1])); }).map((n) => join(dir, n));
  for (const p of stale) rmSync(p, { recursive: true, force: true });
  return stale;
}

function marked(marker: string, self: number, proc: string): number[] {
  let pids: string[];
  try { pids = readdirSync(proc).filter((n) => /^\d+$/.test(n)); } catch { return []; }
  const needle = `${RUN_MARKER}=${marker}`;
  return pids.map(Number).filter((pid) => {
    if (pid === self) return false;
    try { return readFileSync(join(proc, String(pid), 'environ'), 'utf8').split('\0').includes(needle); } catch { return false; }
  });
}

/**
 * Kills every process whose environment carries `HOPPER_TEST_RUN=<marker>`, except `self`: SIGTERM,
 * then SIGKILL after `graceMs`. Linux only (reads /proc); quiet where there is none.
 */
export async function killMarked(marker: string, o: { self?: number; graceMs?: number; proc?: string } = {}): Promise<number[]> {
  const proc = o.proc ?? '/proc';
  const pids = marked(marker, o.self ?? process.pid, proc);
  const signal = (pid: number, s: NodeJS.Signals) => { try { process.kill(pid, s); } catch { /* gone */ } };
  for (const pid of pids) signal(pid, 'SIGTERM');
  const until = Date.now() + (o.graceMs ?? 2000);
  while (pids.some((pid) => !gone(pid, proc)) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  for (const pid of pids) if (!gone(pid, proc)) signal(pid, 'SIGKILL');
  while (pids.some((pid) => !gone(pid, proc)) && Date.now() < until + 2000) await new Promise((r) => setTimeout(r, 50));
  return pids;
}

/** The docker a sweep reads and removes through. */
export interface Docker {
  /** Every container's name. */
  names(): string[];
  /** The containers carrying the `hopper.test-pid` label, with its value. */
  labeled(): { id: string; pid: string }[];
  remove(ids: string[]): void;
}

/** Removes the test containers whose pid is dead; returns the names and ids removed. */
export function sweepContainers(docker: Docker, isAlive: (pid: number) => boolean = alive): string[] {
  const dead = (pid: string) => /^\d+$/.test(pid) && !isAlive(Number(pid));
  const stale = [
    ...docker.names().filter((n) => { const m = CONTAINER.exec(n); return m !== null && dead(m[1]!); }),
    ...docker.labeled().filter((c) => dead(c.pid)).map((c) => c.id),
  ];
  if (stale.length > 0) docker.remove(stale);
  return stale;
}

/** The real docker CLI; with no docker (or no daemon) it lists nothing. */
export const dockerCli: Docker = {
  names: () => lines(['ps', '-a', '--format', '{{.Names}}']),
  labeled: () => lines(['ps', '-a', '--filter', `label=${PID_LABEL}`, '--format', `{{.ID}} {{.Label "${PID_LABEL}"}}`])
    .map((l) => { const [id = '', pid = ''] = l.split(' '); return { id, pid }; }),
  remove: (ids) => { try { execFileSync('docker', ['rm', '-f', ...ids], { stdio: 'ignore', timeout: 60_000 }); } catch { /* gone, or no docker */ } },
};

function lines(args: string[]): string[] {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
