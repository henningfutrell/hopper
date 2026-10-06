// The Machines view's part of the plugin host (design.md "Machines from the UI", issues #18, #74):
// what GET /api/machines/config reports, and attaching an ssh target or adding this machine (issue #260) — written by attached-edit.ts,
// then the plugins config reloaded, so the machines follow it without a restart.
import type { ConfigRecords } from '../domain/ports.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HostKeyOffer, HostKeyOfferOutcome, InstanceSpec, MachineDefaults, MachineDefaultsEdit, MachineEdit, MachineEditOutcome, MachinesConfig } from '../domain/types.ts';
import { isPlainTarget, type SshAuth } from '../executors/ssh.ts';
import { hostKeyOffer, isThisMachine, readSshTargets, resolveSshTarget, type ResolvedTarget } from '../machines/index.ts';
import { applyMachineDefaultsEdit, applyMachineEdit, IN_A_CONTAINER, machineDefaults } from './attached-edit.ts';
import type { PluginLogger } from './sdk.ts';

/** What attaching or removing a machine needs. Defaults: ~/.ssh/config, the target resolved over ssh, no job in use. */
export interface AttachedEditOptions {
  sshConfig?: string;
  /** How the hopper authenticates to an ssh target (design.md "Target authentication"). */
  sshAuth?: () => SshAuth;
  /** A new ssh target's pinned host key (`hostKey`: the one confirmed) and, when it runs herdr, herdr's path; default: resolveSshTarget with `sshAuth`. */
  resolveTarget?(ssh: string, o: { herdr: boolean; hostKey?: string }): Promise<ResolvedTarget>;
  /** The host key a new ssh target would be pinned to, for the person to confirm (issue #293); default hostKeyOffer. */
  hostKeyOffer?(ssh: string): Promise<HostKeyOffer>;
  /** The hopper's own public ssh key (issue #293), to add to a machine's authorized_keys; absent: none to show. */
  publicKey?(): string | undefined;
  /** Jobs that need the machine (busy lanes there, panes parked there): a removal is refused while any do. */
  inUse?(name: string): string[];
  /** Jobs not ended that are pinned to the machine (`spec.machineId`): a rename is refused while any are (issue #205). */
  pinned?(name: string): string[];
  /** Starts this machine's herdr session when it is added (issue #260); rejects with the reason. Default: none started. */
  startSession?(session: string): Promise<unknown>;
  /** Whether this host may be a machine (`HOPPER_LOCAL_MACHINE`); default true. False: the container (issues #141, #275). */
  localMachine?: boolean;
  /** Whether an ssh target is this machine (issue #275); default isThisMachine, through the user's ssh config. */
  isThisMachine?(ssh: string): Promise<boolean>;
}

/** How long an ssh target's answer to "is it this machine" is kept (issue #275). */
const THIS_MACHINE_TTL_MS = 60000;

export function createMachinesEditor(o: AttachedEditOptions & {
  config: ConfigRecords;
  dataDir: string;
  logger: PluginLogger;
  /** What the plugins config names now: the machine sources, the executor instances and the machine defaults set. */
  configured(): { machines: InstanceSpec[]; executors: InstanceSpec[]; machineDefaults: Partial<MachineDefaults> };
  /** The machine options of a plugin (`.meta({ machine: true })`): a part that names no machine runs on this machine once it is added. */
  machineOptionsOf(plugin: string): string[];
  version(): string;
  error(): string | undefined;
  reload(): Promise<void>;
}) {
  const sshConfig = o.sshConfig ?? join(homedir(), '.ssh', 'config');
  const noKey = (): SshAuth => { throw new Error('no ssh key on this machine'); };
  const resolveTarget = o.resolveTarget ?? ((ssh: string, r: { herdr: boolean; hostKey?: string }) => resolveSshTarget({
    target: ssh, herdr: r.herdr, controlDir: join(o.dataDir, 'ssh'), auth: o.sshAuth ?? noKey, ...(r.hostKey !== undefined ? { hostKey: r.hostKey } : {}),
  }));
  const offer = o.hostKeyOffer ?? ((ssh: string) => hostKeyOffer({ target: ssh }));

  const localMachine = o.localMachine ?? true;
  // The Machines view asks every 15 s; a target's answer is kept a minute, as ssh -G's is.
  const known = new Map<string, { at: number; here: Promise<boolean> }>();
  const thisMachine = o.isThisMachine ?? ((ssh: string) => {
    const hit = known.get(ssh);
    if (hit && Date.now() - hit.at < THIS_MACHINE_TTL_MS) return hit.here;
    const here = isThisMachine(ssh);
    known.set(ssh, { at: Date.now(), here });
    return here;
  });

  async function config(): Promise<MachinesConfig> {
    const c = o.configured();
    const error = o.error();
    const ssh = readSshTargets(sshConfig);
    // In the container no target is this machine: its addresses are the container's, not the computer's.
    const here = localMachine ? (await Promise.all(ssh.targets.map(async (t) => ((await thisMachine(t)) ? [t] : [])))).flat() : [];
    const publicKey = o.publicKey?.();
    return {
      version: o.version(), ...(error ? { error } : {}), ...(localMachine ? {} : { thisMachineRefused: IN_A_CONTAINER }),
      machines: c.machines.map(({ name, plugin, options }) => ({ name, connection: plugin, ...(options ? { options } : {}) })), executors: c.executors.map((x) => x.name), defaults: machineDefaults(c.machineDefaults),
      ssh: { ...ssh, here, ...(publicKey ? { publicKey } : {}) },
    };
  }

  /** POST /ui/api/machines/host-key (issue #293): the key a detected or typed target would be pinned to; nothing written. */
  async function hostKey(ssh: string): Promise<HostKeyOfferOutcome> {
    if (!readSshTargets(sshConfig).targets.includes(ssh) && !isPlainTarget(ssh)) {
      return { ok: false, code: 'invalid', error: `ssh target ${JSON.stringify(ssh)} is not a Host alias in ~/.ssh/config, nor a plain [user@]host` };
    }
    try {
      return { ok: true, offer: await offer(ssh) };
    } catch (err) {
      return { ok: false, code: 'conflict', error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function edit(e: MachineEdit): Promise<MachineEditOutcome> {
    const c = o.configured();
    const r = await applyMachineEdit(e, {
      config: o.config, configured: c.machines.map((instance) => ({ role: 'machine-source' as const, instance })), executors: c.executors,
      defaults: machineDefaults(c.machineDefaults), sshTargets: () => readSshTargets(sshConfig), resolveTarget,
      startSession: o.startSession ?? (async () => undefined), machineOptionsOf: o.machineOptionsOf,
      localMachine, isThisMachine: thisMachine,
    });
    if (!r.ok) return r;
    if (r.changed) {
      await o.reload();
      const added = o.configured().machines.find((m) => m.name === e.name);
      o.logger.info(added?.plugin === 'local'
        ? `hopper: plugins config edited in the UI: this machine added as ${e.name}${e.ssh ? ` (ssh target ${e.ssh} is this machine)` : ''}, herdr session ${e.session ?? 'hopper'}`
        : `hopper: plugins config edited in the UI: attached machine ${e.name} over ssh ${e.ssh}`);
    }
    return { ok: true, config: await config() };
  }

  async function editDefaults(e: MachineDefaultsEdit): Promise<MachineEditOutcome> {
    const r = applyMachineDefaultsEdit(e, o.config, o.configured().executors);
    if (!r.ok) return { ok: false, code: r.code === 'not_found' ? 'invalid' : r.code, error: r.error };
    o.logger.info(`hopper: plugins config edited in the UI: machine defaults ${e.lanes} lane(s), executors ${e.executors.join(', ') || 'none'}`);
    await o.reload();
    return { ok: true, config: await config() };
  }

  return { config, edit, editDefaults, hostKey };
}
