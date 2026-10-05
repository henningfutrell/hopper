// npm run plugin:check <dir> — check custom plugins before the daemon loads them (design.md
// "Settled in slice 6", docs/plugins.md). <dir> is one plugin (it holds index.ts or index.js) or a
// directory of them, nested at any depth (the plugin dir, examples/plugins). Steps:
//   1. type-check every index.ts with `hopper/plugin` mapped to this checkout's src/plugins/sdk.ts
//      (a throwaway tsconfig in the temp dir; nothing is written into <dir>);
//   2. per plugin: the real loader's import and shape check, the built-in id check, the options
//      parsed from `{}` (every option needs a default), and `detect` with the real detection kit.
// One line per plugin; exit 1 on any failure. A plugin that detects unavailable or needs-setup is
// reported, not failed: it may simply not run on this machine.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { BUILTIN_PLUGINS } from '../src/plugins/builtin.ts';
import { createDetectionKit } from '../src/plugins/detect.ts';
import { importPlugin } from '../src/plugins/loader.ts';
import { parseOptions } from '../src/plugins/options.ts';
import type { Detection } from '../src/plugins/sdk.ts';

const ROOT = resolve(import.meta.dirname, '..');
const SDK = join(ROOT, 'src', 'plugins', 'sdk.ts');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const ENTRIES = ['index.ts', 'index.js'];

const entryOf = (dir: string) => ENTRIES.map((f) => join(dir, f)).find((p) => existsSync(p));

/** Every plugin entry under `dir` (or `dir`'s own), in path order. */
function findPlugins(dir: string, depth = 0): string[] {
  const own = entryOf(dir);
  if (own) return [own];
  if (depth > 4) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
    .map((e) => e.name).sort()
    .flatMap((name) => findPlugins(join(dir, name), depth + 1));
}

/** tsc over the .ts entries with the SDK mapping; undefined = ok, else the compiler's output. */
function typeCheck(files: string[]): string | undefined {
  if (!existsSync(TSC)) return `typescript is not installed in ${ROOT}; run npm ci there (plugin:check needs the dev dependencies)`;
  const tmp = mkdtempSync(join(tmpdir(), 'jh-plugin-check-'));
  try {
    const project = join(tmp, 'tsconfig.json');
    writeFileSync(project, JSON.stringify({
      compilerOptions: {
        target: 'es2024', module: 'preserve', moduleResolution: 'bundler', strict: true, noEmit: true,
        allowImportingTsExtensions: true, erasableSyntaxOnly: true, verbatimModuleSyntax: true, skipLibCheck: true,
        types: ['node'], typeRoots: [join(ROOT, 'node_modules', '@types')],
        paths: { 'hopper/plugin': [SDK] },
      },
      files,
    }));
    const r = spawnSync(process.execPath, [TSC, '-p', project, '--pretty', 'false'], { encoding: 'utf8' });
    return r.status === 0 ? undefined : `${r.stdout}${r.stderr}`.trim() || `tsc exited ${r.status}`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const shown = (d: Detection) => (d.status === 'available' ? 'available' : d.status === 'unavailable' ? `unavailable: ${d.reason}` : `needs-setup: ${d.reason} (run: ${d.command})`);

async function main(): Promise<number> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: npm run plugin:check <plugin dir>');
    return 2;
  }
  const dir = resolve(arg);
  const entries = existsSync(dir) ? findPlugins(dir) : [];
  if (entries.length === 0) {
    console.error(`plugin:check: no plugin under ${dir} (a plugin is a directory holding index.ts or index.js)`);
    return 1;
  }
  let failed = false;
  const ts = entries.filter((e) => e.endsWith('.ts'));
  const problem = ts.length ? typeCheck(ts) : undefined;
  if (problem) failed = true;
  console.log(`type-check: ${problem ? 'FAIL' : 'ok'} (${ts.length} .ts entr${ts.length === 1 ? 'y' : 'ies'}, hopper/plugin → ${SDK})`);
  if (problem) console.log(problem.split('\n').map((l) => `  ${l}`).join('\n'));

  const kit = createDetectionKit();
  const taken = new Set(BUILTIN_PLUGINS.map((b) => b.id));
  for (const entry of entries) {
    const at = relative(process.cwd(), entry) || entry;
    const fail = (why: string) => { failed = true; console.log(`FAIL  ${at}: ${why}`); };
    const r = await importPlugin(entry);
    if ('error' in r) { fail(r.error); continue; }
    const def = r.definition;
    const name = `${def.role} ${def.id} (${at})`;
    if (taken.has(def.id)) {
      fail(BUILTIN_PLUGINS.some((b) => b.id === def.id) ? `id ${def.id} is a built-in plugin` : `id ${def.id} is taken by another plugin here`);
      continue;
    }
    taken.add(def.id);
    const options = parseOptions(def, {});
    if (!options.ok) { fail(`${name}: options do not parse with their defaults (give every option a default): ${options.error}`); continue; }
    let detection: Detection;
    try {
      detection = await def.detect(kit, options.options);
    } catch (e) {
      fail(`${name}: detect threw: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    console.log(`ok    ${name} — detect: ${shown(detection)}`);
  }
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
