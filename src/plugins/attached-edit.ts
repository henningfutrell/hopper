// Attaching an ssh target from the UI (design.md "Machines from the UI", issues #18, #74): a new
// `ssh` instance appended to the plugins config's `machines`, every other entry kept. The ssh
// target must be a detected one; herdrBin is resolved over ssh here and its host key pinned from the
// user's known_hosts (design.md "Target authentication"), neither ever sent. The result is checked
// against the plugins config's schema and the ssh plugin's options before it replaces the record,
// against the version the edit was read at. Editing and removing a machine is a plugins edit (edit.ts).
// It runs herdr only when one of its executors is herdr-claude (issue #142); lanes and executors left
// out are the machine defaults, which the Machines view also edits here.
import type { ConfigRecords } from '../domain/ports.ts';
import type { ConfiguredInstance, InstanceSpec, MachineDefaults, MachineDefaultsEdit, MachineEdit } from '../domain/types.ts';
import type { ResolvedTarget } from '../machines/index.ts';
import { list, writePlugins, type EditRefusal, type EditResult } from './edit.ts';
import ssh from './machine-source/ssh/index.ts';
import { parseOptions } from './options.ts';
import { PLUGINS } from './plugins-config.ts';

export interface MachineEditContext {
  config: ConfigRecords;
  /** What the plugins config (or the built-in instances) names now. */
  configured: readonly ConfiguredInstance[];
  /** The configured executor instances. */
  executors: readonly InstanceSpec[];
  /** What a machine attached without lanes or executors gets. */
  defaults: MachineDefaults;
  sshTargets(): { targets: string[] };
  /** The host key that ssh target is pinned to and, when it is to run herdr, herdr's absolute path there; rejects with the reason. */
  resolveTarget(ssh: string, o: { herdr: boolean }): Promise<ResolvedTarget>;
}

/** The executor plugin that runs in a machine's herdr: a machine one of whose executors is an instance of it runs herdr. */
const HERDR_EXECUTOR = 'herdr-claude';

const refuse = (code: EditRefusal['code'], error: string): EditRefusal => ({ ok: false, code, error });

function unknownExecutors(list: readonly string[], executors: readonly InstanceSpec[]): string | undefined {
  const names = executors.map((x) => x.name);
  const missing = list.filter((x) => !names.includes(x));
  if (missing.length === 0) return undefined;
  return `${missing.join(', ')}: not ${missing.length === 1 ? 'an executor instance' : 'executor instances'} in the plugins config (configured: ${names.join(', ') || 'none'})`;
}

/** The machine defaults in effect: the plugins config's `machineDefaults`, a field left out the ssh plugin's own default. */
export function machineDefaults(set: Partial<MachineDefaults>): MachineDefaults {
  const base = parseOptions(ssh, { ssh: 'defaults' });
  if (!base.ok) throw new Error(`the ssh plugin's defaults: ${base.error}`);
  return { lanes: set.lanes ?? (base.options.lanes as number), executors: [...(set.executors ?? (base.options.executors as string[]))] };
}

/** POST /ui/api/machines/defaults (issue #142): the whole `machineDefaults` section; every executor a configured instance. */
export function applyMachineDefaultsEdit(e: MachineDefaultsEdit, config: ConfigRecords, executors: readonly InstanceSpec[]): EditResult {
  const bad = unknownExecutors(e.executors, executors);
  if (bad) return refuse('invalid', bad);
  return writePlugins(config, e.version, (doc) => { doc.machineDefaults = { lanes: e.lanes, executors: [...e.executors] }; });
}

export async function applyMachineEdit(e: MachineEdit, ctx: MachineEditContext): Promise<EditResult> {
  if (ctx.config.version(PLUGINS) !== e.version) return refuse('conflict', 'the plugins config changed since it was read; reload and edit again');
  if (!ctx.sshTargets().targets.includes(e.ssh)) return refuse('invalid', `ssh target ${e.ssh} is not a Host alias in ~/.ssh/config; add it there first`);
  if (ctx.configured.some((c) => c.role === 'machine-source' && c.instance.name === e.name)) return refuse('conflict', `a machine is already named ${e.name}`);
  const executors = e.executors ?? ctx.defaults.executors;
  const options: Record<string, unknown> = { ...(e.label !== undefined ? { label: e.label } : {}), ssh: e.ssh, lanes: e.lanes ?? ctx.defaults.lanes, executors };
  const parsed = parseOptions(ssh, options);
  if (!parsed.ok) return refuse('invalid', parsed.error);
  const bad = unknownExecutors(executors, ctx.executors);
  if (bad) return refuse('invalid', bad);
  const herdr = executors.some((x) => ctx.executors.find((i) => i.name === x)?.plugin === HERDR_EXECUTOR);
  let resolved: ResolvedTarget;
  try {
    resolved = await ctx.resolveTarget(e.ssh, { herdr });
    if (herdr && !resolved.herdrBin) throw new Error('herdr not found there');
  } catch (err) {
    return refuse('conflict', `cannot reach ${e.ssh} as the hopper, machine not added: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The probe takes seconds: writePlugins refuses a config that changed meanwhile.
  const there = herdr ? { herdrBin: resolved.herdrBin } : { herdr: false };
  const next: InstanceSpec = { name: e.name, plugin: ssh.id, options: { ...options, ...there, hostKey: resolved.hostKey } };
  return writePlugins(ctx.config, e.version, (doc) => list(doc, 'machine-source', e.name, next, ctx.configured));
}
