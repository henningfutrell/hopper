// Attaching an ssh target from the UI (design.md "Machines from the UI", issues #18, #74): a new
// `ssh` instance appended to the plugins config's `machines`, every other entry kept. The ssh
// target must be a detected one; herdrBin is resolved over ssh here and its host key pinned from the
// user's known_hosts (design.md "Target authentication"), neither ever sent. The result is checked
// against the plugins config's schema and the ssh plugin's options before it replaces the record,
// against the version the edit was read at. Editing and removing a machine is a plugins edit (edit.ts).
// It runs herdr only when one of its executors is herdr-claude (issue #142); lanes and executors left
// out are the machine defaults, which the Machines view also edits here. Without an ssh target it adds
// this machine (issue #260): a `local` instance with the herdr session named, which is started first.
import type { ConfigRecords } from '../domain/ports.ts';
import type { ConfiguredInstance, InstanceSpec, MachineDefaults, MachineDefaultsEdit, MachineEdit } from '../domain/types.ts';
import type { ResolvedTarget } from '../machines/index.ts';
import { list, writePlugins, type EditRefusal, type EditResult } from './edit.ts';
import local from './machine-source/local/index.ts';
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
  /** Starts this machine's herdr session (issue #260); rejects with the reason. */
  startSession(session: string): Promise<unknown>;
  /** A plugin's machine options: each part naming no machine runs on this machine once it is added. */
  machineOptionsOf(plugin: string): string[];
}

/** The sections whose parts run on a machine they name (issue #174). */
const ON_A_MACHINE = ['escalationLevels', 'usageSources'] as const;

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
  if (e.ssh === undefined) return addThisMachine(e, ctx);
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
    return refuse('conflict', `could not add ${e.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The probe takes seconds: writePlugins refuses a config that changed meanwhile.
  const there = herdr ? { herdrBin: resolved.herdrBin } : { herdr: false };
  const next: InstanceSpec = { name: e.name, plugin: ssh.id, options: { ...options, ...there, hostKey: resolved.hostKey } };
  return writePlugins(ctx.config, e.version, (doc) => list(doc, 'machine-source', e.name, next, ctx.configured));
}

/**
 * Adding this machine (issue #260): a `local` instance under the name given — no ssh target —, its jobs
 * in the herdr session named (default `hopper`), started here before it is written. Each escalation
 * level and usage source that names no machine runs on it.
 */
async function addThisMachine(e: MachineEdit, ctx: MachineEditContext): Promise<EditResult> {
  const here = ctx.configured.find((c) => c.role === 'machine-source' && c.instance.plugin === local.id);
  if (here) return refuse('conflict', `this machine is already added, as ${here.instance.name}; edit that one`);
  if (ctx.configured.some((c) => c.role === 'machine-source' && c.instance.name === e.name)) return refuse('conflict', `a machine is already named ${e.name}`);
  const session = e.session ?? 'hopper';
  const options: Record<string, unknown> = {
    ...(e.label !== undefined ? { label: e.label } : {}), lanes: e.lanes ?? 4, ...(e.executors ? { executors: e.executors } : {}), session,
  };
  const parsed = parseOptions(local, options);
  if (!parsed.ok) return refuse('invalid', parsed.error);
  if (e.executors) { const bad = unknownExecutors(e.executors, ctx.executors); if (bad) return refuse('invalid', bad); }
  const herdr = (e.executors ?? ctx.executors.map((x) => x.name)).some((x) => ctx.executors.find((i) => i.name === x)?.plugin === HERDR_EXECUTOR);
  if (herdr) {
    try {
      await ctx.startSession(session);
    } catch (err) {
      return refuse('conflict', `could not start herdr session ${session} on this machine, so it was not added: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const next: InstanceSpec = { name: e.name, plugin: local.id, options };
  return writePlugins(ctx.config, e.version, (doc) => {
    list(doc, 'machine-source', e.name, next, ctx.configured);
    for (const key of ON_A_MACHINE) {
      const section = (doc as Record<string, unknown>)[key];
      if (!Array.isArray(section)) continue;
      for (const item of section as { plugin?: unknown; options?: Record<string, unknown> }[]) {
        if (typeof item?.plugin !== 'string') continue;
        for (const option of ctx.machineOptionsOf(item.plugin)) {
          if (item.options?.[option] === undefined) item.options = { ...item.options, [option]: e.name };
        }
      }
    }
  });
}
