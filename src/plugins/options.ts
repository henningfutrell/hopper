// Plugin options: a zod schema the plugin builds from the core's zod; validated with safeParse,
// shown as JSON Schema (design.md "Plugin contract").
import { z } from 'zod';
import type { InstanceSpec, OptionChoice } from '../domain/types.ts';
import type { PluginDefinition } from './sdk.ts';

export type OptionsResult = { ok: true; options: Record<string, unknown> } | { ok: false; error: string };

function schemaOf(def: PluginDefinition): z.ZodType {
  return def.options ? def.options(z) : z.object({});
}

export function parseOptions(def: PluginDefinition, raw: unknown): OptionsResult {
  try {
    const r = schemaOf(def).safeParse(raw ?? {});
    if (r.success) return { ok: true, options: r.data as Record<string, unknown> };
    return { ok: false, error: `invalid options for ${def.id}: ${r.error.issues.map((i) => `${i.path.join('.') || 'options'}: ${i.message}`).join('; ')}` };
  } catch (e) {
    return { ok: false, error: `options of ${def.id} cannot be built: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * The plugin's machine options (`.meta({ machine: true })`, issue #174): each names a machine, picked
 * from the known machines and never typed. This machine is no default: it is the `local` machine in the list.
 */
export function machineOptions(def: PluginDefinition): string[] {
  const props = (optionsJsonSchema(def).properties ?? {}) as Record<string, { machine?: unknown }>;
  return Object.entries(props).filter(([, p]) => p.machine === true).map(([k]) => k);
}

/** `{ choices }`: the plugin's own, and every configured machine for each machine option (issue #174); none when empty. */
export function withMachineChoices(def: PluginDefinition, own: Record<string, OptionChoice[]> | undefined, machines: readonly InstanceSpec[]): { choices?: Record<string, OptionChoice[]> } {
  const listed = machines.map((m) => ({ value: m.name, description: m.plugin === 'local' ? 'this machine' : `${m.plugin} machine` }));
  const choices = { ...own, ...Object.fromEntries(machineOptions(def).map((k) => [k, listed])) };
  return Object.keys(choices).length ? { choices } : {};
}

export function optionsJsonSchema(def: PluginDefinition): Record<string, unknown> {
  try {
    return z.toJSONSchema(schemaOf(def), { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  } catch (e) {
    return { error: `options of ${def.id} cannot be shown: ${e instanceof Error ? e.message : String(e)}` };
  }
}
