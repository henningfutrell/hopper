// The Machines view's model (design.md "Machines from the UI", issues #18, #74): which machine is a
// `local` instance and which an attached one (an instance of `ssh`, `docker` or `client`), why an Add
// form may not be sent yet, the body POST /ui/api/machines takes, and the options edit an Edit form
// sends to POST /ui/api/plugins. herdrBin, session and hostKey are never part of a body.
import type { InstanceSpec, MachineEdit, MachineSnapshot, MachinesConfig, PluginsEdit } from '../../../src/domain/types.ts';

/** The local plugin's default lane count. */
const DEFAULT_LANES = 4;

/** The attached-machine plugins, and the executors each runs when its instance names none. */
const ATTACHED: Record<string, string[]> = { ssh: ['herdr-claude'], docker: ['command'], client: ['herdr-claude'] };

export type MachineKind =
  | { kind: 'local'; instance: InstanceSpec; lanes: number }
  | { kind: 'attached'; instance: InstanceSpec; lanes: number; executors: string[]; label?: string }
  | { kind: 'unknown' };

export function kindOf(config: MachinesConfig | null, id: string): MachineKind {
  const instance = config?.machines.find((m) => m.name === id);
  if (!instance) return { kind: 'unknown' };
  const o = instance.options ?? {};
  if (instance.plugin === 'local') return { kind: 'local', instance, lanes: typeof o.lanes === 'number' ? o.lanes : DEFAULT_LANES };
  const executors = ATTACHED[instance.plugin];
  if (!executors) return { kind: 'unknown' };
  return {
    kind: 'attached', instance, lanes: typeof o.lanes === 'number' ? o.lanes : 1,
    executors: Array.isArray(o.executors) ? (o.executors as string[]) : executors,
    ...(typeof o.label === 'string' ? { label: o.label } : {}),
  };
}

/** An Add form as typed. */
export interface MachineDraft { name: string; ssh: string; lanes: string; executors: string[]; label: string }
/** An Edit form as typed. */
export type MachineEditDraft = Pick<MachineDraft, 'lanes' | 'executors' | 'label'>;

const lanesOf = (s: string): number | undefined => (/^\d+$/.test(s.trim()) && Number(s) >= 1 ? Number(s) : undefined);

/** Why the Add form cannot be sent yet, or null. The daemon checks again. */
export function addProblem(d: MachineDraft, config: MachinesConfig): string | null {
  const name = d.name.trim();
  if (!name) return 'give the machine a name';
  if (config.machines.some((m) => m.name === name)) return `a machine is already named ${name}; pick another name`;
  if (!config.ssh.targets.includes(d.ssh)) return 'pick an ssh target from ~/.ssh/config';
  if (lanesOf(d.lanes) === undefined) return 'lanes must be a whole number, at least 1';
  return null;
}

export function addBody(d: MachineDraft, version: string): MachineEdit {
  const label = d.label.trim();
  return { name: d.name.trim(), ssh: d.ssh, lanes: lanesOf(d.lanes) ?? 0, executors: [...d.executors], ...(label ? { label } : {}), version };
}

/** The instance's whole options with lanes, executors and label as typed (a cleared label goes); null when nothing changed. */
export function editBody(m: Extract<MachineKind, { kind: 'attached' }>, d: MachineEditDraft, version: string): Extract<PluginsEdit, { action: 'options' }> | null {
  const lanes = lanesOf(d.lanes) ?? 0;
  const label = d.label.trim();
  const sameExecutors = d.executors.length === m.executors.length && d.executors.every((x) => m.executors.includes(x));
  if (lanes === m.lanes && sameExecutors && label === (m.label ?? '')) return null;
  const { label: _old, ...rest } = m.instance.options ?? {};
  return {
    action: 'options', role: 'machine-source', name: m.instance.name, version,
    options: { ...rest, lanes, executors: [...d.executors], ...(label ? { label } : {}) },
  };
}

/** A client target's client release, as the Machines view says it (issue #70); null before a probe found it online, or for any other machine. */
export function clientReleaseText(client: MachineSnapshot['client']): string | null {
  if (client?.current === undefined) return null;
  if (!client.release) return 'none: older than releases, install it again (scripts/attach-client.sh)';
  return client.current ? `${client.release} (the hopper's)` : `${client.release} (not the hopper's: loaded once no job runs there)`;
}
