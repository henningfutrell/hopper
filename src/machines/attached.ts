// An attached machine: another host that runs jobs in its own herdr session, reached over ssh
// (design.md "Attached machines"), or a container target that only runs commands, each in a one-shot sandbox box (issues
// #58, #865, "Container targets"). Online while that session answers, or while a box can start for it. The probe runs in the
// background, at most once per `probeEveryMs`; list() never waits for it, so a machine that is off
// or asleep never stalls a Decision. Offline until the first probe says otherwise. Each is a
// machine-source instance (issue #74), reached through createTargetPool. An address problem a probe found while the
// hopper's own event loop was held (issue #2427) is not taken: the machine keeps what it had, and is probed again.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Clock, MachineSource } from '../domain/ports.ts';
import type { AttachedMachine, HerdrVersions, HostKeyOffer, MachineSnapshot } from '../domain/types.ts';
import type { DiskReading, PendingLoad, UpdateSwap } from '../domain/machines.ts';
import type { ResourceReading } from '../domain/machine-history.ts';
import { DF_COMMAND, judged, readDf } from './disk.ts';
import { RESOURCES_COMMAND, readOomKills, readResources } from './resources.ts';
import { oomWatch, type OomCount } from '../client/resources.ts';
import { INFRA_CREDENTIALS_COMMAND, isInfraCredentialsLine, readInfraCredentials } from '../client/infra-credentials.ts';
import { scrubbedEnv } from '../executors/env.ts';
import type { ClientTransport } from '../executors/client.ts';
import { HerdrError, createHerdrCliClient } from '../executors/herdr/index.ts';
import { herdrMismatch, readHerdrStatus } from './herdr-version.ts';
import { REMOTE_PATH, SSH_FAILED, isPlainTarget, resolveDestination, shellQuote, sshArgv, type SshAuth, HOST_KEY } from '../executors/ssh.ts';
import { DEFAULT_WORK_TREE, resolveWorkTree } from '../client/work-tree.ts';
import { isAddressLine, addressCommand, networkFix, readAddress, type WslAddress } from './hopper-address.ts';
import { loopHeldDoubts } from '../domain/loop-held.ts';

const PROBE_EVERY_MS = 30000;

interface Logger { info(line: string): void; warn(line: string): void }

/** What one probe of an attached machine found: online or not, and for a client target, its client release. */
export interface MachineProbe {
  online: boolean;
  /**
   * A client target: the release its client runs (absent when it predates releases), whether it is the hopper's, why it cannot be updated (issue #545), since when it
   * holds jobs off to be updated (issue #2715), what the load of the hopper's release waits on, and when it came by an update swap (issue #2738).
   */
  client?: { release?: string; current: boolean; update?: { problem: string }; updateHold?: { since: string }; pendingLoad?: PendingLoad; swapped?: UpdateSwap };
  /** The machine's home, where `~` in a job's work tree resolves there (issue #323). Absent: it did not say. */
  home?: string;
  /** The disk its home is on (issue #401). Absent: not read. */
  disk?: DiskReading;
  /** Its CPU, memory and swap (issue #560). Absent: not read. */
  resources?: ResourceReading;
  /** An ssh target: its OOM kill count (issue #2499 part 13), which the machine compares with its probe before. Absent: not read. */
  oomKills?: OomCount;
  /** The infra credentials its job user holds (issues #1128 part 7, #1248): any makes it not ready. Absent: not read. */
  infraCredentials?: string[];
  /** Why its work tree cannot be made usable (issue #361). Absent: it was made, or the probe could not say. */
  workTreeProblem?: string;
  /** An ssh target: the hopper's address it reaches (issue #698). Absent: not asked, or none reached. */
  hopperUrl?: string;
  /** An ssh target: why its jobs cannot reach the hopper (issue #698). Absent: one is reached, or not asked. */
  addressProblem?: string;
  /** An ssh target running herdr: its herdr client and server versions (issue #741). Absent: not read. */
  herdr?: HerdrVersions;
  /** An ssh target running herdr: why its herdr client cannot work with its herdr server (issue #741). */
  herdrProblem?: string;
}

interface AttachedOptions {
  clock?: Clock;
  probeEveryMs?: number;
  logger?: Logger;
  /** Why a box of this template takes no new job now (issue #602), or undefined when the template is approved. Read at every list(). */
  templateWait?: (template: string) => string | undefined;
  /** The hopper's network (issue #711): a machine off it is given the command that joins it. Absent or `host`: none. */
  network?: string;
  /** Whether the client target holding this machine key is leaving (issue #1284): it takes no new job. Read at every list(). */
  leaving?: (key: string) => boolean;
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
    return 'image' in m ? `one-shot sandbox boxes of ${m.image}` : 'client' in m ? 'client, dialled in' : `ssh ${m.ssh}`;
  };
  const down = (): string => {
    const m = o.machine();
    return 'image' in m ? 'no sandbox box can start for it now' : 'ssh' in m && !m.herdr ? 'it does not answer over ssh' : 'its herdr session is not running';
  };
  const now = (): number => (o.clock ? o.clock.now().getTime() : Date.now());
  const every = o.probeEveryMs ?? PROBE_EVERY_MS;
  let online = false;
  let clientRelease: MachineProbe['client'];
  // Kept across probes that do not say: a machine's home does not move while it is the same machine.
  let home: string | undefined;
  // Only the last probe's: a disk fills.
  let disk: DiskReading | undefined;
  // Only the last probe's, as the disk: a machine offline has none. Its last OOM kill is kept across probes (issue #2499 part 13).
  let resources: ResourceReading | undefined;
  const kills = oomWatch();
  // Only the last probe's (issue #1128 part 7): a folder may be removed between probes.
  let infraCredentials: string[] | undefined;
  // What the last probe found wrong with its work tree (issue #361); each probe says afresh.
  let workTreeProblem: string | undefined;
  // Where its jobs reach the hopper, or why they cannot (issue #698); each probe says afresh.
  let hopperUrl: string | undefined;
  let addressProblem: string | undefined;
  // Its herdr client and server, and why they cannot work together (issue #741); each probe says afresh.
  let herdr: HerdrVersions | undefined;
  let herdrProblem: string | undefined;
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
    const from = Date.now();
    o.probe().then(
      (p) => {
        online = p.online; clientRelease = p.online ? p.client : undefined; home = p.home ?? home; disk = p.disk; const killAt = kills(p.online ? p.oomKills : undefined, now()); resources = p.online && p.resources ? { ...p.resources, ...(killAt !== undefined && !p.resources.memOomKillAt ? { memOomKillAt: new Date(killAt).toISOString() } : {}) } : undefined; infraCredentials = p.online ? p.infraCredentials : undefined; workTreeProblem = p.online ? p.workTreeProblem : undefined;
        // Its address check waited on the hopper's own held loop (issue #2427): no proof. Kept as it was; probed again.
        const doubted = p.online && p.addressProblem !== undefined && loopHeldDoubts(from);
        if (doubted) lastProbe = -Infinity;
        else { hopperUrl = p.online ? p.hopperUrl : undefined; addressProblem = p.online ? p.addressProblem : undefined; }
        herdr = p.online ? p.herdr : undefined; herdrProblem = p.online ? p.herdrProblem : undefined;
        const noJob = [workTreeProblem, addressProblem, herdrProblem].filter((x) => x !== undefined).join('; ');
        say(!p.online ? `hopper: attached machine ${name} offline: ${down()}`
          : noJob ? `hopper: attached machine ${name} online (${reached()}), takes no new job: ${noJob}` : `hopper: attached machine ${name} online (${reached()})`);
      },
      (e: unknown) => { online = false; clientRelease = undefined; disk = undefined; resources = undefined; infraCredentials = undefined; workTreeProblem = undefined; hopperUrl = undefined; addressProblem = undefined; herdr = undefined; herdrProblem = undefined; say(`hopper: attached machine ${name} offline: ${e instanceof Error ? e.message : String(e)}`); },
    ).finally(() => { inFlight = false; });
  }

  return {
    async list() {
      probe();
      const m = o.machine();
      const base: MachineSnapshot = { id: m.name, label: m.label ?? m.name, maxLanes: m.lanes, ...(m.reservedLanes !== undefined ? { reservedLanes: m.reservedLanes } : {}), ...(m.elbowIns !== undefined ? { elbowIns: m.elbowIns } : {}), ...(m.windows ? { windows: true as const } : {}), ...(m.usageLimits ? { usageLimits: { ...m.usageLimits } } : {}), online, executors: [...m.executors], ...(m.workTree !== undefined ? { workTree: m.workTree } : {}), ...(m.workTrees !== undefined ? { workTrees: { ...m.workTrees } } : {}), ...(home ? { home } : {}), ...(disk ? { disk: judged(disk, 'image' in m ? undefined : m.diskLow) } : {}), ...('image' in m || !m.diskLow ? {} : { diskThresholds: { ...m.diskLow } }), ...(resources ? { resources } : {}), ...(infraCredentials ? { infraCredentials: [...infraCredentials] } : {}), ...('image' in m || !m.sweep ? {} : { sweep: { ...m.sweep } }), ...('image' in m || !m.memoryFloor ? {} : { memoryFloor: { ...m.memoryFloor } }), ...('image' in m || !m.jobLimits ? {} : { jobLimits: { ...m.jobLimits } }), ...(workTreeProblem ? { workTreeProblem } : {}) };
      if ('image' in m) return [{ ...base, containerImage: m.image }];
      if ('client' in m) {
        const name = m.client.template;
        // Fails closed: with no way to read the template's approval, its box takes no job.
        const waiting = name === undefined ? undefined : o.templateWait ? o.templateWait(name) : `waiting for template approval: the approval of ${name} cannot be read`;
        return [{ ...base, client: { ...clientRelease }, ...(o.leaving?.(m.client.key) ? { leaving: true as const } : {}), ...(name !== undefined ? { template: { name, ...(waiting !== undefined ? { waiting } : {}) } } : {}) }];
      }
      return [{ ...base, ssh: m.ssh, ...(m.herdr ? { herdr: { session: m.session, ...herdr } } : {}), ...(m.herdr && herdrProblem ? { herdrProblem } : {}), ...(hopperUrl ? { hopperUrl } : {}), ...(addressProblem ? { addressProblem, ...withFix(networkFix(m.ssh, o.network)) } : {}) }];
    },
  };
}

const withFix = (addressFix: string | undefined): { addressFix?: string } => (addressFix ? { addressFix } : {});

/**
 * Whether the machine's herdr session is running — `herdr --session <s> status server` over ssh —, and (issue #741) the
 * herdr client the hopper calls there and the server it talks to, with a herdr problem when the server does not take
 * that client: then every job start there would fail. `status client` that fails says no client version, nothing more.
 * Rejects when ssh fails.
 */
export async function probeHerdrOverSsh(o: { target: string; session: string; controlDir: string; sshBin?: string; auth: () => SshAuth }): Promise<HerdrProbe> {
  const herdr = createHerdrCliClient({
    session: o.session, timeoutMs: 15000,
    ssh: { target: o.target, controlDir: o.controlDir, auth: o.auth, ...(o.sshBin ? { bin: o.sshBin } : {}) },
  });
  let server: string;
  try {
    server = await herdr.exec(['status', 'server']);
  } catch (e) {
    const herdrProblem = e instanceof HerdrError ? herdrMismatch(e.message) : undefined;
    if (herdrProblem) return { online: true, herdrProblem };
    throw e;
  }
  const client = await herdr.exec(['status', 'client']).catch((e: unknown) => {
    if (e instanceof HerdrError && e.code === 'ssh') throw e;
    return undefined;
  });
  const r = readHerdrStatus(server, client);
  return { online: r.running, ...(Object.keys(r.versions).length ? { herdr: r.versions } : {}), ...(r.herdrProblem ? { herdrProblem: r.herdrProblem } : {}) };
}

/** What probeHerdrOverSsh found (issue #741): the session running, the herdr versions there, and a herdr problem. */
export type HerdrProbe = Pick<MachineProbe, 'online' | 'herdr' | 'herdrProblem'>;

/**
 * An ssh target's home, asked over ssh with the hopper's key: it answers, so it is online (issue #142),
 * and `~` in a job's work tree resolves there, never in the hopper's own home (issue #323). In the same
 * call its work tree (the jobs directory when it names none) is made there, and what is wrong with it said
 * (issue #361): the home or above it, or a directory that cannot be made or written. Rejects when ssh
 * fails or the answer is not an absolute home. A session with no HOME (seen on a WSL machine, issue #1154) takes its
 * user's home from the user database; the home comes on a line of its own (`hopper-home`), so a line a shell's startup
 * file prints first is not taken for it. With it, the disk the home is on (issue #401), when its df says,
 * its CPU, memory and swap (issue #560), when it has /proc, and the infra credentials its job user holds (issues #1128 part 7, #1248).
 */
export function probeSsh(o: {
  target: string; controlDir: string; sshBin?: string; auth: () => SshAuth; timeoutMs?: number; workTree?: string;
  /** The hopper's addresses (issue #698): which one the machine reaches is asked in the same call. Absent: not asked. */
  hopperUrls?: readonly string[];
  /** The address a WSL machine on the hopper's computer reaches it at (issue #1248 part 4): asked after the others, only there. */
  wsl?: WslAddress;
}): Promise<{ home: string; disk?: DiskReading; resources?: ResourceReading; oomKills?: OomCount; infraCredentials?: string[]; workTreeProblem?: string; hopperUrl?: string; addressProblem?: string }> {
  const workTree = o.workTree ?? DEFAULT_WORK_TREE;
  // `~` as "$HOME" there; the path itself never reaches the shell unquoted.
  const there = workTree === '~' || workTree.startsWith('~/') ? `"$HOME"${shellQuote(workTree.slice(1))}` : shellQuote(workTree);
  const command = `${HOME_COMMAND}; ${DF_COMMAND}; ${RESOURCES_COMMAND}; ${INFRA_CREDENTIALS_COMMAND}; ${o.hopperUrls ? `${addressCommand(o.hopperUrls, o.wsl)}; ` : ''}w=${there}; if out=$(mkdir -p -- "$w" 2>&1); then if [ -w "$w" ]; then echo ${WORK_TREE_OK}; else echo "$w is not writable"; echo ${WORK_TREE_UNUSABLE}; fi;`
    + ` else printf '%s\\n' "$out"; echo ${WORK_TREE_UNUSABLE}; fi`;
  // Each address asked takes at most 3 s more.
  const timeoutMs = o.timeoutMs ?? 15000 + 3500 * ((o.hopperUrls?.length ?? 0) + (o.wsl ? 1 : 0));
  return new Promise((resolve, reject) => {
    let argv: string[];
    try {
      mkdirSync(o.controlDir, { recursive: true, mode: 0o700 });
      argv = sshArgv({ target: o.target, controlDir: o.controlDir, auth: o.auth, ...(o.sshBin ? { bin: o.sshBin } : {}) }, command);
    } catch (e) {
      return reject(e instanceof Error ? e : new Error(String(e)));
    }
    execFile(o.sshBin ?? 'ssh', argv, { env: scrubbedEnv(), timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8' }, (err, stdout, stderr) => {
      const e = err as (Error & { killed?: boolean; code?: number | string }) | null;
      if (!e) {
        const lines = stdout.trim().split('\n');
        const home = lines.find((l) => l.startsWith(HOME_LINE))?.slice(HOME_LINE.length) ?? '';
        if (!home.startsWith('/')) return reject(new Error(`${o.target}: its home is not an absolute path: ${JSON.stringify(home)}${home ? '' : ' (its session has no HOME, and its user database names none)'}`));
        const disk = readDf(stdout);
        const resources = readResources(stdout), oomKills = resources ? readOomKills(stdout) : undefined;
        const infraCredentials = readInfraCredentials(stdout);
        const found = { home, ...(disk ? { disk } : {}), ...(resources ? { resources } : {}), ...(oomKills ? { oomKills } : {}), ...(infraCredentials ? { infraCredentials } : {}), ...(o.hopperUrls ? readAddress(stdout, o.hopperUrls, o.wsl?.url) : {}) };
        const refused = resolveWorkTree(workTree, home);
        if ('problem' in refused) return resolve({ ...found, workTreeProblem: refused.problem });
        if (lines.at(-1) === WORK_TREE_OK) return resolve(found);
        const said = lines.slice(0, -1).filter((l) => !l.startsWith(HOME_LINE) && !l.startsWith('hopper-disk ') && !l.startsWith('hopper-res ') && !isInfraCredentialsLine(l) && !isAddressLine(l)).join(' ').trim() || 'no answer';
        return resolve({ ...found, workTreeProblem: `its work tree ${workTree} cannot be made: ${said}` });
      }
      if (e.killed) return reject(new Error(`ssh ${o.target}: no answer within ${timeoutMs} ms`));
      reject(new Error(`ssh ${o.target}: ${stderr.trim() || e.message}`));
    });
  });
}

/** The line the home is printed on. */
const HOME_LINE = 'hopper-home ';
/** The machine's home: HOME, else its user's from the user database (a session with no HOME, issue #1154), set for the rest of the command. */
const HOME_COMMAND = `[ -n "$HOME" ] || HOME=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6); printf '${HOME_LINE}%s\\n' "$HOME"`;

/** What the work tree check prints last: made and writable, or not. */
const WORK_TREE_OK = 'hopper-work-tree-ok';
const WORK_TREE_UNUSABLE = 'hopper-work-tree-unusable';

/** Whether a client target's herdr session runs: `status server` through its tunnel, signed. Rejects when the client cannot be reached or does not prove itself. */
export async function probeClient(t: ClientTransport): Promise<boolean> {
  return /^status: running$/m.test(await createHerdrCliClient({ client: t, timeoutMs: 15000 }).exec(['status', 'server']));
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
  const identity = (m: AttachedMachine): string => JSON.stringify('image' in m ? [m.name, 'container', m.image]
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
