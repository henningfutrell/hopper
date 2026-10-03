// Plugin options: a zod schema the plugin builds from the core's zod; validated with safeParse,
// shown as JSON Schema (design.md "Plugin contract").
import { z } from 'zod';
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

export function optionsJsonSchema(def: PluginDefinition): Record<string, unknown> {
  try {
    return z.toJSONSchema(schemaOf(def), { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  } catch (e) {
    return { error: `options of ${def.id} cannot be shown: ${e instanceof Error ? e.message : String(e)}` };
  }
}
