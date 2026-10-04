// The attached machines in the plugin host (design.md "Machines from the UI", issue #18): what GET
// /api/machines/config reports, and a machine edit — written by attached-edit.ts, then plugins.yaml
// reloaded, so the machines follow it without a restart.
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AttachedMachine, InstanceSpec, MachineEdit, MachineEditOutcome, MachinesConfig } from '../domain/types.ts';
import { readSshTargets, resolveHerdrBinOverSsh } from '../machines/index.ts';
import { applyMachineEdit } from './attached-edit.ts';
import type { PluginLogger } from './sdk.ts';

/** What a machine edit needs. Defaults: ~/.ssh/config, herdr resolved over ssh, no job in use. */
export interface AttachedEditOptions {
  sshConfig?: string;
  resolveHerdrBin?(ssh: string): Promise<string>;
  /** Jobs that need the machine (busy lanes there, panes parked there): a removal is refused while any do. */
  inUse?(name: string): string[];
}

export function createMachinesEditor(o: AttachedEditOptions & {
  pluginsFile: string;
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
  const resolveHerdrBin = o.resolveHerdrBin ?? ((ssh: string) => resolveHerdrBinOverSsh({ target: ssh, controlDir: join(o.dataDir, 'ssh') }));
  const inUse = o.inUse ?? (() => []);

  function config(): MachinesConfig {
    const c = o.configured();
    const error = o.error();
    return {
      path: o.pluginsFile, version: o.version(), ...(error ? { error } : {}),
      machine: c.machines, attached: o.attached(), executors: c.executors.map((x) => x.name), ssh: readSshTargets(sshConfig),
    };
  }

  async function edit(e: MachineEdit): Promise<MachineEditOutcome> {
    const c = o.configured();
    const r = await applyMachineEdit(e, {
      path: o.pluginsFile, machineName: c.machines.name, executors: c.executors.map((x) => x.name),
      sshTargets: () => readSshTargets(sshConfig), resolveHerdrBin, inUse,
    });
    if (!r.ok) return r;
    if (r.changed) {
      o.logger.info(`job-hopper: plugins.yaml edited in the UI: ${e.action} attached machine ${e.name}`);
      await o.reload();
    }
    return { ok: true, config: config() };
  }

  return { config, edit };
}
