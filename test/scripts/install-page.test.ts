// The install page on GitHub Pages (issue #113): site/index.html gives one install command, which
// fetches install.sh from the same site; .github/workflows/pages.yml publishes scripts/get.sh as that
// install.sh. Every hopper script the page tells you to run must exist in scripts/.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const page = readFileSync(join(ROOT, 'site', 'index.html'), 'utf8');
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'pages.yml'), 'utf8');

const INSTALL = 'curl -fsSL https://henningfutrell.github.io/hopper/install.sh | bash';

describe('the install page', () => {
  it('gives the one-line install from the Pages site, as a command to copy', () => {
    expect(page).toContain(`data-copy="${INSTALL}"`);
  });

  it('is published with scripts/get.sh as its install.sh, and republished when get.sh changes', () => {
    expect(workflow).toMatch(/cp scripts\/get\.sh site\/install\.sh/);
    expect(workflow).toMatch(/paths:.*scripts\/get\.sh/);
  });

  it('names only hopper scripts that exist', () => {
    const named = [...page.matchAll(/job-hopper\/scripts\/([\w-]+\.sh)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const script of new Set(named)) expect(existsSync(join(ROOT, 'scripts', script)), script).toBe(true);
  });

  it('loads nothing from another site', () => {
    expect(page).not.toMatch(/<(script|link)[^>]+(src|href)="https?:/);
  });
});
