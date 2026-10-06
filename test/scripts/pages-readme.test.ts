// Issue #88: the GitHub Pages site is the project's public home. Its front page, site/index.html, is
// README.md rendered by scripts/build-pages.ts, with the install there: the one-line install and the
// step-by-step install page (site/install.html) beside it. The page is committed, so the Pages workflow
// publishes it as it publishes the rest of site/.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPages, renderReadme } from '../../scripts/build-pages.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'pages.yml'), 'utf8');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const INSTALL = 'curl -fsSL https://henningfutrell.github.io/hopper/install.sh | bash';

const out = mkdtempSync(join(tmpdir(), 'pages-'));
buildPages(ROOT, out);
const page = readFileSync(join(out, 'index.html'), 'utf8');
const ids = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const text = (html: string): string =>
  html.replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const headings = [...page.matchAll(/<h[23] id="[^"]+">(.*?)<\/h[23]>/g)].map((m) => text(m[1] ?? ''));

describe('the README as the Pages front page', () => {
  it('renders every section of the README', () => {
    for (const heading of readme.matchAll(/^#{2,3} (.+)$/gm)) expect(headings).toContain(heading[1]?.replace(/`/g, ''));
  });

  it('gives each heading the id GitHub gives it, so every in-page link lands', () => {
    expect(ids).toContain('run-it');
    expect(ids).toContain('with-podman-recommended');
    expect(ids).toContain('on-this-host-systemd---user-from-a-clone');
    for (const link of page.matchAll(/href="#([^"]+)"/g)) expect(ids, link[1]).toContain(link[1]);
  });

  it('points links to repository files at GitHub, and the logo at the site', () => {
    expect(page).not.toMatch(/href="(?!https?:|#|install\.html|hopper-logo\.svg|mailto:)[^"]+"/);
    expect(page).toContain('href="https://github.com/henningfutrell/hopper/blob/main/docs/sign-in.md#github"');
    expect(page).toContain('src="hopper-logo.svg"');
  });

  it('puts the install on the page: the one-line install to copy, and the step-by-step install page', () => {
    expect(page).toContain(`data-copy="${INSTALL}"`);
    expect(page).toContain('href="install.html"');
  });

  it('sends the install page\'s old addresses (/#windows and the like) to the install page', () => {
    const install = readFileSync(join(ROOT, 'site', 'install.html'), 'utf8');
    const installIds = [...install.matchAll(/<h[23] id="([^"]+)"/g)].map((m) => m[1] ?? '');
    const moved = installIds.filter((id) => !ids.has(id));
    expect(moved).toContain('windows');
    for (const id of moved) expect(page, id).toContain(`'${id}'`);
    expect(page).toContain("location.replace('install.html'");
  });

  it('loads nothing from another site', () => {
    expect(page).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/);
  });

  it('escapes what the README writes as code', () => {
    expect(renderReadme('Run `<b>`.\n')).toContain('<code>&lt;b&gt;</code>');
  });
});

describe('the committed front page', () => {
  it('is the README as it is now: run `node scripts/build-pages.ts site` after changing README.md', () => {
    expect(readFileSync(join(ROOT, 'site', 'index.html'), 'utf8')).toBe(page);
  });

  it('is published with the rest of site/', () => {
    expect(workflow).toMatch(/paths:.*site\/\*\*/);
    expect(workflow).toMatch(/path: site\b/);
  });
});
