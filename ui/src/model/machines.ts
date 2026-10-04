// The Machines view's model (design.md "Machines from the UI", issue #18): which machine is this one
// and which are attached (with their plugins.yaml entry), why an Add form may not be sent yet, and
// the bodies POST /ui/api/machines takes. herdrBin and session are never part of a body.
import type { AttachedMachine, MachineEdit, MachinesConfig } from '../../../src/domain/types.ts';

/** The local plugin's default lane count. */
const DEFAULT_LANES = 4;

export type MachineKind =
  | { kind: 'local'; lanes: number }
  | { kind: 'attached'; entry: AttachedMachine }
  | { kind: 'unknown' };

export function kindOf(config: MachinesConfig | null, id: string): MachineKind {
  if (!config) return { kind: 'unknown' };
  if (config.machine.name === id) {
    const lanes = config.machine.options?.lanes;
    return { kind: 'local', lanes: typeof lanes === 'number' ? lanes : DEFAULT_LANES };
  }
  const entry = config.attached.find((m) => m.name === id);
  return entry ? { kind: 'attached', entry } : { kind: 'unknown' };
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
  if (name === 'local' || name === config.machine.name) return `${name} is this machine; pick another name`;
  if (config.attached.some((m) => m.name === name)) return `${name} is already attached`;
  if (!config.ssh.targets.includes(d.ssh)) return 'pick an ssh target from ~/.ssh/config';
  if (lanesOf(d.lanes) === undefined) return 'lanes must be a whole number, at least 1';
  return null;
}

export function addBody(d: MachineDraft, version: string): MachineEdit {
  const label = d.label.trim();
  return {
    action: 'add', name: d.name.trim(), ssh: d.ssh, lanes: lanesOf(d.lanes) ?? 0, executors: [...d.executors],
    ...(label ? { label } : {}), version,
  };
}

/** Only what changed; null when nothing did. A cleared label is null: back to the name. */
export function editBody(entry: AttachedMachine, d: MachineEditDraft, version: string): MachineEdit | null {
  const lanes = lanesOf(d.lanes) ?? 0;
  const label = d.label.trim();
  const sameExecutors = d.executors.length === entry.executors.length && d.executors.every((x) => entry.executors.includes(x));
  const body: Extract<MachineEdit, { action: 'edit' }> = { action: 'edit', name: entry.name, version };
  if (lanes !== entry.lanes) body.lanes = lanes;
  if (!sameExecutors) body.executors = [...d.executors];
  if (label !== (entry.label ?? '')) body.label = label || null;
  return Object.keys(body).length > 3 ? body : null;
}
