// An attached machine: another host that runs jobs in its own herdr session, reached over ssh
// (design.md "Attached machines"). Online while that session answers. The probe runs in the
// background, at most once per `probeEveryMs`; list() never waits for it, so a machine that is off
// or asleep never stalls a Decision. Offline until the first probe says otherwise. The set follows
// plugins.yaml without a restart (issue #18): createAttachedMachines reads it on every list().
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { Clock, MachineSource } from '../domain/ports.ts';
import type { AttachedMachine } from '../domain/types.ts';
import { SSH_FAILED, createHerdrCliClient, scrubbedEnv, sshArgv } from '../executors/herdr/index.ts';

const PROBE_EVERY_MS = 30000;

interface Logger { info(line: string): void; warn(line: string): void }

interface AttachedOptions {
  clock?: Clock;
  probeEveryMs?: number;
  logger?: Logger;
}

/** One attached machine. `machine()` is read on every list(), so lanes, executors and label apply at once. */
export function createAttachedMachineSource(o: AttachedOptions & {
  machine: () => AttachedMachine;
  probe: () => Promise<boolean>;
}): MachineSource {
  const name = o.machine().name;
  const target = (): string => o.machine().ssh;
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
      (up) => { online = up; say(up ? `job-hopper: attached machine ${name} online (ssh ${target()})` : `job-hopper: attached machine ${name} offline: its herdr session is not running`); },
      (e: unknown) => { online = false; say(`job-hopper: attached machine ${name} offline: ${e instanceof Error ? e.message : String(e)}`); },
    ).finally(() => { inFlight = false; });
  }

  return {
    async list() {
      probe();
      const m = o.machine();
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

/**
 * Every attached machine plugins.yaml names now, in its order. A machine keeps what its probe knows
 * while only its lanes, executors or label change; another ssh target, herdr binary or session is
 * another machine (probed afresh). A removed machine is dropped and logged.
 */
export function createAttachedMachines(o: AttachedOptions & {
  machines: () => AttachedMachine[];
  probe: (machine: AttachedMachine) => Promise<boolean>;
}): MachineSource {
  const known = new Map<string, { source: MachineSource; current: AttachedMachine }>();
  const identity = (m: AttachedMachine): string => JSON.stringify([m.name, m.ssh, m.herdrBin, m.session]);
  return {
    async list() {
      const now = o.machines();
      const keep = new Set(now.map(identity));
      for (const [key, e] of known) {
        if (keep.has(key)) continue;
        known.delete(key);
        if (!now.some((m) => m.name === e.current.name)) o.logger?.info(`job-hopper: attached machine ${e.current.name} removed`);
      }
      const sources = now.map((m) => {
        const key = identity(m);
        let e = known.get(key);
        if (!e) {
          const fresh = { current: m } as { source: MachineSource; current: AttachedMachine };
          fresh.source = createAttachedMachineSource({ ...o, machine: () => fresh.current, probe: () => o.probe(fresh.current) });
          known.set(key, (e = fresh));
        }
        e.current = m;
        return e.source;
      });
      return (await Promise.all(sources.map((s) => s.list()))).flat();
    },
  };
}

/**
 * The absolute path of herdr on an attached machine (issue #18: the UI never sends it): what
 * `command -v herdr` says in a login shell there, else `~/.local/bin/herdr` when it is executable.
 * Same ssh client as every herdr call. Rejects with the reason.
 */
export function resolveHerdrBinOverSsh(o: { target: string; controlDir: string; sshBin?: string; timeoutMs?: number }): Promise<string> {
  if (!o.target || o.target.startsWith('-')) return Promise.reject(new Error(`bad ssh target: ${o.target}`));
  mkdirSync(o.controlDir, { recursive: true, mode: 0o700 });
  const command = [
    `p=$("$SHELL" -lc 'command -v herdr' 2>/dev/null </dev/null | tail -n 1)`,
    'case "$p" in /*) printf \'%s\\n\' "$p"; exit 0;; esac',
    'if [ -x "$HOME/.local/bin/herdr" ]; then printf \'%s\\n\' "$HOME/.local/bin/herdr"; exit 0; fi',
    "echo 'herdr not found: not on the login PATH, not in ~/.local/bin' >&2; exit 3",
  ].join('; ');
  return new Promise((resolve, reject) => {
    execFile(o.sshBin ?? 'ssh', sshArgv({ target: o.target, controlDir: o.controlDir }, command), {
      env: scrubbedEnv(), timeout: o.timeoutMs ?? 15000, killSignal: 'SIGKILL', encoding: 'utf8',
    }, (err, stdout, stderr) => {
      const e = err as (Error & { killed?: boolean; code?: number | string }) | null;
      if (e?.killed) return reject(new Error(`ssh ${o.target}: no answer within ${o.timeoutMs ?? 15000} ms`));
      if (e && e.code === SSH_FAILED) return reject(new Error(`ssh ${o.target}: ${stderr.trim() || e.message}`));
      if (e) return reject(new Error(`${o.target}: ${stderr.trim() || e.message}`));
      const path = stdout.trim().split('\n').at(-1) ?? '';
      if (!/^\/[^\s]+$/.test(path)) return reject(new Error(`${o.target}: herdr path is not absolute: ${JSON.stringify(path)}`));
      resolve(path);
    });
  });
}
