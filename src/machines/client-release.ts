// The hopper keeps every client target on its own client release (design.md "Client releases",
// issues #70, #545). Each probe of a client target asks the client which release it runs; when it is not the
// hopper's, the hopper loads its release onto it down its signed link and the client restarts to
// run it. A client released before manifests checks a fixed list of file names: it gets the bridge to the
// hopper's release instead (client-bridge.ts), its list read from its own refusal of an empty release.
// Never while a job is at work on that machine: a running job's herdr calls must not meet a client
// that is restarting. A job that waits in its pane (a question, a wait it parked on) is not at work. A client behind
// the hopper's release for `CLIENT_UPDATE_HOLD_MS` holds every job off the machine (`client.updateHold`, issue #2715):
// the jobs at work end, the release is loaded, and the machine takes jobs again — so a busy machine gets the fixes of
// its client too (its reap, its survey). Behind for `CLIENT_UPDATE_SWAP_MS`, it loads while jobs are at work there — the
// **update swap** (issue #2738) — once each of them rides the client's restart (`ridesClientRestart`): a job that runs for
// days must not keep a machine on an old client. Until then each probe says what the load waits on (`client.pendingLoad`).
// A load that has not taken after three tries is not tried again: the probe says why
// (`client.update.problem`), and Machines shows it with the line that reinstalls the client. A client older
// than releases answers no release: it stays online and is reported once, to be added again with Add machine.
// Each line is logged once per machine. Each probe names the jobs running there; a client cut off from the hopper
// longer than its max isolation stops them, and the probe after its link is back logs each stop (issue #752).
// The stopped job's own end is the hopper's as before: its pane is gone, so it fails, and its cleanup reaps it.
import type { ClientRelease } from '../client/release.ts';
import type { Executor } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';
import { ClientError, clientRunningRelease, clientWorkTree, loadClientRelease, type ClientTransport } from '../executors/client.ts';
import { DEFAULT_WORK_TREE } from '../client/work-tree.ts';
import { probeClient, type MachineProbe } from './attached.ts';
import { bridgeRelease, fixedNamesOf } from './client-bridge.ts';

interface Logger { info(line: string): void; warn(line: string): void }

/**
 * `jobs`: the jobs on the machine now, their waiting panes included (the client stops them when cut off); `atWork`: those
 * of them at work on a lane, absent the same as `jobs`. While any is at work, no release is loaded, but by the update swap
 * once each rides the client's restart (`rides`, absent: none does).
 */
export type ClientReleaseKeeper = (t: ClientTransport, jobs: () => string[], atWork?: () => string[], rides?: (jobId: string) => boolean) => Promise<MachineProbe>;

/** How long a client may run another release than the hopper's while jobs are at work there before it holds new jobs off (issue #2715). */
export const CLIENT_UPDATE_HOLD_MS = 60 * 60_000;
/** How long before the hopper loads its release while jobs are at work there, once each rides the client's restart (issue #2738). */
export const CLIENT_UPDATE_SWAP_MS = 2 * 60 * 60_000;
/** How long the Machines view says a client came by an update swap. */
const SWAPPED_SHOWN_MS = 24 * 60 * 60_000;

/**
 * Whether a job at work rides its client's restart (issue #2738): its executor watches it again once the machine's link is
 * back (issue #752, `reattach`), and its agent started in its pane — herdr's own unit, which the client's restart leaves
 * running. A job still starting sends calls a dropped link fails; a print-mode turn runs in the client's own process.
 */
export const ridesClientRestart = (job: Job | undefined, executor: Executor | undefined): boolean =>
  job?.status === 'running' && job.linkLost === undefined && job.executorState !== undefined && job.agentSession !== undefined
    && executor?.reattach !== undefined && executor.canReattach !== undefined;

/** Loads of the hopper's release onto a client still on another, before the hopper stops and says so. */
const MAX_LOADS = 3;

/** A machine's loads since its client last ran another release: how many, why the last one failed, and since when (ms) it is behind. */
interface Tries { from: string; loads: number; failed?: string; since: number }

/** What the client said, without the `client <machine>: ` the transport puts first. */
const cause = (e: unknown, machine: string): string => (e instanceof Error ? e.message : String(e)).replace(`client ${machine}: `, '');

export function createClientReleaseKeeper(o: { release: ClientRelease; logger: Logger; now?: () => number }): ClientReleaseKeeper {
  const now = o.now ?? Date.now;
  const said = new Map<string, string>();
  const say = (machine: string, line: string, warn = false): void => {
    if (said.get(machine) === line) return;
    said.set(machine, line);
    if (warn) o.logger.warn(line);
    else o.logger.info(line);
  };
  const ours = o.release.id;
  const tries = new Map<string, Tries>();
  /** Each machine's last update swap: when, and the release it ran before. */
  const swaps = new Map<string, { at: number; from: string }>();
  const iso = (ms: number): string => new Date(ms).toISOString();

  /** A fixed-list client: its list, from its refusal of an empty release; then the bridge to the hopper's. */
  async function loadBridge(t: ClientTransport, running: string): Promise<void> {
    const names = await loadClientRelease(t, { id: '', files: {} }).then(
      () => undefined,
      (e: unknown) => (e instanceof ClientError ? fixedNamesOf(e.message) : undefined),
    );
    if (!names) throw new Error(`it runs release ${running}, an older release that can't load the hopper's, and names no file list to bridge it`);
    try {
      await loadClientRelease(t, bridgeRelease(o.release, names));
    } catch (e) {
      throw new Error(`it runs release ${running}, an older release that can't load the hopper's, and refused the bridge: ${cause(e, t.machine)}`, { cause: e });
    }
    say(t.machine, `hopper: client ${t.machine}: runs release ${running}, which checks a fixed file list: loaded the bridge to release ${ours}; it restarts twice to run it`);
  }

  /** Loads the hopper's release (the bridge to it for a fixed-list client); a failure is kept for the probe that says it. */
  async function load(t: ClientTransport, tried: Tries, running: string, manifest: boolean, swapped?: string): Promise<void> {
    tried.loads += 1;
    try {
      if (manifest) {
        await loadClientRelease(t, o.release);
        say(t.machine, swapped ?? `hopper: client ${t.machine}: loaded release ${ours} (was ${running}); it restarts to run it`, swapped !== undefined);
      } else {
        await loadBridge(t, running);
      }
      tried.failed = undefined;
    } catch (e) {
      tried.failed = e instanceof ClientError ? `its client runs release ${running} and refused the hopper's release: ${cause(e, t.machine)}` : cause(e, t.machine);
      say(t.machine, `hopper: client ${t.machine}: loading release ${ours} failed: ${tried.failed}`, true);
    }
  }

  return async (t, jobs, atWork = jobs, rides = () => false) => {
    if (!(await probeClient(t))) return { online: false };
    let answer: Awaited<ReturnType<typeof clientRunningRelease>>;
    try {
      answer = await clientRunningRelease(t, jobs());
    } catch (e) {
      say(t.machine, `hopper: client ${t.machine} runs no client release (${(e as Error).message}): add it again with Add machine`, true);
      return { online: true, client: { current: false } };
    }
    for (const s of answer.isolationStops ?? []) o.logger.warn(`hopper: client ${t.machine}: stopped job ${s.jobId} at ${s.at}, cut off from the hopper for ${Math.round(s.cutOffMs / 1000)} s`);
    const running = answer.release;
    const vault = { ...(answer.vault ? { vault: answer.vault } : {}), ...(answer.door ? { door: answer.door } : {}) };
    const home = { ...(answer.home ? { home: answer.home } : {}), ...(answer.disk ? { disk: answer.disk } : {}), ...(answer.resources ? { resources: answer.resources } : {}), ...(answer.infraCredentials ? { infraCredentials: answer.infraCredentials } : {}) };
    if (running === ours) {
      tries.delete(t.machine);
      say(t.machine, `hopper: client ${t.machine}: runs the hopper's release ${ours}`);
      const swap = swaps.get(t.machine);
      const swapped = swap && now() - swap.at < SWAPPED_SHOWN_MS ? { swapped: { at: iso(swap.at), from: swap.from } } : {};
      return { online: true, client: { release: running, current: true, ...swapped, ...vault }, ...home };
    }
    let tried = tries.get(t.machine);
    if (tried?.from !== running) tries.set(t.machine, tried = { from: running, loads: 0, since: tried?.since ?? now() });
    if (tried.loads >= MAX_LOADS) {
      const problem = tried.failed ?? `its client still runs release ${running} after ${tried.loads} loads of the hopper's ${ours}: whatever runs it did not start the new files`;
      say(t.machine, `hopper: client ${t.machine}: cannot update: ${problem}; reinstall it (Machines shows the line)`, true);
      return { online: true, client: { release: running, current: false, update: { problem }, ...vault }, ...home };
    }
    const working = atWork();
    if (working.length === 0) {
      await load(t, tried, running, answer.manifest === true);
      return { online: true, client: { release: running, current: false, ...vault }, ...home };
    }
    const since = iso(tried.since), behind = now() - tried.since;
    const waitsOn = working.filter((id) => !rides(id));
    const pendingLoad = { since, atWork: working, holdsAt: iso(tried.since + CLIENT_UPDATE_HOLD_MS), swapsAt: iso(tried.since + CLIENT_UPDATE_SWAP_MS), ...(behind >= CLIENT_UPDATE_SWAP_MS ? { waitsOn } : {}) };
    if (behind >= CLIENT_UPDATE_SWAP_MS && waitsOn.length === 0) {
      // The update swap (issue #2738): the client restarts under the jobs at work; each is held through the link's drop and watched again.
      swaps.set(t.machine, { at: now(), from: running });
      await load(t, tried, running, answer.manifest === true, `hopper: client ${t.machine}: swapped in release ${ours} while ${working.length} job${working.length === 1 ? ' is' : 's are'} at work there (behind since ${since}, was ${running}); each rides its client's restart`);
      return { online: true, client: { release: running, current: false, pendingLoad, ...vault }, ...home };
    }
    if (behind < CLIENT_UPDATE_HOLD_MS) {
      say(t.machine, `hopper: client ${t.machine}: runs release ${running}, the hopper's is ${ours}; loading it once no job is at work there`);
      return { online: true, client: { release: running, current: false, pendingLoad, ...vault }, ...home };
    }
    say(t.machine, behind < CLIENT_UPDATE_SWAP_MS
      ? `hopper: client ${t.machine}: runs release ${running} since ${since}, the hopper's is ${ours}; no new job goes there until the jobs at work end and it is loaded`
      : `hopper: client ${t.machine}: runs release ${running} since ${since}, the hopper's is ${ours}; the update swap waits on ${waitsOn.join(', ')}, which do not ride a client restart`);
    return { online: true, client: { release: running, current: false, updateHold: { since }, pendingLoad, ...vault }, ...home };
  };
}

/**
 * A client target online on the hopper's release makes its work tree there (issue #361); one on another
 * release is not asked: the keeper loads the hopper's onto it first. A check that fails is what is wrong.
 */
export async function withClientWorkTree(t: ClientTransport, workTree: string | undefined, p: MachineProbe): Promise<MachineProbe> {
  if (!p.online || p.client?.current !== true) return p;
  const found = await clientWorkTree(t, workTree ?? DEFAULT_WORK_TREE)
    .catch((e: unknown) => ({ workTreeProblem: `its work tree could not be checked: ${e instanceof Error ? e.message : String(e)}` }));
  return { ...p, ...found };
}
