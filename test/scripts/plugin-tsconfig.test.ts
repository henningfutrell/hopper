// The plugin dir's tsconfig.json, written by install.sh through scripts/write-plugin-tsconfig.ts
// (design.md "Settled in slice 6"): maps `hopper/plugin` to the installed sdk.ts, mode 600.
// Rewritten while it is still hopper's own (its first line says so); an owner-edited one is kept.
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../plugins/support.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const temp = useTempDirs();

function run(pluginDir: string, sdk: string) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'write-plugin-tsconfig.ts'), pluginDir, sdk], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** tsconfig.json is JSONC: drop line comments before parsing. */
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8').replace(/^\s*\/\/.*$/gm, ''));

describe('write-plugin-tsconfig', () => {
  it('absent: writes the mapping to the installed sdk.ts, mode 600, creating the plugin dir 700', () => {
    const dir = join(temp(), 'plugins');
    const r = run(dir, '/opt/jh/src/plugins/sdk.ts');
    expect(r.code).toBe(0);
    const path = join(dir, 'tsconfig.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(read(path).compilerOptions.paths).toEqual({ 'hopper/plugin': ['/opt/jh/src/plugins/sdk.ts'] });
    expect(read(path).compilerOptions).toMatchObject({ module: 'preserve', allowImportingTsExtensions: true, erasableSyntaxOnly: true, noEmit: true });
  });

  it("hopper's own, with another install path: rewritten", () => {
    const dir = temp();
    run(dir, '/old/src/plugins/sdk.ts');
    run(dir, '/new/src/plugins/sdk.ts');
    expect(read(join(dir, 'tsconfig.json')).compilerOptions.paths['hopper/plugin']).toEqual(['/new/src/plugins/sdk.ts']);
  });

  it('written before the rename (job-hopper first line): ours, rewritten to the new mapping', () => {
    const dir = temp();
    const path = join(dir, 'tsconfig.json');
    writeFileSync(path, "// Written by job-hopper's install.sh; rewritten on every install. Delete this line to keep your own edits.\n{}\n");
    run(dir, '/new/src/plugins/sdk.ts');
    expect(readFileSync(path, 'utf8').split('\n')[0]).toMatch(/^\/\/ Written by hopper's install\.sh/);
    expect(read(path).compilerOptions.paths).toEqual({ 'hopper/plugin': ['/new/src/plugins/sdk.ts'] });
  });

  it('owner-edited (no hopper first line): kept byte for byte, with a note', () => {
    const dir = temp();
    const path = join(dir, 'tsconfig.json');
    writeFileSync(path, '{ "compilerOptions": { "strict": false } }\n');
    const r = run(dir, '/new/src/plugins/sdk.ts');
    expect(r.code).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('{ "compilerOptions": { "strict": false } }\n');
    expect(r.out).toMatch(/kept/);
  });

  it('install.sh calls it with daemon.env\'s HOPPER_PLUGIN_DIR (no default) and the installed sdk.ts', () => {
    const text = readFileSync(join(ROOT, 'scripts', 'install.sh'), 'utf8');
    expect(text).toMatch(/write-plugin-tsconfig\.ts/);
    expect(text).toMatch(/PLUGIN_DIR="\$\(env_line HOPPER_PLUGIN_DIR\)"/);
    expect(text).not.toMatch(/\$CONFIG_DIR\/plugins(?!\.yaml)/);
    expect(text).toMatch(/\$DEST\/src\/plugins\/sdk\.ts/);
  });
});
