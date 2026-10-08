// The machine a part that runs claude uses when it names none (issue #442): a claude-cli escalation level
// or the claude-plan usage source in a plugins config written with no machine (issue #259, the container,
// issue #141). Picked as it runs, in a set order, or none — said in plain words, with how to fix it; how
// Settings shows such a part; and the stored plugins config filled where exactly one machine can run it.
// Pure: no I/O.
import type { InstanceSpec, InstanceStatus, MachineSnapshot } from './types.ts';

/**
 * Where a part can run claude. `here-or-ssh`: this machine or an ssh target (claude-cli: a client target
 * serves herdr only, and `docker exec` passes no stdin). `any`: every machine, through its connection (claude-plan).
 */
export type MachineReach = 'here-or-ssh' | 'any';

/** The built-in plugins whose `machine` option names where claude runs, and where each can run it. */
export const RUNS_CLAUDE: Readonly<Record<string, MachineReach>> = { 'claude-cli': 'here-or-ssh', 'claude-plan': 'any' };

/** The machine-source plugins each reach can run claude on. */
const REACHED: Record<MachineReach, ReadonlySet<string>> = {
  'here-or-ssh': new Set(['local', 'ssh']),
  any: new Set(['local', 'ssh', 'docker', 'client']),
};

export const NO_MACHINE_FOR_LEVEL = 'No machine can run claude for this level. Pick a machine for it in Settings → Question gates, '
  + 'attach a machine claude can run on (this one, or one the hopper reaches over ssh), or use an anthropic-api level instead.';

export const NO_MACHINE_FOR_USAGE = 'No machine can run claude for this usage source. Attach a machine, or pick one for it in Settings → Plugins.';

export const WHY_JOB = 'the job\'s machine';
export const WHY_ONLY = 'the only machine that can run claude';
export const WHY_DEFAULT = 'the default escalation machine';

/** Whether claude can run on `m` now. */
export function canRunClaude(reach: MachineReach, m: MachineSnapshot): boolean {
  return m.online && (reach === 'any' || (!m.client && !m.docker));
}

export type MachinePick = { machine: string; why: string } | { none: string };

/** Several machines can, and nothing says which: none is guessed. */
const several = (reach: MachineReach, names: string[]): string => (reach === 'here-or-ssh'
  ? `This level names no machine, and ${names.join(', ')} can run claude: the job's machine cannot, and no default escalation machine is set. `
    + 'Pick a machine for this level, or set the default escalation machine, in Settings → Question gates.'
  : `This usage source names no machine, and ${names.join(', ')} can run claude. Pick one for it in Settings → Plugins.`);

const nothing = (reach: MachineReach): string => (reach === 'here-or-ssh' ? NO_MACHINE_FOR_LEVEL : NO_MACHINE_FOR_USAGE);

/**
 * The machine a part that names none runs on now, and why: the job's machine where claude can run
 * there (a level asked about a job), else the only machine that can, else the default escalation
 * machine (`fallback`, a level's). None: why, and how to fix it.
 */
export function pickMachine(o: { reach: MachineReach; jobMachine?: string; machines: readonly MachineSnapshot[]; fallback?: string }): MachinePick {
  const able = o.machines.filter((m) => canRunClaude(o.reach, m));
  if (o.jobMachine !== undefined && able.some((m) => m.id === o.jobMachine)) return { machine: o.jobMachine, why: WHY_JOB };
  if (able.length === 1) return { machine: able[0]!.id, why: WHY_ONLY };
  if (o.fallback) return { machine: o.fallback, why: WHY_DEFAULT };
  return { none: able.length ? several(o.reach, able.map((m) => m.id)) : nothing(o.reach) };
}

/** How Settings shows a part that names no machine: the one it runs on, if one is certain; flagged when it needs one picked. */
export interface MachineNote { machine?: string; needsMachine: boolean; note: string }

/** From the configured machines, not their state: what the part will do, said in plain words. */
export function machineNote(o: { reach: MachineReach; machines: readonly InstanceSpec[]; fallback?: string }): MachineNote {
  const able = o.machines.filter((m) => REACHED[o.reach].has(m.plugin)).map((m) => m.name);
  if (able.length === 1) return { machine: able[0]!, needsMachine: false, note: `names no machine: runs on ${able[0]}, ${WHY_ONLY}` };
  if (o.fallback) {
    return { needsMachine: false, note: `names no machine: a question runs on its job's machine where claude can run there, else on ${o.fallback}, ${WHY_DEFAULT}` };
  }
  return { needsMachine: true, note: able.length ? several(o.reach, able) : nothing(o.reach) };
}

/** An instance's status with its note (issue #442): only a built-in part that runs claude and names no machine has one. `escalationMachine`: a level's fallback. */
export function withMachineNote(st: InstanceStatus, machines: readonly InstanceSpec[], escalationMachine?: string): InstanceStatus {
  const reach = RUNS_CLAUDE[st.instance.plugin];
  if (!reach || st.instance.options?.machine) return st;
  const fallback = reach === 'here-or-ssh' ? escalationMachine : undefined;
  return { ...st, machine: machineNote({ reach, machines, ...(fallback ? { fallback } : {}) }) };
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Name the machine in every claude-cli level and claude-plan usage source of a plugins config (a plain
 * object, changed in place) that names none, where exactly one configured machine can run it. Anywhere
 * else it stays unnamed. No `machines` section: the built-in ones, which the parts already name. Returns
 * the instances it named a machine for.
 */
export function fillMachines(doc: Record<string, unknown>): string[] {
  const machines = doc.machines;
  if (!Array.isArray(machines)) return [];
  const specs = machines.filter((m): m is InstanceSpec => isObject(m) && typeof m.name === 'string' && typeof m.plugin === 'string');
  const filled: string[] = [];
  for (const key of ['escalationLevels', 'usageSources']) {
    const section = doc[key];
    if (!Array.isArray(section)) continue;
    for (const item of section) {
      const reach = isObject(item) && typeof item.plugin === 'string' ? RUNS_CLAUDE[item.plugin] : undefined;
      if (!reach) continue;
      const options = isObject(item.options) ? item.options : {};
      if (typeof options.machine === 'string' && options.machine) continue;
      const able = specs.filter((m) => REACHED[reach].has(m.plugin));
      if (able.length !== 1) continue;
      item.options = { ...options, machine: able[0]!.name };
      filled.push(String(item.name));
    }
  }
  return filled;
}
