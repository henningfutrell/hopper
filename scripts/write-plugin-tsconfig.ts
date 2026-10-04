// node scripts/write-plugin-tsconfig.ts <plugin dir> <installed sdk.ts> — called by install.sh.
// Writes <plugin dir>/tsconfig.json (mode 600) so an editor type-checks custom plugins against the
// installed SDK: `job-hopper/plugin` → <installed sdk.ts> (design.md "Settled in slice 6").
// Rewritten while its first line is MARKER (an install moves or updates the SDK); a file without it
// is the owner's and is kept byte for byte. The plugin dir is created 700 if absent.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MARKER = "// Written by job-hopper's install.sh; rewritten on every install. Delete this line to keep your own edits.";

const [pluginDir, sdk] = process.argv.slice(2);
if (!pluginDir || !sdk) {
  console.error('usage: node scripts/write-plugin-tsconfig.ts <plugin dir> <installed src/plugins/sdk.ts>');
  process.exit(2);
}
const path = join(pluginDir, 'tsconfig.json');
if (existsSync(path) && readFileSync(path, 'utf8').split('\n')[0] !== MARKER) {
  console.log(`kept ${path}: edited by its owner (no job-hopper first line). It should map job-hopper/plugin to ${sdk}.`);
  process.exit(0);
}
const config = {
  compilerOptions: {
    // A plugin dir has no package.json, so module "preserve": .ts files are ES modules, as Node runs them.
    target: 'es2024', module: 'preserve', moduleResolution: 'bundler', strict: true, noEmit: true,
    allowImportingTsExtensions: true, erasableSyntaxOnly: true, verbatimModuleSyntax: true, skipLibCheck: true,
    paths: { 'job-hopper/plugin': [sdk] },
    // The install has no dev dependencies, so @types/node is there only if you add it.
    typeRoots: [join(dirname(dirname(dirname(sdk))), 'node_modules', '@types')],
  },
  include: ['*/**/*.ts'],
};
mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
writeFileSync(path, `${MARKER}\n${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`wrote ${path}: job-hopper/plugin → ${sdk}`);
