// Issue #790: the help pages on the GitHub Pages site. `npm run build:site` renders help/*.md — the one source the
// daemon serves at /help/ (issue #782) — into site/dist/help/, in the site's look, version-matched to the checkout it
// is built from. The text is never copied: a page on the site is its help page, rendered at build time, and its
// Markdown beside it is the file as written. The site imports nothing of src/, so it renders the pages itself; these
// tests hold its headings and its links to the book's.
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';
import { HELP_DIR, loadHelpBook } from '../../src/help/book.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8');
const book = loadHelpBook(HELP_DIR);
const version = (JSON.parse(read('package.json')) as { version: string }).version;

const out = mkdtempSync(join(tmpdir(), 'help-site-'));
const page = (slug: string): string => readFileSync(join(out, 'help', `${slug === 'index' ? 'index' : slug}.html`), 'utf8');
let index = '';

beforeAll(async () => {
  await build({ configFile: join(ROOT, 'site', 'vite.config.ts'), logLevel: 'error', build: { outDir: out, emptyOutDir: true } });
  index = readFileSync(join(out, 'index.html'), 'utf8');
}, 120_000);

const ids = (html: string): string[] => [...html.matchAll(/<h[1-6] id="([^"]+)"/g)].map((m) => m[1]!);
const hrefs = (html: string): string[] => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
const main = (html: string): string => html.slice(html.indexOf('<main'), html.indexOf('</main>'));

describe('the help pages on the site', () => {
  it('has every page of the help book, and its contents page, as HTML with its title', () => {
    for (const p of [book.index, ...book.pages]) {
      const html = page(p.slug);
      expect(html, p.slug).toContain(`<title>${p.title.replace(/&/g, '&amp;')} · hopper help</title>`);
    }
  });

  it('serves each page\'s Markdown beside it, as written: the text is never copied into the site', () => {
    for (const p of [book.index, ...book.pages]) expect(readFileSync(join(out, 'help', `${p.slug}.md`), 'utf8')).toBe(p.markdown);
    expect(readdirSync(join(ROOT, 'site')).some((f) => f.endsWith('.md'))).toBe(false);
  });

  it('gives each heading the id the daemon gives it, so a link to a section works on both', () => {
    for (const p of [book.index, ...book.pages]) expect(ids(main(page(p.slug))), p.slug).toEqual(ids(p.html));
  });

  it('sends a link to another help page to that page on the site', () => {
    const linking = book.pages.find((p) => /\]\([a-z0-9-]+\.md#[\w-]+\)/.test(p.markdown));
    expect(linking).toBeDefined();
    const [, target, hash] = /\]\(([a-z0-9-]+)\.md(#[\w-]+)\)/.exec(linking!.markdown)!;
    expect(hrefs(main(page(linking!.slug)))).toContain(`${target}.html${hash}`);
    for (const h of hrefs(main(page('index')))) expect(h, h).not.toMatch(/^\/help\//);
    for (const p of book.pages) expect(hrefs(main(page('index')))).toContain(`${p.slug}.html`);
  });

  it('lists every page beside the text, in the contents page\'s order', () => {
    const nav = (html: string) => html.slice(html.indexOf('<nav aria-label="Help pages"'), html.indexOf('</nav>', html.indexOf('<nav aria-label="Help pages"')));
    const listed = hrefs(nav(page('lanes'))).filter((h) => h.endsWith('.html') && h !== 'index.html');
    expect(listed).toEqual(book.pages.map((p) => `${p.slug}.html`));
    expect(nav(page('lanes'))).toContain('aria-current="page"');
  });

  it('says the version it was built from at the foot of each page', () => {
    expect(page('lanes')).toContain(`hopper ${version}`);
  });

  it('wears the site\'s look: the one stylesheet the other pages link, light or dark as the system is', () => {
    const linked = (html: string) => [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]!.replace(/^\.\.\//, ''));
    expect(linked(page('lanes'))).toHaveLength(1);
    expect(linked(page('lanes'))).toEqual(linked(index).map((h) => h.replace(/^\.\//, '')));
    expect(page('lanes')).toMatch(/<head>[\s\S]*prefers-color-scheme: dark[\s\S]*<\/head>/);
    expect(page('lanes')).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/);
  });

  it('is linked from the front page and the user guide', () => {
    expect(index).toContain('href="help/"');
    expect(readFileSync(join(out, 'guide.html'), 'utf8')).toContain('href="help/"');
  });

  it('is rendered by the site itself: nothing of src/ is imported', () => {
    for (const f of readdirSync(join(ROOT, 'site')).filter((f) => f.endsWith('.ts'))) expect(read('site', f), f).not.toMatch(/from ['"]\.\.\/src\//);
  });

  it('republishes when a help page changes', () => {
    expect(read('.github', 'workflows', 'pages.yml')).toContain('help/**');
  });
});
