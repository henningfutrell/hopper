// Duplicate job sources (issue #1264, glossary "Duplicate job source"): two job sources of one plugin that take the
// same work — for GitHub, the same issues through the same account or app, over repositories that overlap — poll the
// same service twice for nothing. The plugin says what the same work is (`PluginDefinition.sameWork`); a second such
// source is refused when it is added or turned on, and one configured already shows as a duplicate of the first.
import type { ConfiguredInstance, InstanceSpec } from '../domain/types.ts';
import { parseOptions } from './options.ts';
import type { PluginDefinition } from './sdk.ts';

type Find = (id: string) => PluginDefinition | undefined;

/** The instance's options as its plugin parses them, or undefined when they are invalid or its plugin is not loaded. */
function parsed(spec: InstanceSpec, find: Find): { def: PluginDefinition; options: Record<string, unknown> } | undefined {
  const def = find(spec.plugin);
  if (!def?.sameWork) return undefined;
  const r = parseOptions(def, spec.options ?? {});
  return r.ok ? { def, options: r.options } : undefined;
}

/** The first configured job source, other than `spec` itself, that takes the same work as `spec`; undefined when none does. */
export function duplicateJobSource(spec: InstanceSpec, configured: readonly ConfiguredInstance[], find: Find): string | undefined {
  const mine = parsed(spec, find);
  if (!mine) return undefined;
  for (const { role, instance } of configured) {
    if (role !== 'job-source' || instance.name === spec.name || instance.plugin !== spec.plugin) continue;
    const theirs = parsed(instance, find);
    if (theirs && mine.def.sameWork!(mine.options, theirs.options)) return instance.name;
  }
  return undefined;
}

/** Each configured job source that duplicates an earlier one, by name, with the name of the first it duplicates. */
export function duplicateJobSources(configured: readonly ConfiguredInstance[], find: Find): Map<string, string> {
  const out = new Map<string, string>();
  const sources = configured.filter((c) => c.role === 'job-source');
  sources.forEach(({ instance }, i) => {
    const first = duplicateJobSource(instance, sources.slice(0, i).filter((c) => !out.has(c.instance.name)), find);
    if (first) out.set(instance.name, first);
  });
  return out;
}
