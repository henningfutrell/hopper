// Issue #353: the README, the install page and the Pages site's tour show screenshots of a busy hopper,
// made by one command (`npm run screenshots`, scripts/screenshots/) into docs/screenshots. Every image
// shown exists and has alt text, every screenshot is shown somewhere, and each stays small.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderTour, TOUR } from '../../site/tour.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const DIR = join(ROOT, 'docs', 'screenshots');
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8');
const shots = (): string[] => readdirSync(DIR).filter((f) => f.endsWith('.webp'));

/** Every <img> or Markdown image naming docs/screenshots: its file name and alt text. */
function images(doc: string): { file: string; alt: string }[] {
  const html = [...doc.matchAll(/<img\b[^>]*>/g)].map((m) => m[0])
    .filter((tag) => tag.includes('docs/screenshots/'))
    .map((tag) => ({ file: /docs\/screenshots\/([\w.-]+)/.exec(tag)![1]!, alt: /\balt="([^"]*)"/.exec(tag)?.[1] ?? '' }));
  const md = [...doc.matchAll(/!\[([^\]]*)\]\(docs\/screenshots\/([\w.-]+)\)/g)].map((m) => ({ file: m[2]!, alt: m[1]! }));
  return [...html, ...md];
}

const README = images(read('README.md'));
const INSTALL = images(read('site', 'install.html'));

describe('the screenshots', () => {
  it('are made by one command', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.screenshots).toBe('node scripts/screenshots/capture.ts');
    expect(read('README.md')).toContain('npm run screenshots');
  });

  it('give every card of the Pages site\'s tour its screenshot, with alt text', () => {
    const { html, files } = renderTour(DIR);
    expect(files.map((f) => f.fileName).sort()).toEqual(TOUR.map((t) => `screenshots/${t.shot}.webp`).sort());
    for (const t of TOUR) {
      expect(t.alt.length).toBeGreaterThan(20);
      expect(html).toContain(`alt="${t.alt.replace(/'/g, '&#x27;')}"`);
    }
  });

  it('show in the README and on the install page, each existing and with alt text', () => {
    expect(README.length).toBeGreaterThanOrEqual(8);
    expect(INSTALL.length).toBeGreaterThanOrEqual(3);
    for (const { file, alt } of [...README, ...INSTALL]) {
      expect(shots(), file).toContain(file);
      expect(alt.length, file).toBeGreaterThan(20);
    }
  });

  it('are each shown somewhere, and stay small', () => {
    const shown = new Set([...README, ...INSTALL].map((i) => i.file).concat(TOUR.map((t) => `${t.shot}.webp`)));
    for (const f of shots()) {
      expect(shown, f).toContain(f);
      expect(statSync(join(DIR, f)).size, f).toBeLessThan(250_000);
    }
  });
});
