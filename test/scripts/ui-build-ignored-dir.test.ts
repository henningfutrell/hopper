// The UI built where a .gitignore ignores everything (issue #266): install.sh builds it in a throwaway
// copy under TMPDIR, and a TMPDIR inside an ignored directory hid every source file from Tailwind's
// automatic source detection — the CSS came out with no utility classes, and the page unstyled. The
// copy gets a .gitignore of its own, written by install.sh's own line, that takes everything back in.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** install.sh's line that writes the build copy's .gitignore. */
const ownIgnore = (): string | undefined =>
  readFileSync(join(REPO, 'scripts/install.sh'), 'utf8').split('\n').find((l) => /^printf .* > "\$BUILD\/\.gitignore"$/.test(l));

/** The UI built in a copy inside a directory a .gitignore ignores entirely, as install.sh copies it; its CSS. */
function buildInIgnoredDir(prepare: (build: string) => void): string {
  const top = mkdtempSync(join(tmpdir(), 'hopper-ignored-'));
  dirs.push(top);
  writeFileSync(join(top, '.gitignore'), '*\n');
  const build = join(top, 'hopper-ui');
  cpSync(join(REPO, 'ui'), join(build, 'ui'), { recursive: true, filter: (s) => !/\/ui\/(dist|node_modules)(\/|$)/.test(s) });
  cpSync(join(REPO, 'src/domain'), join(build, 'src/domain'), { recursive: true });
  cpSync(join(REPO, 'site/hopper-logo.svg'), join(build, 'site/hopper-logo.svg'));
  cpSync(join(REPO, 'package.json'), join(build, 'package.json'));
  symlinkSync(join(REPO, 'node_modules'), join(build, 'node_modules'));
  prepare(build);
  const r = spawnSync(process.execPath, [join(REPO, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'ui/vite.config.ts', '--logLevel', 'error'],
    { cwd: build, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  const assets = join(build, 'ui/dist/assets');
  return readdirSync(assets).filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(assets, f), 'utf8')).join('');
}

describe('UI build in an ignored directory', () => {
  it('as is, the utility classes are lost (what install.sh ran into)', () => {
    expect(buildInIgnoredDir(() => {})).not.toContain('.flex{');
  }, 120_000);

  it("with install.sh's own .gitignore in the copy, the utility classes the UI uses are all there", () => {
    const line = ownIgnore();
    expect(line, 'install.sh writes the build copy a .gitignore').toBeDefined();
    const css = buildInIgnoredDir((build) => {
      const r = spawnSync('bash', ['-c', line!], { env: { ...process.env, BUILD: build }, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    });
    for (const rule of ['.flex{', '.items-center{', '.text-center{', '.min-h-dvh{']) expect(css).toContain(rule);
    expect(css).toMatch(/\.lg\\:grid-cols-/);
  }, 120_000);
});
