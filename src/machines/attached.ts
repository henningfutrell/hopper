// An attached machine: another host that runs jobs in its own herdr session, reached over ssh
// (design.md "Attached machines"). Online while that session answers. The probe runs in the
// background, at most once per `probeEveryMs`; list() never waits for it, so a machine that is off
// or asleep never stalls a Decision. Offline until the first probe says otherwise.
import type { Clock, MachineSource } from '../domain/ports.ts';
import type { AttachedMachine } from '../domain/types.ts';
import { createHerdrCliClient } from '../executors/herdr/index.ts';

const PROBE_EVERY_MS = 30000;

interface Logger { info(line: string): void; warn(line: string): void }

export function createAttachedMachineSource(o: {
  machine: AttachedMachine;
  probe: () => Promise<boolean>;
  clock?: Clock;
  probeEveryMs?: number;
  logger?: Logger;
}): MachineSource {
  const m = o.machine;
  const now = (): number => (o.clock ? o.clock.now().getTime() : Date.now());
  const every = o.probeEveryMs ?? PROBE_EVERY_MS;
  let online = false;
  let lastProbe = -Infinity;
  let inFlight = false;
  let said: string | undefined;

  const say = (line: string): void => {
    if (line === said) return;
    said = line;
    if (online) o.logger?.info(line);
    else o.logger?.warn(line);
  };

  function probe(): void {
    if (inFlight || now() - lastProbe < every) return;
    inFlight = true;
    lastProbe = now();
    o.probe().then(
      (up) => { online = up; say(up ? `job-hopper: attached machine ${m.name} online (ssh ${m.ssh})` : `job-hopper: attached machine ${m.name} offline: its herdr session is not running`); },
      (e: unknown) => { online = false; say(`job-hopper: attached machine ${m.name} offline: ${e instanceof Error ? e.message : String(e)}`); },
    ).finally(() => { inFlight = false; });
  }

  return {
    async list() {
      probe();
      return [{
        id: m.name, label: m.label ?? m.name, maxLanes: m.lanes, online, executors: [...m.executors], ssh: m.ssh,
        herdr: { bin: m.herdrBin, session: m.session },
      }];
    },
  };
}

/** Whether the machine's herdr session is running: `herdr --session <s> status server` over ssh. Rejects when ssh fails. */
export async function probeHerdrOverSsh(o: { target: string; herdrBin: string; session: string; controlDir: string; sshBin?: string }): Promise<boolean> {
  const herdr = createHerdrCliClient({
    bin: o.herdrBin, session: o.session, timeoutMs: 15000,
    ssh: { target: o.target, controlDir: o.controlDir, ...(o.sshBin ? { bin: o.sshBin } : {}) },
  });
  return /^status: running$/m.test(await herdr.exec(['status', 'server']));
}
