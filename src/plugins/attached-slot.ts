// The attached machines in the plugin host (design.md "Machines from the UI", issue #18): what GET
// /api/machines/config reports, and a machine edit — written by attached-edit.ts, then plugins.yaml
// reloaded, so the machines follow it without a restart.
import type { ConfigDocuments } from '../domain/ports.ts';
import { PLUGINS } from './plugins-file.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AttachedMachine, InstanceSpec, MachineEdit, MachineEditOutcome, MachinesConfig } from '../domain/types.ts';
import type { SshAuth } from '../executors/ssh.ts';
import { readSshTargets, resolveSshTarget } from '../machines/index.ts';
import { applyMachineEdit } from './attached-edit.ts';
import type { PluginLogger } from './sdk.ts';

/** What a machine edit needs. Defaults: ~/.ssh/config, the target resolved over ssh, no job in use. */
export interface AttachedEditOptions {
  sshConfig?: string;
  /** How the hopper authenticates to an ssh target (design.md "Target authentication"). */
  sshAuth?: () => SshAuth;
  /** A new ssh target's pinned host key and herdr path; default: resolveSshTarget with `sshAuth`. */
  resolveTarget?(ssh: string): Promise<{ herdrBin: string; hostKey: string }>;
  /** Jobs that need the machine (busy lanes there, panes parked there): a removal is refused while any do. */
  inUse?(name: string): string[];
}

export function createMachinesEditor(o: AttachedEditOptions & {
  documents: ConfigDocuments;
  dataDir: string;
  logger: PluginLogger;
  /** What plugins.yaml names now: the machine source and the executor instances. */
  configured(): { machines: InstanceSpec; executors: InstanceSpec[] };
  attached(): AttachedMachine[];
  version(): string;
  error(): string | undefined;
  reload(): Promise<void>;
}) {
  const sshConfig = o.sshConfig ?? join(homedir(), '.ssh', 'config');
  const noKey = (): SshAuth => { throw new Error('no ssh key for the hopper'); };
  const resolveTarget = o.resolveTarget ?? ((ssh: string) => resolveSshTarget({ target: ssh, controlDir: join(o.dataDir, 'ssh'), auth: o.sshAuth ?? noKey }));
  const inUse = o.inUse ?? (() => []);

  function config(): MachinesConfig {
    const c = o.configured();
    const error = o.error();
    return {
      document: PLUGINS, version: o.version(), ...(error ? { error } : {}),
      machine: c.machines, attached: o.attached(), executors: c.executors.map((x) => x.name), ssh: readSshTargets(sshConfig),
    };
  }

  async function edit(e: MachineEdit): Promise<MachineEditOutcome> {
    const c = o.configured();
    const r = await applyMachineEdit(e, {
      documents: o.documents, machineName: c.machines.name, executors: c.executors.map((x) => x.name),
      sshTargets: () => readSshTargets(sshConfig), resolveTarget, inUse,
    });
    if (!r.ok) return r;
    if (r.changed) {
      o.logger.info(`hopper: plugins.yaml edited in the UI: ${e.action} attached machine ${e.name}`);
      await o.reload();
    }
    return { ok: true, config: config() };
  }

  return { config, edit };
}
