// The isolation stop (issue #752, design.md "The isolation stop"): a client target cut off from the hopper longer than
// its max isolation stops the jobs the hopper last said run there, so a box out of reach does not go on with authority
// the hopper can no longer check. The client hears the hopper through each request the hopper signed and each keepalive
// PING (keepalive.ts) the hopper's end of the link answers; the hopper names its jobs there in each `/release` probe. A stop runs the reap with no
// scratch dir: the job's scope and processes stop, its work stays for the hopper's own reap. The next `/release` answer
// says which jobs it stopped, once. The max isolation is longer than the hopper's link grace, so in the normal case
// the hopper decides first. The jobs the hopper named, and when it was last heard, are kept in a file in the client dir
// (issue #1627), so a client that restarts while cut off still stops them; a file older than a day is not read. Imports
// nothing of hopper but its own directory: it is installed as plain files.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isJobId } from './reap.ts';

/** Default max isolation: 30 min, well past the hopper's link grace (HOPPER_LINK_GRACE_MS, 10 min by default). */
export const MAX_ISOLATION_MS = 30 * 60_000;
/** How often the client checks how long it has not heard the hopper; also how often a hearing is written to its file. */
const CHECK_EVERY_MS = 15000;
/** A kept file this much older than its last hearing is not read: its jobs are long gone. */
export const ISOLATION_FILE_LIFE_MS = 24 * 60 * 60_000;
/** The file in the client dir. */
export const ISOLATION_FILE = 'isolation.json';

interface Kept { jobs: string[]; heardAt: number }

/** What the file keeps, when it is there, readable and not past its life. */
function readKept(file: string, now: number): Kept | undefined {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<Kept>;
    if (!Array.isArray(v.jobs) || typeof v.heardAt !== 'number' || now - v.heardAt > ISOLATION_FILE_LIFE_MS) return undefined;
    return { jobs: [...new Set(v.jobs.filter(isJobId))], heardAt: Math.min(v.heardAt, now) };
  } catch {
    return undefined;
  }
}

/** One job the client stopped: when, and how long it had not heard the hopper then. */
export interface IsolationStop { jobId: string; at: string; cutOffMs: number }

export interface IsolationWatch {
  /** The hopper was heard: a request it signed, or a keepalive PING it answered. */
  heard(): void;
  /** The jobs the hopper says run on this machine now (a `/release` probe's `jobs`). */
  told(jobs: unknown): void;
  /** Called every tick: stops the named jobs once the hopper has not been heard for the max isolation. */
  check(): Promise<void>;
  /** The stops not said yet; each is said once. */
  takeStops(): IsolationStop[];
}

export interface StartedIsolationWatch extends IsolationWatch {
  /** A `/release` probe's body: the jobs it names are told; what the answer adds, the stops not said yet. */
  probed(body: string): { isolationStops?: IsolationStop[] };
  close(): void;
}

/** The watch a client runs: every `isolationCheckMs` it checks how long it has not heard the hopper. */
export function startIsolationWatch(o: { maxIsolationMs?: number; isolationCheckMs?: number; isolationFile?: string; stopJob: (jobId: string) => Promise<void>; log: (line: string) => void }): StartedIsolationWatch {
  const watch = createIsolationWatch({ maxIsolationMs: o.maxIsolationMs ?? MAX_ISOLATION_MS, stopJob: o.stopJob, log: o.log, ...(o.isolationFile ? { file: o.isolationFile } : {}) });
  const tick = setInterval(() => { void watch.check(); }, o.isolationCheckMs ?? CHECK_EVERY_MS);
  tick.unref();
  return {
    ...watch,
    probed(body) {
      try { watch.told((JSON.parse(body) as { jobs?: unknown }).jobs); } catch { /* a probe with no jobs */ }
      const stops = watch.takeStops();
      return stops.length ? { isolationStops: stops } : {};
    },
    close: () => clearInterval(tick),
  };
}

/**
 * `maxIsolationMs` 0: no stop, ever. `stopJob` stops one job's scope and processes on this machine. `file`: where the
 * jobs and the last hearing are kept, read at the start.
 */
export function createIsolationWatch(o: { maxIsolationMs: number; stopJob: (jobId: string) => Promise<void>; log: (line: string) => void; now?: () => number; file?: string }): IsolationWatch {
  const now = o.now ?? Date.now;
  const kept = o.file ? readKept(o.file, now()) : undefined;
  let lastHeard = kept?.heardAt ?? now();
  let jobs: string[] = kept?.jobs ?? [];
  let stops: IsolationStop[] = [];
  let stopping = false;
  let writtenAt = lastHeard;
  const keep = (): void => {
    if (!o.file) return;
    writtenAt = lastHeard;
    try {
      writeFileSync(`${o.file}.tmp`, JSON.stringify({ jobs, heardAt: lastHeard } satisfies Kept), { mode: 0o600 });
      renameSync(`${o.file}.tmp`, o.file);
    } catch (e) {
      o.log(`hopper-client: keeping the isolation file failed: ${(e as Error).message}`);
    }
  };
  if (kept?.jobs.length) o.log(`hopper-client: the hopper named ${kept.jobs.length} job(s) here before this start; they stop if it is not heard within the max isolation`);
  return {
    heard() { lastHeard = now(); if (lastHeard - writtenAt >= CHECK_EVERY_MS) keep(); },
    told(v) {
      if (!Array.isArray(v)) return;
      const next = [...new Set(v.filter(isJobId))];
      const same = next.length === jobs.length && next.every((j, i) => j === jobs[i]);
      jobs = next;
      if (!same) keep();
    },
    async check() {
      const cutOffMs = now() - lastHeard;
      if (!o.maxIsolationMs || stopping || !jobs.length || cutOffMs < o.maxIsolationMs) return;
      stopping = true;
      const named = jobs;
      jobs = [];
      keep();
      try {
        for (const jobId of named) {
          o.log(`hopper-client: the hopper has not been heard for ${Math.round(cutOffMs / 1000)} s: stopping job ${jobId}`);
          await o.stopJob(jobId).catch((e: unknown) => o.log(`hopper-client: stopping job ${jobId} failed: ${(e as Error).message}`));
          stops.push({ jobId, at: new Date(now()).toISOString(), cutOffMs });
        }
      } finally {
        stopping = false;
      }
    },
    takeStops() { const said = stops; stops = []; return said; },
  };
}

/** The max isolation a client's environment sets (`HOPPER_CLIENT_MAX_ISOLATION_MS`): whole ms, 0 for none; else the default. */
export function maxIsolationOf(v: string | undefined): number {
  if (v === undefined || v.trim() === '') return MAX_ISOLATION_MS;
  if (!/^\d+$/.test(v.trim())) throw new Error(`HOPPER_CLIENT_MAX_ISOLATION_MS must be whole milliseconds, 0 for no stop: ${JSON.stringify(v).slice(0, 40)}`);
  return Number(v.trim());
}
