// The hopper keeps every client target on its own client release (design.md "Client releases",
// issues #70, #545). Each probe of a client target asks the client which release it runs; when it is not the
// hopper's, the hopper loads its release onto it down its signed link and the client restarts to
// run it. A client released before manifests checks a fixed list of file names: it gets the bridge to the
// hopper's release instead (client-bridge.ts), its list read from its own refusal of an empty release.
// Never while a job runs on that machine: a running job's herdr calls must not meet a client
// that is restarting. A load that has not taken after three tries is not tried again: the probe says why
// (`client.update.problem`), and Machines shows it with the line that reinstalls the client. A client older
// than releases answers no release: it stays online and is reported once, to be added again with Add machine.
// Each line is logged once per machine.
import type { ClientRelease } from '../client/release.ts';
import { ClientError, clientRunningRelease, clientWorkTree, loadClientRelease, type ClientTransport } from '../executors/client.ts';
import { DEFAULT_WORK_TREE } from '../client/work-tree.ts';
import { probeClient, type MachineProbe } from './attached.ts';
import { bridgeRelease, fixedNamesOf } from './client-bridge.ts';

interface Logger { info(line: string): void; warn(line: string): void }

export type ClientReleaseKeeper = (t: ClientTransport, busy: () => boolean) => Promise<MachineProbe>;

/** Loads of the hopper's release onto a client still on another, before the hopper stops and says so. */
const MAX_LOADS = 3;

/** A machine's loads since its client last ran another release: how many, and why the last one failed. */
interface Tries { from: string; loads: number; failed?: string }

/** What the client said, without the `client <machine>: ` the transport puts first. */
const cause = (e: unknown, machine: string): string => (e instanceof Error ? e.message : String(e)).replace(`client ${machine}: `, '');

export function createClientReleaseKeeper(o: { release: ClientRelease; logger: Logger }): ClientReleaseKeeper {
  const said = new Map<string, string>();
  const say = (machine: string, line: string, warn = false): void => {
    if (said.get(machine) === line) return;
    said.set(machine, line);
    if (warn) o.logger.warn(line);
    else o.logger.info(line);
  };
  const ours = o.release.id;
  const tries = new Map<string, Tries>();

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

  return async (t, busy) => {
    if (!(await probeClient(t))) return { online: false };
    let answer: Awaited<ReturnType<typeof clientRunningRelease>>;
    try {
      answer = await clientRunningRelease(t);
    } catch (e) {
      say(t.machine, `hopper: client ${t.machine} runs no client release (${(e as Error).message}): add it again with Add machine`, true);
      return { online: true, client: { current: false } };
    }
    const running = answer.release;
    const home = { ...(answer.home ? { home: answer.home } : {}), ...(answer.disk ? { disk: answer.disk } : {}) };
    if (running === ours) {
      tries.delete(t.machine);
      say(t.machine, `hopper: client ${t.machine}: runs the hopper's release ${ours}`);
      return { online: true, client: { release: running, current: true }, ...home };
    }
    let tried = tries.get(t.machine);
    if (tried?.from !== running) tries.set(t.machine, tried = { from: running, loads: 0 });
    if (tried.loads >= MAX_LOADS) {
      const problem = tried.failed ?? `its client still runs release ${running} after ${tried.loads} loads of the hopper's ${ours}: whatever runs it did not start the new files`;
      say(t.machine, `hopper: client ${t.machine}: cannot update: ${problem}; reinstall it (Machines shows the line)`, true);
      return { online: true, client: { release: running, current: false, update: { problem } }, ...home };
    }
    if (busy()) {
      say(t.machine, `hopper: client ${t.machine}: runs release ${running}, the hopper's is ${ours}; loading it once no job runs there`);
    } else {
      tried.loads += 1;
      try {
        if (answer.manifest) {
          await loadClientRelease(t, o.release);
          say(t.machine, `hopper: client ${t.machine}: loaded release ${ours} (was ${running}); it restarts to run it`);
        } else {
          await loadBridge(t, running);
        }
        tried.failed = undefined;
      } catch (e) {
        tried.failed = e instanceof ClientError ? `its client runs release ${running} and refused the hopper's release: ${cause(e, t.machine)}` : cause(e, t.machine);
        say(t.machine, `hopper: client ${t.machine}: loading release ${ours} failed: ${tried.failed}`, true);
      }
    }
    return { online: true, client: { release: running, current: false }, ...home };
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
