// The UI bundle check (scripts/check-ui-bundle.ts, issue #274): a UI build whose stylesheet lacks the
// Tailwind utilities, or is far below a real Tailwind bundle's size, fails the build — so install.sh
// (and self-update, which runs it in build-only mode) never puts it live. It once shipped: install.sh
// built in a temp dir under a job's scratch dir, whose `.gitignore` of `*` made Tailwind skip every
// source file, and the sign-in page rendered as logo shards with no controls (#272).
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../plugins/support.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const temp = useTempDirs();

function check(dist: string) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-ui-bundle.ts'), dist], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const UTILITIES = ['flex', 'h-8', 'w-full', 'items-center', 'justify-center', 'gap-2', 'text-sm', 'rounded-md', 'hidden', 'grid'];

/** A dist/ like vite's: index.html linking one stylesheet in assets/. */
function dist(css: string | null): string {
  const dir = temp();
  mkdirSync(join(dir, 'assets'));
  const link = css === null ? '' : '<link rel="stylesheet" crossorigin href="/ui/assets/index-abc123.css">';
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head>${link}</head><body><div id="root"></div></body></html>\n`);
  if (css !== null) writeFileSync(join(dir, 'assets', 'index-abc123.css'), css);
  return dir;
}

const rules = (names: string[]) => names.map((n) => `.${n}{--x:1}`).join('');
const pad = (n: number) => `/*${'x'.repeat(n)}*/`;

describe('check-ui-bundle', () => {
  it('a full Tailwind stylesheet passes', () => {
    const r = check(dist(rules(UTILITIES) + pad(90_000)));
    expect(r.out).toBe('');
    expect(r.code).toBe(0);
  });

  it('a stylesheet far below a real bundle fails, naming its size', () => {
    const r = check(dist(rules(UTILITIES) + pad(13_000)));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/index-abc123\.css/);
    expect(r.out).toMatch(/\d+ bytes/);
  });

  it('a stylesheet missing utilities fails, naming them', () => {
    const r = check(dist(rules(UTILITIES.filter((u) => u !== 'h-8' && u !== 'flex')) + pad(90_000)));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\.h-8/);
    expect(r.out).toMatch(/\.flex\b/);
  });

  it('an index.html with no stylesheet, or no index.html, fails', () => {
    expect(check(dist(null)).code).toBe(1);
    expect(check(temp()).code).toBe(1);
  });

  it('npm run build:ui runs it on ui/dist, so every build is checked', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    // Issue #675: the artifact libraries are copied into ui/dist before the check.
    expect(pkg.scripts['build:ui']).toMatch(/^vite build --config ui\/vite\.config\.ts && node scripts\/copy-artifact-libs\.ts ui\/dist && node scripts\/check-ui-bundle\.ts ui\/dist$/);
  });

  it('install.sh builds the UI with the check beside it, in a dir that is its own git root', () => {
    const text = readFileSync(join(ROOT, 'scripts', 'install.sh'), 'utf8');
    expect(text).toMatch(/cp "\$APP_DIR\/scripts\/check-ui-bundle\.ts" "\$BUILD\/scripts\/"/);
    expect(text).toMatch(/cp "\$APP_DIR\/scripts\/copy-artifact-libs\.ts" "\$BUILD\/scripts\/"/);
    const init = text.indexOf('git init -q "$BUILD"');
    expect(init).toBeGreaterThan(-1);
    expect(init).toBeLessThan(text.indexOf('npm run build:ui --prefix "$BUILD"'));
  });

  it("the image's UI stage has the check before it builds", () => {
    const text = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    const copy = text.indexOf('COPY scripts/check-ui-bundle.ts ./scripts/check-ui-bundle.ts');
    expect(copy).toBeGreaterThan(-1);
    expect(copy).toBeLessThan(text.indexOf('RUN npm run build:ui'));
    expect(text.indexOf('COPY scripts/copy-artifact-libs.ts ./scripts/copy-artifact-libs.ts')).toBeGreaterThan(-1);
    expect(text.indexOf('COPY scripts/copy-artifact-libs.ts ./scripts/copy-artifact-libs.ts')).toBeLessThan(text.indexOf('RUN npm run build:ui'));
  });

  // The real failure: a copy of the UI built under a parent dir whose .gitignore is `*`, as a job's
  // scratch dir is. Without a git root of its own Tailwind skips every source and the check fails it;
  // with one (what install.sh does) the bundle is whole.
  describe('a real build under a parent that ignores everything', () => {
    function copy(): string {
      const parent = temp();
      writeFileSync(join(parent, '.gitignore'), '*\n');
      const build = join(parent, 'hopper-ui.build');
      mkdirSync(join(build, 'site'), { recursive: true });
      for (const p of ['ui', 'src', 'package.json']) cpSync(join(ROOT, p), join(build, p), { recursive: true, filter: (s) => !s.includes(join('ui', 'dist')) });
      cpSync(join(ROOT, 'site', 'hopper-logo.svg'), join(build, 'site', 'hopper-logo.svg'));
      symlinkSync(join(ROOT, 'node_modules'), join(build, 'node_modules'));
      return build;
    }
    const vite = (build: string) => spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'ui/vite.config.ts'], { cwd: build, encoding: 'utf8' });

    it('without its own git root: the hollow bundle is refused', () => {
      const build = copy();
      expect(vite(build).status).toBe(0);
      const r = check(join(build, 'ui', 'dist'));
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/\.h-8/);
    }, 180_000);

    it('as its own git root: the bundle passes', () => {
      const build = copy();
      expect(spawnSync('git', ['init', '-q', build]).status).toBe(0);
      expect(vite(build).status).toBe(0);
      expect(check(join(build, 'ui', 'dist'))).toEqual({ code: 0, out: '' });
    }, 180_000);
  });
});
