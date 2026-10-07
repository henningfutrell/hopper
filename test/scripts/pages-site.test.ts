// Issue #382: the GitHub Pages site wears the signed-out landing page's look. `npm run build:site` builds
// site/ with Vite into site/dist: the front page (the landing page's backdrop, its story in three steps,
// the one-line install) and the install page, both styled by the UI's own stylesheet (ui/src/index.css),
// so the site and the UI cannot drift. The story itself is one module both render (ui/src/app/story.ts).
// The build also serves what the site served before: install.sh (scripts/get.sh), compose.yaml, the logo,
// and the old install-page addresses on the front page (issue #88).
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';
import { HEADLINE, KICKER, STEPS } from '../../ui/src/app/story.ts';
import { renderTour, TOUR } from '../../site/tour.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8');
const workflow = read('.github', 'workflows', 'pages.yml');
const INSTALL = 'curl -fsSL https://henningfutrell.github.io/hopper/install.sh | bash';
const REPO = 'https://github.com/henningfutrell/hopper';
const OLD_INSTALL_IDS = ['podman', 'first-job', 'host', 'before', 'install', 'own-postgres', 'running', 'ui', 'github', 'windows', 'upgrade', 'remove', 'trouble', 'more'];

const out = mkdtempSync(join(tmpdir(), 'pages-'));
let index = '';
let install = '';
let css = '';

beforeAll(async () => {
  await build({ configFile: join(ROOT, 'site', 'vite.config.ts'), logLevel: 'error', build: { outDir: out, emptyOutDir: true } });
  index = readFileSync(join(out, 'index.html'), 'utf8');
  install = readFileSync(join(out, 'install.html'), 'utf8');
  const sheets = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.css'));
  expect(sheets).toHaveLength(1);
  css = readFileSync(join(out, 'assets', sheets[0] ?? ''), 'utf8');
}, 120_000);

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('the front page above the fold', () => {
  it('has the logo, the name, and what the hopper is in one line', () => {
    expect(index).toMatch(/<img[^>]*src="[^"]*hopper-logo[^"]*\.svg"/);
    expect(text(index)).toContain(KICKER);
    expect(text(index)).toContain(HEADLINE);
  });

  it('tells the three-step story the signed-out landing page tells, from the same module', () => {
    for (const step of STEPS) {
      expect(text(index)).toContain(step.title);
      expect(text(index)).toContain(step.text);
    }
    expect(read('ui', 'src', 'app', 'landing.tsx')).toContain("from './story.ts'");
  });

  it('gives the one-line install with a copy button, and links the install guide and the repository', () => {
    expect(index).toContain(`data-copy="${INSTALL}"`);
    expect(index).toContain('href="install.html"');
    expect(index).toContain(`href="${REPO}"`);
  });

  it('draws the landing page\'s backdrop: lanes of jobs going by', () => {
    expect(index).toContain('class="landing-backdrop"');
    expect((index.match(/class="landing-lane"/g) ?? []).length).toBeGreaterThan(3);
  });
});

describe('the front page below the fold', () => {
  it('tours the features, then links the docs on GitHub', () => {
    for (const feature of TOUR) expect(text(index)).toContain(feature.title);
    for (const doc of ['README.md', 'docs/deploy.md', 'docs/sign-in.md', 'docs/plugins.md', 'WHATS-NEW.md'])
      expect(index).toContain(`href="${REPO}/blob/main/${doc}"`);
  });

  it('shows a feature\'s screenshot, with alt text and its size, once docs/screenshots has it (issue #353)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shots-'));
    const first = TOUR[0];
    if (!first) throw new Error('no tour');
    expect(renderTour(dir).html).not.toContain('<img');
    mkdirSync(dir, { recursive: true });
    // A 2×1 PNG: signature, then IHDR with its width and height.
    const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000200000001080600000000000000', 'hex');
    writeFileSync(join(dir, `${first.shot}.png`), png);
    const tour = renderTour(dir);
    expect(tour.html).toMatch(new RegExp(`<img[^>]*src="screenshots/${first.shot}.png"`));
    expect(tour.html).toMatch(/<img[^>]*alt="[^"]{10,}"/);
    expect(tour.html).toMatch(/<img[^>]*width="2"[^>]*height="1"/);
    expect(tour.files).toEqual([{ fileName: `screenshots/${first.shot}.png`, path: join(dir, `${first.shot}.png`) }]);
  });
});

describe('one look for the site and the UI', () => {
  it('styles both pages with one stylesheet, built from the UI\'s own', () => {
    const linked = (html: string) => [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(linked(index)).toHaveLength(1);
    expect(linked(install)).toEqual(linked(index));
    expect(read('site', 'site.css')).toContain('@import "../ui/src/index.css"');
    expect(css).toContain('.landing-backdrop');
    expect(css).toContain('Geist Variable');
  });

  it('follows the reader\'s light or dark preference before the first paint', () => {
    for (const page of [index, install]) {
      expect(page).toMatch(/<head>[\s\S]*prefers-color-scheme: dark[\s\S]*classList\.toggle\('dark'[\s\S]*<\/head>/);
    }
  });

  it('keeps still for people who ask for less motion', () => {
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
  });

  it('shifts nothing as it loads: every image has its size', () => {
    for (const page of [index, install]) for (const img of page.match(/<img[^>]*>/g) ?? []) expect(img).toMatch(/width="\d+"[^>]*height="\d+"/);
  });

  it('loads nothing from another site', () => {
    for (const page of [index, install]) expect(page).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/);
    expect(css).not.toMatch(/url\(["']?https?:/);
  });
});

describe('what the site served before, it still serves', () => {
  it('install.sh is scripts/get.sh, compose.yaml is the container install, and the logo is at its address', () => {
    expect(readFileSync(join(out, 'install.sh'), 'utf8')).toBe(read('scripts', 'get.sh'));
    expect(readFileSync(join(out, 'compose.yaml'), 'utf8')).toBe(read('compose.yaml'));
    expect(readFileSync(join(out, 'hopper-logo.svg'), 'utf8')).toBe(read('site', 'hopper-logo.svg'));
  });

  it('sends the install page\'s old addresses on the front page (/#windows and the like) to the install page', () => {
    const head = index.slice(0, index.indexOf('</head>'));
    for (const id of OLD_INSTALL_IDS) expect(head, id).toContain(`'${id}'`);
    expect(head).toContain("location.replace('install.html'");
    const ids = new Set([...index.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const id of OLD_INSTALL_IDS) expect(ids.has(id), id).toBe(false);
  });

  it('the install page keeps its sections and its one-line install', () => {
    expect(install).toContain(`data-copy="${INSTALL}"`);
    for (const id of ['podman', 'first-job', 'windows', 'upgrade', 'remove', 'trouble']) expect(install).toContain(`id="${id}"`);
  });
});

describe('the Pages workflow', () => {
  it('builds the site and publishes site/dist', () => {
    expect(read('package.json')).toContain('"build:site"');
    expect(workflow).toMatch(/npm ci/);
    expect(workflow).toMatch(/npm run build:site/);
    expect(workflow).toMatch(/path: site\/dist\b/);
  });

  it('republishes when what the site is built from changes', () => {
    for (const path of ['site/**', 'ui/src/index.css', 'ui/src/app/story.ts', 'docs/screenshots/**', 'scripts/get.sh', 'compose.yaml'])
      expect(workflow, path).toContain(path);
  });
});
