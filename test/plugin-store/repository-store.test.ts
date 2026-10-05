// This repository is a plugin store (design.md "Plugin store"): its plugin-store.yaml lists every
// example under examples/plugins/, each with the id, role and description its module declares.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importPlugin } from '../../src/plugins/loader.ts';
import { parseCatalogue } from '../../src/plugins/plugin-store-catalogue.ts';

const ROOT = join(import.meta.dirname, '..', '..');

describe("this repository's store catalogue", () => {
  const r = parseCatalogue(readFileSync(join(ROOT, 'plugin-store.yaml'), 'utf8'));
  const plugins = 'error' in r ? [] : r.plugins;

  it('parses', () => {
    expect('error' in r ? r.error : undefined).toBeUndefined();
  });

  it('lists every example plugin', () => {
    const examples = readdirSync(join(ROOT, 'examples', 'plugins')).flatMap((role) =>
      readdirSync(join(ROOT, 'examples', 'plugins', role)).map((id) => `examples/plugins/${role}/${id}`));
    expect(plugins.map((p) => p.path).sort()).toEqual(examples.sort());
  });

  it.each(plugins.map((p) => [p.id, p] as const))('%s loads as the catalogue says', async (_, p) => {
    const index = join(ROOT, p.path, 'index.ts');
    expect(existsSync(index)).toBe(true);
    const loaded = await importPlugin(index);
    if ('error' in loaded) throw new Error(loaded.error);
    expect([loaded.definition.id, loaded.definition.role, loaded.definition.describe]).toEqual([p.id, p.role, p.describe]);
  });
});
