// An attached machine: another host that runs jobs in its own herdr session, reached over ssh
// (design.md "Attached machines"), or a container target reached over docker exec that only runs
// commands (issue #58, "Container targets"). Online while that session answers, or that container runs. The probe runs in the
// background, at most once per `probeEveryMs`; list() never waits for it, so a machine that is off
// or asleep never stalls a Decision. Offline until the first probe says otherwise. Each is a
// machine-source instance (issue #74), reached through createTargetPool.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Clock, MachineSource } from '../domain/ports.ts';
import type { AttachedMachine, HostKeyOffer, MachineSnapshot } from '../domain/types.ts';
import { dockerArgv, dockerEnv } from '../executors/docker.ts';
import { scrubbedEnv } from '../executors/env.ts';
import type { ClientTransport } from '../executors/client.ts';
import { createHerdrCliClient } from '../executors/herdr/index.ts';
import { REMOTE_PATH, SSH_FAILED, isPlainTarget, resolveDestination, sshArgv, type SshAuth, HOST_KEY } from '../executors/ssh.ts';

const PROBE_EVERY_MS = 30000;

interface Logger { info(line: string): void; warn(line: string): void }

/** What one probe of an attached machine found: online or not, and for a client target, its client release. */
export interface MachineProbe {
  online: boolean;
  /** A client target: the release its client runs (absent when it predates releases), and whether it is the hopper's. */
  client?: { release?: string; current: boolean };
  /** The machine's home, where `~` in a job's work tree resolves there (issue #323). Absent: it did not say. */
  home?: string;
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
  /** When the machine last reached the hopper itself (a client target dialling in, issue #308): a later one is probed at once. */
  reachedAt?: () => number;
}): MachineSource {
  const name = o.machine().name;
  const reached = (): string => {
    const m = o.machine();
    return 'docker' in m ? `docker ${m.docker}` : 'client' in m ? 'client, dialled in' : `ssh ${m.ssh}`;
  };
  const down = (): string => {
    const m = o.machine();
    return 'docker' in m ? 'its container is not running' : 'ssh' in m && !m.herdr ? 'it does not answer over ssh' : 'its herdr session is not running';
  };
  const now = (): number => (o.clock ? o.clock.now().getTime() : Date.now());
  const every = o.probeEveryMs ?? PROBE_EVERY_MS;
  let online = false;
  let clientRelease: MachineProbe['client'];
  // Kept across probes that do not say: a machine's home does not move while it is the same machine.
  let home: string | undefined;
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
    if (inFlight || (now() - lastProbe < every && !((o.reachedAt?.() ?? 0) > lastProbe))) return;
    inFlight = true;
    lastProbe = now();
    o.probe().then(
      (p) => { online = p.online; clientRelease = p.online ? p.client : undefined; home = p.home ?? home; const up = p.online; say(up ? `hopper: attached machine ${name} online (${reached()})` : `hopper: attached machine ${name} offline: ${down()}`); },
      (e: unknown) => { online = false; clientRelease = undefined; say(`hopper: attached machine ${name} offline: ${e instanceof Error ? e.message : String(e)}`); },
    ).finally(() => { inFlight = false; });
  }

  return {
    async list() {
      probe();
      const m = o.machine();
      const base: MachineSnapshot = { id: m.name, label: m.label ?? m.name, maxLanes: m.lanes, online, executors: [...m.executors], ...(m.workTree !== undefined ? { workTree: m.workTree } : {}), ...(home ? { home } : {}) };
      if ('docker' in m) return [{ ...base, docker: m.docker }];
      if ('client' in m) return [{ ...base, client: { ...clientRelease } }];
      return [{ ...base, ssh: m.ssh, ...(m.herdr ? { herdr: { session: m.session } } : {}) }];
    },
  };
}

/** Whether the machine's herdr session is running: `herdr --session <s> status server` over ssh. Rejects when ssh fails. */
export async function probeHerdrOverSsh(o: { target: string; session: string; controlDir: string; sshBin?: string; auth: () => SshAuth }): Promise<boolean> {
  const herdr = createHerdrCliClient({
    session: o.session, timeoutMs: 15000,
    ssh: { target: o.target, controlDir: o.controlDir, auth: o.auth, ...(o.sshBin ? { bin: o.sshBin } : {}) },
  });
  return /^status: running$/m.test(await herdr.exec(['status', 'server']));
}

/**
 * An ssh target's home, asked over ssh with the hopper's key: it answers, so it is online (issue #142),
 * and `~` in a job's work tree resolves there, never in the hopper's own home (issue #323). Rejects when
 * ssh fails or the answer is not an absolute path.
 */
export function probeSsh(o: { target: string; controlDir: string; sshBin?: string; auth: () => SshAuth; timeoutMs?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    let argv: string[];
    try {
      mkdirSync(o.controlDir, { recursive: true, mode: 0o700 });
      argv = sshArgv({ target: o.target, controlDir: o.controlDir, auth: o.auth, ...(o.sshBin ? { bin: o.sshBin } : {}) }, `printf '%s\\n' "$HOME"`);
    } catch (e) {
      return reject(e instanceof Error ? e : new Error(String(e)));
    }
    execFile(o.sshBin ?? 'ssh', argv, { env: scrubbedEnv(), timeout: o.timeoutMs ?? 15000, killSignal: 'SIGKILL', encoding: 'utf8' }, (err, stdout, stderr) => {
      const e = err as (Error & { killed?: boolean; code?: number | string }) | null;
      if (!e) {
        const home = stdout.trim().split('\n').at(-1) ?? '';
        return home.startsWith('/') ? resolve(home) : reject(new Error(`${o.target}: its home is not an absolute path: ${JSON.stringify(home)}`));
      }
      if (e.killed) return reject(new Error(`ssh ${o.target}: no answer within ${o.timeoutMs ?? 15000} ms`));
      reject(new Error(`ssh ${o.target}: ${stderr.trim() || e.message}`));
    });
  });
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
 * How the hopper reaches its attached machines (issue #74: the machine-source context's `target`): one
 * source per machine. A machine keeps its source — and what its probe knows — while only its lanes,
 * executors or label change; another ssh target, session, container or machine key is
 * another machine, probed afresh.
 */
export function createTargetPool(o: AttachedOptions & {
  probe: (machine: AttachedMachine) => Promise<MachineProbe>;
  /** When a machine last reached the hopper itself (createAttachedMachineSource's `reachedAt`). */
  reachedAt?: (machine: AttachedMachine) => number;
}): (machine: AttachedMachine) => MachineSource {
  const known = new Map<string, { source: MachineSource; current: AttachedMachine }>();
  const identity = (m: AttachedMachine): string => JSON.stringify('docker' in m ? [m.name, 'docker', m.docker]
    : 'client' in m ? [m.name, 'client', m.client.key] : [m.name, m.ssh, m.herdr, m.session]);
  return (m) => {
    const key = identity(m);
    let e = known.get(key);
    if (!e) {
      const fresh = { current: m } as { source: MachineSource; current: AttachedMachine };
      const { reachedAt, ...rest } = o;
      fresh.source = createAttachedMachineSource({
        ...rest, machine: () => fresh.current, probe: () => o.probe(fresh.current), ...(reachedAt ? { reachedAt: () => reachedAt(fresh.current) } : {}),
      });
      known.set(key, (e = fresh));
    }
    e.current = m;
    return e.source;
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
      reject(new Error(`no host key for ${o.target} (${host}) in ~/.ssh/known_hosts: check the host key it presents, then confirm it when adding it`));
    });
  });
}

/** A host key's fingerprint as `ssh-keygen -l` prints it: `SHA256:` and the base64 of the key's SHA-256, unpadded. */
export function hostKeyFingerprint(hostKey: string): string {
  const blob = Buffer.from(hostKey.split(' ')[1] ?? '', 'base64');
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/**
 * The host keys a target presents (issue #293): `ssh-keyscan` on its resolved host and port, an
 * ed25519 key first. Only offered, with its fingerprint, for the person to confirm: the hopper pins it
 * only once they send it back. Rejects when the target presents none.
 */
export function scanHostKey(o: { target: string; sshBin?: string; keyscanBin?: string; timeoutMs?: number }): Promise<string> {
  let d;
  try {
    d = resolveDestination(o.sshBin ?? 'ssh', o.target);
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  const host = d.hostname;
  return new Promise((resolve, reject) => {
    execFile(o.keyscanBin ?? 'ssh-keyscan', ['-T', '5', '-p', d.port, '-t', 'ed25519,ecdsa,rsa', '--', host], {
      env: scrubbedEnv(), timeout: o.timeoutMs ?? 15000, killSignal: 'SIGKILL', encoding: 'utf8',
    }, (err, stdout) => {
      const keys = (stdout ?? '').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/).slice(1, 3).join(' ')).filter((k) => HOST_KEY.test(k));
      const key = keys.find((k) => k.startsWith('ssh-ed25519 ')) ?? keys[0];
      if (key) return resolve(key);
      reject(new Error(`${o.target} (${host} port ${d.port}) presented no host key${err ? `: ${(err as Error).message.split('\n')[0]}` : ''}; is its sshd running and reachable from the hopper?`));
    });
  });
}

/**
 * The host key a new ssh target would be pinned to (issue #293): the one ~/.ssh/known_hosts holds for it
 * (`known`), else the one it presents now (scanHostKey), with its fingerprint for the person to confirm.
 */
export async function hostKeyOffer(o: { target: string; sshBin?: string; keygenBin?: string; keyscanBin?: string; knownHosts?: string }): Promise<HostKeyOffer> {
  if (!isPlainTarget(o.target)) throw new Error(`bad ssh target: ${JSON.stringify(o.target)}`);
  let hostKey: string;
  let known = true;
  try {
    hostKey = await knownHostKey(o);
  } catch (e) {
    if (/ProxyJump|ProxyCommand|ssh -G/.test((e as Error).message)) throw e;
    hostKey = await scanHostKey(o);
    known = false;
  }
  return { ssh: o.target, hostKey, fingerprint: hostKeyFingerprint(hostKey), known };
}

/** A new ssh target as resolved: its pinned host key. */
export interface ResolvedTarget { hostKey: string }

/**
 * Adding an ssh target from the UI (issues #18, #59): its pinned host key (knownHostKey), and, when it
 * is to run herdr, that every herdr call there will find herdr — by name, as `REMOTE_PATH` finds it
 * (issue #311): nothing is stored of where — asked over the same authenticated connection as every
 * herdr call, trusting only that host key. Without herdr (issue #142) the connection is still made, so a
 * machine the hopper cannot reach is not added. Rejects with the reason.
 */
export async function resolveSshTarget(o: {
  target: string; herdr: boolean; controlDir: string; auth: () => SshAuth; sshBin?: string; keygenBin?: string; knownHosts?: string; timeoutMs?: number;
  /** The host key the person confirmed (issue #293); absent: the one ~/.ssh/known_hosts holds. */
  hostKey?: string;
}): Promise<ResolvedTarget> {
  mkdirSync(o.controlDir, { recursive: true, mode: 0o700 });
  if (o.hostKey !== undefined && !HOST_KEY.test(o.hostKey)) throw new Error(`not a host key: ${JSON.stringify(o.hostKey)}`);
  const hostKey = o.hostKey ?? await knownHostKey(o);
  const pinned = join(o.controlDir, `known_hosts.add-${randomBytes(6).toString('hex')}`);
  writeFileSync(pinned, `${o.target} ${hostKey}\n`, { mode: 0o600 });
  const command = o.herdr
    ? `${REMOTE_PATH}; command -v herdr >/dev/null || { echo 'herdr not found: not on its PATH, not in ~/.local/bin' >&2; exit 3; }`
    : 'true';
  try {
    const argv = sshArgv({ target: o.target, ...(o.sshBin ? { bin: o.sshBin } : {}), auth: () => ({ ...o.auth(), knownHostsFile: pinned }) }, command);
    await new Promise<void>((resolve, reject) => {
      execFile(o.sshBin ?? 'ssh', argv, {
        env: scrubbedEnv(), timeout: o.timeoutMs ?? 15000, killSignal: 'SIGKILL', encoding: 'utf8',
      }, (err, stdout, stderr) => {
        const e = err as (Error & { killed?: boolean; code?: number | string }) | null;
        if (e?.killed) return reject(new Error(`ssh ${o.target}: no answer within ${o.timeoutMs ?? 15000} ms`));
        if (e && e.code === SSH_FAILED && /Permission denied/.test(stderr)) {
          return reject(new Error(`${o.target} does not accept the hopper's ssh key: add the hopper's public key, shown in the Add machine form, to ~/.ssh/authorized_keys there`));
        }
        if (e && e.code === SSH_FAILED) return reject(new Error(`ssh ${o.target}: ${stderr.trim() || e.message}`));
        if (e) return reject(new Error(`${o.target}: ${stderr.trim() || e.message}`));
        resolve();
      });
    });
    return { hostKey };
  } finally {
    rmSync(pinned, { force: true });
  }
}
