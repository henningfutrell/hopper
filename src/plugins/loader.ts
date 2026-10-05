// Custom plugins: one directory per plugin under the plugin dir, `index.ts` or `index.js`, loaded by
// dynamic import() (design.md "Where plugins live, and loading"). A broken plugin is refused with an
// error and the rest still load; nothing here throws.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROLES } from '../domain/types.ts';
import type { PluginDefinition } from './sdk.ts';

export interface LoadedPlugin { definition: PluginDefinition; path: string }
export interface LoadError { path: string; error: string }
export interface LoadResult { plugins: LoadedPlugin[]; errors: LoadError[]; warnings: string[] }

const ID = /^[a-z0-9][a-z0-9-]*$/;

/** Why `x` is not a PluginDefinition, or undefined when it is one. */
export function definitionProblem(x: unknown): string | undefined {
  if (typeof x !== 'object' || x === null) return 'the module has no default export object';
  const d = x as Record<string, unknown>;
  if (typeof d.id !== 'string' || !ID.test(d.id)) return `id must match ${ID} (got ${JSON.stringify(d.id)})`;
  if (!(ROLES as readonly unknown[]).includes(d.role)) return `role must be one of ${ROLES.join(', ')} (got ${JSON.stringify(d.role)})`;
  if (typeof d.describe !== 'string') return 'describe must be a string';
  if (d.options !== undefined && typeof d.options !== 'function') return 'options must be a function (z) => schema';
  if (typeof d.detect !== 'function') return 'detect must be a function';
  if (typeof d.create !== 'function') return 'create must be a function';
  return undefined;
}

/** Import one plugin module and check its default export. Never throws. */
export async function importPlugin(path: string): Promise<{ definition: PluginDefinition } | { error: string }> {
  let mod: { default?: unknown };
  try {
    mod = await import(pathToFileURL(path).href) as { default?: unknown };
  } catch (e) {
    return { error: `cannot import: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (mod.default === undefined) return { error: 'the module has no default export' };
  const problem = definitionProblem(mod.default);
  return problem ? { error: problem } : { definition: mod.default as PluginDefinition };
}

/** Load every plugin under each of `dirs`, in order. `reserved`: the built-in ids, which a custom plugin may not take. */
export async function loadCustomPlugins(dirs: readonly string[], reserved: ReadonlySet<string>): Promise<LoadResult> {
  const out: LoadResult = { plugins: [], errors: [], warnings: [] };
  const taken = new Set(reserved);
  for (const dir of dirs) await loadDir(dir, reserved, taken, out);
  return out;
}

async function loadDir(dir: string, reserved: ReadonlySet<string>, taken: Set<string>, out: LoadResult): Promise<void> {
  if (!existsSync(dir)) return;
  if (statSync(dir).mode & 0o077) out.warnings.push(`plugin dir ${dir} is accessible by group/other (chmod 700 ${dir})`);
  // Dot directories are not plugins: the plugin store stages its installs in them (design.md "Plugin store").
  const names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
  for (const name of names) {
    const entry = ['index.ts', 'index.js'].map((f) => join(dir, name, f)).find((p) => existsSync(p));
    if (!entry) {
      out.errors.push({ path: join(dir, name), error: 'no index.ts or index.js' });
      continue;
    }
    const r = await importPlugin(entry);
    if ('error' in r) {
      out.errors.push({ path: entry, error: r.error });
      continue;
    }
    const { id } = r.definition;
    if (taken.has(id)) {
      const why = reserved.has(id) ? `refused: id ${id} is a built-in plugin` : `refused: id ${id} is already taken by another custom plugin`;
      out.errors.push({ path: entry, error: why });
      continue;
    }
    taken.add(id);
    out.plugins.push({ definition: r.definition, path: entry });
  }
}
