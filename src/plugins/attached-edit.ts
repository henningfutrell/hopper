// Attaching an ssh target from the UI (design.md "Machines from the UI", issues #18, #74): a new
// `ssh` instance appended to plugins.yaml `machines:`, every other node and comment kept. The ssh
// target must be a detected one; herdrBin is resolved over ssh here and its host key pinned from the
// user's known_hosts (design.md "Target authentication"), neither ever sent. The result is checked
// against the plugins.yaml schema and the ssh plugin's options before it replaces the document,
// against the version the edit was read at. Editing and removing a machine is a plugins edit (edit.ts).
import type { ConfigDocuments } from '../domain/ports.ts';
import type { ConfiguredInstance, InstanceSpec, MachineEdit } from '../domain/types.ts';
import { list, writePlugins, type EditRefusal, type EditResult } from './edit.ts';
import ssh from './machine-source/ssh/index.ts';
import { parseOptions } from './options.ts';
import { PLUGINS } from './plugins-file.ts';

export interface MachineEditContext {
  documents: ConfigDocuments;
  /** What plugins.yaml (or the built-in instances) names now. */
  configured: readonly ConfiguredInstance[];
  /** The configured executor instance names. */
  executors: readonly string[];
  sshTargets(): { targets: string[] };
  /** herdr's absolute path on that ssh target and the host key it is pinned to; rejects with the reason. */
  resolveTarget(ssh: string): Promise<{ herdrBin: string; hostKey: string }>;
}

const refuse = (code: EditRefusal['code'], error: string): EditRefusal => ({ ok: false, code, error });

function unknownExecutors(list: readonly string[], ctx: MachineEditContext): string | undefined {
  const missing = list.filter((x) => !ctx.executors.includes(x));
  if (missing.length === 0) return undefined;
  return `${missing.join(', ')}: not ${missing.length === 1 ? 'an executor instance' : 'executor instances'} in plugins.yaml (configured: ${ctx.executors.join(', ') || 'none'})`;
}

export async function applyMachineEdit(e: MachineEdit, ctx: MachineEditContext): Promise<EditResult> {
  if (ctx.documents.version(PLUGINS) !== e.version) return refuse('conflict', `${PLUGINS} changed since it was read; reload and edit again`);
  if (!ctx.sshTargets().targets.includes(e.ssh)) return refuse('invalid', `ssh target ${e.ssh} is not a Host alias in ~/.ssh/config; add it there first`);
  if (ctx.configured.some((c) => c.role === 'machine-source' && c.instance.name === e.name)) return refuse('conflict', `a machine is already named ${e.name}`);
  const options: Record<string, unknown> = { ...(e.label !== undefined ? { label: e.label } : {}), ssh: e.ssh, lanes: e.lanes, ...(e.executors ? { executors: e.executors } : {}) };
  const parsed = parseOptions(ssh, options);
  if (!parsed.ok) return refuse('invalid', parsed.error);
  const bad = unknownExecutors(parsed.options.executors as string[], ctx);
  if (bad) return refuse('invalid', bad);
  let resolved: { herdrBin: string; hostKey: string };
  try {
    resolved = await ctx.resolveTarget(e.ssh);
  } catch (err) {
    return refuse('conflict', `cannot reach ${e.ssh} as the hopper, machine not added: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The probe takes seconds: writePlugins refuses a document that changed meanwhile.
  const next: InstanceSpec = { name: e.name, plugin: ssh.id, options: { ...options, herdrBin: resolved.herdrBin, hostKey: resolved.hostKey } };
  return writePlugins(ctx.documents, e.version, (doc) => list(doc, 'machine-source', e.name, next, ctx.configured));
}
