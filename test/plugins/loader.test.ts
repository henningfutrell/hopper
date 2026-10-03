import { chmodSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { loadCustomPlugins } from '../../src/plugins/loader.ts';
import { ALWAYS_PROCEED_DIR, fixedClock, useTempDirs, writePlugin } from './support.ts';

const temp = useTempDirs();
const BUILTIN_IDS = new Set(BUILTIN_PLUGINS.map((p) => p.id));

const routerJs = (id: string) => `export default {
  id: '${id}', role: 'router', describe: 'js plugin',
  async detect() { return { status: 'available' }; },
  create() { return { name: '${id}', async advise() { return { action: 'proceed_full', reason: 'js', details: {}, source: '${id}', at: 'x' }; } }; },
};
`;

describe('built-in plugins', () => {
  it('are jev-router and pass-through, both routers', () => {
    expect(BUILTIN_PLUGINS.map((p) => [p.id, p.role]).sort()).toEqual([['jev-router', 'router'], ['pass-through', 'router']]);
  });
});

describe('custom plugin loader', () => {
  it('loads a .ts plugin written against job-hopper/plugin, and a .js one', async () => {
    const dir = temp();
    cpSync(ALWAYS_PROCEED_DIR, join(dir, 'always-proceed'), { recursive: true });
    writePlugin(dir, 'js-router', routerJs('js-router'), 'index.js');
    const r = await loadCustomPlugins(dir, BUILTIN_IDS);
    expect(r.errors).toEqual([]);
    expect(r.plugins.map((p) => [p.definition.id, p.path]).sort()).toEqual([
      ['always-proceed', join(dir, 'always-proceed', 'index.ts')],
      ['js-router', join(dir, 'js-router', 'index.js')],
    ]);
    const def = r.plugins.find((p) => p.definition.id === 'always-proceed')!.definition;
    const router = await def.create({ clock: fixedClock, logger: { info() {}, warn() {} }, dataDir: dir, scratchDir: dir, routerMode: () => 'shadow' }, { note: 'hi' });
    expect(await router.advise({} as never)).toMatchObject({ action: 'proceed_full', reason: 'hi', source: 'always-proceed' });
  });

  it('an absent plugin dir is no plugins and no error', async () => {
    expect(await loadCustomPlugins(join(temp(), 'nope'), BUILTIN_IDS)).toEqual({ plugins: [], errors: [], warnings: [] });
  });

  it('refuses a custom id that collides with a built-in', async () => {
    const dir = temp();
    writePlugin(dir, 'mine', routerJs('pass-through'), 'index.js');
    const r = await loadCustomPlugins(dir, BUILTIN_IDS);
    expect(r.plugins).toEqual([]);
    expect(r.errors).toEqual([{ path: join(dir, 'mine', 'index.js'), error: expect.stringMatching(/pass-through.*built-in/) }]);
  });

  it('refuses a second custom plugin with the same id', async () => {
    const dir = temp();
    writePlugin(dir, 'a', routerJs('twin'), 'index.js');
    writePlugin(dir, 'b', routerJs('twin'), 'index.js');
    const r = await loadCustomPlugins(dir, BUILTIN_IDS);
    expect(r.plugins.map((p) => p.definition.id)).toEqual(['twin']);
    expect(r.errors).toEqual([{ path: join(dir, 'b', 'index.js'), error: expect.stringMatching(/twin.*already/) }]);
  });

  it.each([
    ['no default export', 'export const x = 1;\n', /default export/],
    ['unknown role', routerJs('r').replace("role: 'router'", "role: 'toaster'"), /role/],
    ['missing create', "export default { id: 'r', role: 'router', describe: 'd', async detect() { return { status: 'available' }; } };\n", /create/],
    ['bad id', routerJs('Bad Id'), /id/],
    ['a module that throws on import', "throw new Error('boom at import');\n", /boom at import/],
  ])('refuses a plugin with %s, and keeps loading the rest', async (_name, source, why) => {
    const dir = temp();
    writePlugin(dir, 'bad', source, 'index.js');
    writePlugin(dir, 'good', routerJs('good'), 'index.js');
    const r = await loadCustomPlugins(dir, BUILTIN_IDS);
    expect(r.plugins.map((p) => p.definition.id)).toEqual(['good']);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.error).toMatch(why);
  });

  it('a directory without index.ts or index.js is an error', async () => {
    const dir = temp();
    writePlugin(dir, 'empty', 'x', 'README.md');
    const r = await loadCustomPlugins(dir, BUILTIN_IDS);
    expect(r.errors).toEqual([{ path: join(dir, 'empty'), error: expect.stringMatching(/index\.ts or index\.js/) }]);
  });

  it('warns when the plugin dir is readable by group or other', async () => {
    const dir = temp();
    chmodSync(dir, 0o755);
    const r = await loadCustomPlugins(dir, BUILTIN_IDS);
    expect(r.warnings).toEqual([expect.stringMatching(/group\/other.*chmod 700/)]);
    chmodSync(dir, 0o700);
    expect((await loadCustomPlugins(dir, BUILTIN_IDS)).warnings).toEqual([]);
  });
});
