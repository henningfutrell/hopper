// The hopper keeps every client target on its own client release (design.md "Client releases",
// issue #70). Each probe of a client target asks the client which release it runs; when it is not the
// hopper's, the hopper loads its release onto it through the signed tunnel and the client restarts to
// run it. Never while a job runs on that machine: a running job's herdr calls must not meet a client
// that is restarting. A client older than releases answers no release: it stays online and is
// reported once, for attach-client.sh to install again. Each line is logged once per machine.
import type { ClientRelease } from '../client/release.ts';
import { clientRunningRelease, loadClientRelease, type ClientTransport } from '../executors/client.ts';
import { probeClient, type MachineProbe } from './attached.ts';

interface Logger { info(line: string): void; warn(line: string): void }

export type ClientReleaseKeeper = (t: ClientTransport, busy: () => boolean) => Promise<MachineProbe>;

export function createClientReleaseKeeper(o: { release: ClientRelease; logger: Logger }): ClientReleaseKeeper {
  const said = new Map<string, string>();
  const say = (machine: string, line: string, warn = false): void => {
    if (said.get(machine) === line) return;
    said.set(machine, line);
    if (warn) o.logger.warn(line);
    else o.logger.info(line);
  };
  const ours = o.release.id;
  return async (t, busy) => {
    if (!(await probeClient(t))) return { online: false };
    let running: string;
    try {
      running = await clientRunningRelease(t);
    } catch (e) {
      say(t.machine, `hopper: client ${t.machine} runs no client release (${(e as Error).message}): install it again with scripts/attach-client.sh`, true);
      return { online: true, client: { current: false } };
    }
    if (running === ours) {
      say(t.machine, `hopper: client ${t.machine}: runs the hopper's release ${ours}`);
      return { online: true, client: { release: running, current: true } };
    }
    if (busy()) {
      say(t.machine, `hopper: client ${t.machine}: runs release ${running}, the hopper's is ${ours}; loading it once no job runs there`);
    } else {
      try {
        await loadClientRelease(t, o.release);
        say(t.machine, `hopper: client ${t.machine}: loaded release ${ours} (was ${running}); it restarts to run it`);
      } catch (e) {
        say(t.machine, `hopper: client ${t.machine}: loading release ${ours} failed: ${(e as Error).message}`, true);
      }
    }
    return { online: true, client: { release: running, current: false } };
  };
}
