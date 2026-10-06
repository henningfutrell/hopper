// The Machines view's part of the plugin host (design.md "Machines from the UI", issues #18, #74):
// what GET /api/machines/config reports, and attaching an ssh target — written by attached-edit.ts,
// then the plugins config reloaded, so the machines follow it without a restart.
import type { ConfigRecords } from '../domain/ports.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InstanceSpec, MachineDefaults, MachineDefaultsEdit, MachineEdit, MachineEditOutcome, MachinesConfig } from '../domain/types.ts';
import type { SshAuth } from '../executors/ssh.ts';
import { readSshTargets, resolveSshTarget, type ResolvedTarget } from '../machines/index.ts';
import { applyMachineDefaultsEdit, applyMachineEdit, machineDefaults } from './attached-edit.ts';
import type { PluginLogger } from './sdk.ts';

/** What attaching or removing a machine needs. Defaults: ~/.ssh/config, the target resolved over ssh, no job in use. */
export interface AttachedEditOptions {
  sshConfig?: string;
  /** How the hopper authenticates to an ssh target (design.md "Target authentication"). */
  sshAuth?: () => SshAuth;
  /** A new ssh target's pinned host key and, when it runs herdr, herdr's path; default: resolveSshTarget with `sshAuth`. */
  resolveTarget?(ssh: string, o: { herdr: boolean }): Promise<ResolvedTarget>;
  /** Jobs that need the machine (busy lanes there, panes parked there): a removal is refused while any do. */
  inUse?(name: string): string[];
  /** Jobs not ended that are pinned to the machine (`spec.machineId`): a rename is refused while any are (issue #205). */
  pinned?(name: string): string[];
}

export function createMachinesEditor(o: AttachedEditOptions & {
  config: ConfigRecords;
  dataDir: string;
  logger: PluginLogger;
  /** What the plugins config names now: the machine sources, the executor instances and the machine defaults set. */
  configured(): { machines: InstanceSpec[]; executors: InstanceSpec[]; machineDefaults: Partial<MachineDefaults> };
  version(): string;
  error(): string | undefined;
  reload(): Promise<void>;
}) {
  const sshConfig = o.sshConfig ?? join(homedir(), '.ssh', 'config');
  const noKey = (): SshAuth => { throw new Error('no ssh key for the hopper'); };
  const resolveTarget = o.resolveTarget ?? ((ssh: string, r: { herdr: boolean }) => resolveSshTarget({ target: ssh, herdr: r.herdr, controlDir: join(o.dataDir, 'ssh'), auth: o.sshAuth ?? noKey }));

  function config(): MachinesConfig {
    const c = o.configured();
    const error = o.error();
    return {
      version: o.version(), ...(error ? { error } : {}),
      machines: c.machines.map(({ name, plugin, options }) => ({ name, connection: plugin, ...(options ? { options } : {}) })), executors: c.executors.map((x) => x.name), defaults: machineDefaults(c.machineDefaults), ssh: readSshTargets(sshConfig),
    };
  }

  async function edit(e: MachineEdit): Promise<MachineEditOutcome> {
    const c = o.configured();
    const r = await applyMachineEdit(e, {
      config: o.config, configured: c.machines.map((instance) => ({ role: 'machine-source' as const, instance })), executors: c.executors,
      defaults: machineDefaults(c.machineDefaults), sshTargets: () => readSshTargets(sshConfig), resolveTarget,
    });
    if (!r.ok) return r;
    if (r.changed) {
      o.logger.info(`hopper: plugins config edited in the UI: attached machine ${e.name} over ssh ${e.ssh}`);
      await o.reload();
    }
    return { ok: true, config: config() };
  }

  async function editDefaults(e: MachineDefaultsEdit): Promise<MachineEditOutcome> {
    const r = applyMachineDefaultsEdit(e, o.config, o.configured().executors);
    if (!r.ok) return { ok: false, code: r.code === 'not_found' ? 'invalid' : r.code, error: r.error };
    o.logger.info(`hopper: plugins config edited in the UI: machine defaults ${e.lanes} lane(s), executors ${e.executors.join(', ') || 'none'}`);
    await o.reload();
    return { ok: true, config: config() };
  }

  return { config, edit, editDefaults };
}
