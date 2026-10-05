// An attached machine: another host that runs jobs in its own herdr session, reached over ssh
// (design.md "Attached machines"), or a container target reached over docker exec that only runs
// commands (issue #58, "Container targets"). Online while that session answers, or that container runs. The probe runs in the
// background, at most once per `probeEveryMs`; list() never waits for it, so a machine that is off
// or asleep never stalls a Decision. Offline until the first probe says otherwise. The set follows
// plugins.yaml without a restart (issue #18): createAttachedMachines reads it on every list().
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Clock, MachineSource } from '../domain/ports.ts';
import type { AttachedMachine, MachineSnapshot } from '../domain/types.ts';
import { dockerArgv, dockerEnv } from '../executors/docker.ts';
import { scrubbedEnv } from '../executors/env.ts';
import type { ClientTransport } from '../executors/client.ts';
import { createHerdrCliClient } from '../executors/herdr/index.ts';
import { SSH_FAILED, resolveDestination, sshArgv, type SshAuth, HOST_KEY } from '../executors/ssh.ts';

const PROBE_EVERY_MS = 30000;

interface Logger { info(line: string): void; warn(line: string): void }

/** What one probe of an attached machine found: online or not, and for a client target, its client release. */
export interface MachineProbe {
  online: boolean;
  /** A client target: the release its client runs (absent when it predates releases), and whether it is the hopper's. */
  client?: { release?: string; current: boolean };
}

interface AttachedOptions {
  clock?: Clock;
  probeEveryMs?: number;
  logger?: Logger;
}

/** One attached machine. `machine()` is read on every list(), so lanes, executors and label apply at once. */
export function createAttachedMachineSource(o: AttachedOptions & {
  machine: () => AttachedMachine;
  probe: () => Promise<MachineProbe>;
}): MachineSource {
  const name = o.machine().name;
  const reached = (): string => {
    const m = o.machine();
    return 'docker' in m ? `docker ${m.docker}` : 'client' in m ? 'client, over its reverse tunnel' : `ssh ${m.ssh}`;
  };
  const down = (): string => ('docker' in o.machine() ? 'its container is not running' : 'its herdr session is not running');
  const now = (): number => (o.clock ? o.clock.now().getTime() : Date.now());
  const every = o.probeEveryMs ?? PROBE_EVERY_MS;
  let online = false;
  let clientRelease: MachineProbe['client'];
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
      (p) => { online = p.online; clientRelease = p.online ? p.client : undefined; const up = p.online; say(up ? `hopper: attached machine ${name} online (${reached()})` : `hopper: attached machine ${name} offline: ${down()}`); },
      (e: unknown) => { online = false; clientRelease = undefined; say(`hopper: attached machine ${name} offline: ${e instanceof Error ? e.message : String(e)}`); },
    ).finally(() => { inFlight = false; });
  }

  return {
    async list() {
      probe();
      const m = o.machine();
      const base: MachineSnapshot = { id: m.name, label: m.label ?? m.name, maxLanes: m.lanes, online, executors: [...m.executors] };
      if ('docker' in m) return [{ ...base, docker: m.docker }];
      if ('client' in m) return [{ ...base, client: { tokenEnv: m.client.tokenEnv, ...clientRelease } }];
      return [{ ...base, ssh: m.ssh, herdr: { bin: m.herdrBin, session: m.session } }];
    },
  };
}

/** Whether the machine's herdr session is running: `herdr --session <s> status server` over ssh. Rejects when ssh fails. */
export async function probeHerdrOverSsh(o: { target: string; herdrBin: string; session: string; controlDir: string; sshBin?: string; auth: () => SshAuth }): Promise<boolean> {
  const herdr = createHerdrCliClient({
    bin: o.herdrBin, session: o.session, timeoutMs: 15000,
    ssh: { target: o.target, controlDir: o.controlDir, auth: o.auth, ...(o.sshBin ? { bin: o.sshBin } : {}) },
  });
  return /^status: running$/m.test(await herdr.exec(['status', 'server']));
}

/** Whether a client target's herdr session runs: `status server` through its tunnel, signed. Rejects when the client cannot be reached or does not prove itself. */
export async function probeClient(t: ClientTransport): Promise<boolean> {
  return /^status: running$/m.test(await createHerdrCliClient({ client: t, timeoutMs: 15000 }).exec(['status', 'server']));
}

/**
 * Whether a container target runs: `docker container inspect` says it is running. A missing container
 * is not. Only through the docker socket the hopper may open (design.md "Target authentication").
 */
export function probeContainer(o: { container: string; dockerHost: () => string; dockerBin?: string; timeoutMs?: number }): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let args: string[];
    try {
      args = dockerArgv(o.dockerHost(), ['container', 'inspect', '--format', '{{.State.Running}}', '--', o.container]);
    } catch (e) {
      return reject(e instanceof Error ? e : new Error(String(e)));
    }
    execFile(o.dockerBin ?? 'docker', args, {
      env: dockerEnv(), timeout: o.timeoutMs ?? 15000, killSignal: 'SIGKILL', encoding: 'utf8',
    }, (err, stdout, stderr) => {
      const e = err as (Error & { killed?: boolean; code?: number | string }) | null;
      if (e?.killed) return reject(new Error(`docker: no answer within ${o.timeoutMs ?? 15000} ms`));
      if (e && typeof e.code !== 'number') return reject(new Error(`docker: ${e.message}`));
      if (e) return /No such container/i.test(stderr) ? resolve(false) : reject(new Error(`docker: ${stderr.trim() || e.message}`));
      resolve(stdout.trim() === 'true');
    });
  });
}

/**
 * Every attached machine plugins.yaml names now, in its order. A machine keeps what its probe knows
 * while only its lanes, executors or label change; another ssh target, herdr binary, session or container
 * is another machine (probed afresh). A removed machine is dropped and logged.
 */
export function createAttachedMachines(o: AttachedOptions & {
  machines: () => AttachedMachine[];
  probe: (machine: AttachedMachine) => Promise<MachineProbe>;
}): MachineSource {
  const known = new Map<string, { source: MachineSource; current: AttachedMachine }>();
  const identity = (m: AttachedMachine): string => JSON.stringify('docker' in m ? [m.name, 'docker', m.docker]
    : 'client' in m ? [m.name, 'client', m.client.tokenEnv] : [m.name, m.ssh, m.herdrBin, m.session]);
  return {
    async list() {
      const now = o.machines();
      const keep = new Set(now.map(identity));
      for (const [key, e] of known) {
        if (keep.has(key)) continue;
        known.delete(key);
        if (!now.some((m) => m.name === e.current.name)) o.logger?.info(`hopper: attached machine ${e.current.name} removed`);
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
 * The host key a target is pinned to when the UI adds it (issue #59): the one the user's own
 * ~/.ssh/known_hosts already trusts for its resolved host (an ed25519 key first). Never learned from
 * the connection itself. Rejects when the user has never connected to it.
 */
export function knownHostKey(o: { target: string; sshBin?: string; keygenBin?: string; knownHosts?: string }): Promise<string> {
  let host: string;
  try {
    const d = resolveDestination(o.sshBin ?? 'ssh', o.target);
    host = d.port === '22' ? d.hostname : `[${d.hostname}]:${d.port}`;
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  const file = o.knownHosts ?? join(homedir(), '.ssh', 'known_hosts');
  return new Promise((resolve, reject) => {
    execFile(o.keygenBin ?? 'ssh-keygen', ['-F', host, '-f', file], { env: scrubbedEnv(), timeout: 10000, encoding: 'utf8' }, (err, stdout) => {
      const keys = (err ? '' : stdout).split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/).slice(1, 3).join(' '));
      const key = keys.find((k) => k.startsWith('ssh-ed25519 ')) ?? keys.find((k) => HOST_KEY.test(k));
      if (key && HOST_KEY.test(key)) return resolve(key);
      reject(new Error(`no host key for ${o.target} (${host}) in ~/.ssh/known_hosts: connect once by hand (ssh ${o.target}), check its fingerprint, then add it`));
    });
  });
}

/**
 * Adding an ssh target from the UI (issues #18, #59): its pinned host key (knownHostKey) and the
 * absolute path of herdr there — what `command -v herdr` says in a login shell, else
 * `~/.local/bin/herdr` when it is executable — asked over the same authenticated connection as every
 * herdr call, trusting only that host key. Rejects with the reason.
 */
export async function resolveSshTarget(o: {
  target: string; controlDir: string; auth: () => SshAuth; sshBin?: string; keygenBin?: string; knownHosts?: string; timeoutMs?: number;
}): Promise<{ herdrBin: string; hostKey: string }> {
  mkdirSync(o.controlDir, { recursive: true, mode: 0o700 });
  const hostKey = await knownHostKey(o);
  const pinned = join(o.controlDir, `known_hosts.add-${randomBytes(6).toString('hex')}`);
  writeFileSync(pinned, `${o.target} ${hostKey}\n`, { mode: 0o600 });
  const command = [
    `p=$("$SHELL" -lc 'command -v herdr' 2>/dev/null </dev/null | tail -n 1)`,
    'case "$p" in /*) printf \'%s\\n\' "$p"; exit 0;; esac',
    'if [ -x "$HOME/.local/bin/herdr" ]; then printf \'%s\\n\' "$HOME/.local/bin/herdr"; exit 0; fi',
    "echo 'herdr not found: not on the login PATH, not in ~/.local/bin' >&2; exit 3",
  ].join('; ');
  try {
    const argv = sshArgv({ target: o.target, ...(o.sshBin ? { bin: o.sshBin } : {}), auth: () => ({ ...o.auth(), knownHostsFile: pinned }) }, command);
    const herdrBin = await new Promise<string>((resolve, reject) => {
      execFile(o.sshBin ?? 'ssh', argv, {
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
    return { herdrBin, hostKey };
  } finally {
    rmSync(pinned, { force: true });
  }
}
