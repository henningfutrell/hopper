// The UI built where a .gitignore ignores everything (issue #266): install.sh builds it in a throwaway
// copy under TMPDIR, and a TMPDIR inside an ignored directory hid every source file from Tailwind's
// automatic source detection — the CSS came out with no utility classes, and the signed-out page
// unstyled. The stylesheet names its sources, so the build is the same wherever it runs.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('UI build in an ignored directory', () => {
  it('still has the utility classes the UI uses', () => {
    const top = mkdtempSync(join(tmpdir(), 'hopper-ignored-'));
    dirs.push(top);
    writeFileSync(join(top, '.gitignore'), '*\n');
    const build = join(top, 'hopper-ui');
    cpSync(join(REPO, 'ui'), join(build, 'ui'), { recursive: true, filter: (s) => !/\/ui\/(dist|node_modules)(\/|$)/.test(s) });
    cpSync(join(REPO, 'src/domain'), join(build, 'src/domain'), { recursive: true });
    cpSync(join(REPO, 'site/hopper-logo.svg'), join(build, 'site/hopper-logo.svg'));
    cpSync(join(REPO, 'package.json'), join(build, 'package.json'));
    symlinkSync(join(REPO, 'node_modules'), join(build, 'node_modules'));
    const r = spawnSync(process.execPath, [join(REPO, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'ui/vite.config.ts', '--logLevel', 'error'],
      { cwd: build, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const assets = join(build, 'ui/dist/assets');
    const css = readdirSync(assets).filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(assets, f), 'utf8')).join('');
    for (const rule of ['.flex{', '.items-center{', '.text-center{', '.min-h-dvh{']) expect(css).toContain(rule);
    expect(css).toMatch(/\.lg\\:grid-cols-/);
  }, 120_000);
});
