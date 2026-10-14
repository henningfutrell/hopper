// Issue #556: the user guide on the GitHub Pages site. site/guide.html says, for someone running the hopper,
// what each part of its work with jobs is, when you see it, what you can do and what happens next: research
// and proposals, phase shifts, the blast-radius gate, Jev's small decisions, Needs a person, parking,
// priority, how Claude is kept from waiting on a key press, cleanup and failures, client self-update and the
// usage limits. It is built with the other pages, wears their look, and the front page, the install page and
// the README link it.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8');

/** One section per part the guide covers, by its anchor. */
const SECTIONS = [
  'research', 'proposals', 'where-they-show', 'phase-shifts', 'blast-radius', 'jev', 'needs-a-person',
  'parking', 'priority', 'no-key-press', 'cleanup', 'failures', 'client-update', 'usage',
];

const out = mkdtempSync(join(tmpdir(), 'guide-'));
let guide = '';
let index = '';
let install = '';

beforeAll(async () => {
  await build({ configFile: join(ROOT, 'site', 'vite.config.ts'), logLevel: 'error', build: { outDir: out, emptyOutDir: true } });
  guide = readFileSync(join(out, 'guide.html'), 'utf8');
  index = readFileSync(join(out, 'index.html'), 'utf8');
  install = readFileSync(join(out, 'install.html'), 'utf8');
}, 120_000);

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('the user guide', () => {
  it('is built beside the other pages, with their one stylesheet', () => {
    const linked = (html: string) => [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(linked(guide)).toHaveLength(1);
    expect(linked(guide)).toEqual(linked(index));
  });

  it('has a section for each part it covers, and lists them all at the top', () => {
    for (const id of SECTIONS) {
      expect(guide, id).toMatch(new RegExp(`<h2 id="${id}"`));
      expect(guide, id).toContain(`href="#${id}"`);
    }
  });

  it('names the labels a person puts on an issue', () => {
    for (const label of ['hopper:research', 'hopper:proposal', 'hopper:high', 'hopper:low', 'hopper:backburner'])
      expect(text(guide), label).toContain(label);
  });

  it('follows the reader\'s light or dark preference, and loads nothing from another site', () => {
    expect(guide).toMatch(/<head>[\s\S]*prefers-color-scheme: dark[\s\S]*<\/head>/);
    expect(guide).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/);
  });

  it('is linked from the front page, the install page and the README', () => {
    expect(index).toContain('href="guide.html"');
    expect(install).toContain('href="guide.html"');
    expect(read('README.md')).toContain('https://henningfutrell.github.io/hopper/guide.html');
  });
});
