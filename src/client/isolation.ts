// The isolation stop (issue #752, design.md "The isolation stop"): a client target cut off from the hopper longer than
// its max isolation stops the jobs the hopper last said run there, so a box out of reach does not go on with authority
// the hopper can no longer check. The client hears the hopper through each request the hopper signed and each keepalive
// PING (keepalive.ts) the hopper's end of the link answers; the hopper names its jobs there in each `/release` probe. A stop runs the reap with no
// scratch dir: the job's scope and processes stop, its work stays for the hopper's own reap. The next `/release` answer
// says which jobs it stopped, once. The max isolation is longer than the hopper's link grace, so in the normal case
// the hopper decides first. Imports nothing of hopper but its own directory: it is installed as plain files.
import { isJobId } from './server.ts';

/** Default max isolation: 30 min, well past the hopper's link grace (HOPPER_LINK_GRACE_MS, 10 min by default). */
export const MAX_ISOLATION_MS = 30 * 60_000;
/** How often the client checks how long it has not heard the hopper. */
const CHECK_EVERY_MS = 15000;

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
export function startIsolationWatch(o: { maxIsolationMs?: number; isolationCheckMs?: number; stopJob: (jobId: string) => Promise<void>; log: (line: string) => void }): StartedIsolationWatch {
  const watch = createIsolationWatch({ maxIsolationMs: o.maxIsolationMs ?? MAX_ISOLATION_MS, stopJob: o.stopJob, log: o.log });
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

/** `maxIsolationMs` 0: no stop, ever. `stopJob` stops one job's scope and processes on this machine. */
export function createIsolationWatch(o: { maxIsolationMs: number; stopJob: (jobId: string) => Promise<void>; log: (line: string) => void; now?: () => number }): IsolationWatch {
  const now = o.now ?? Date.now;
  let lastHeard = now();
  let jobs: string[] = [];
  let stops: IsolationStop[] = [];
  let stopping = false;
  return {
    heard() { lastHeard = now(); },
    told(v) { if (Array.isArray(v)) jobs = [...new Set(v.filter(isJobId))]; },
    async check() {
      const cutOffMs = now() - lastHeard;
      if (!o.maxIsolationMs || stopping || !jobs.length || cutOffMs < o.maxIsolationMs) return;
      stopping = true;
      const named = jobs;
      jobs = [];
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
