// The help book (issue #782): the help pages under help/, one Markdown source read twice — as HTML for a
// person and as Markdown for an agent. Its contents page orders the pages; a page it does not list, or a
// link to a page that is not there, is a problem the build must not ship.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HELP_DIR, loadHelpBook } from '../../src/help/book.ts';

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

function book(files: Record<string, string>) {
  dir = mkdtempSync(join(tmpdir(), 'help-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return loadHelpBook(dir);
}

describe('loadHelpBook', () => {
  it('orders the pages as the contents page links them, each with its title and summary', () => {
    const b = book({
      'index.md': '# Help\n\nStart here.\n\n- [Vault](vault.md)\n- [Lanes](lanes.md)\n',
      'lanes.md': '# Lanes\n\nA lane is a slot\nfor one job.\n\n## Caps\n\nText.\n',
      'vault.md': '# The vault\n\nSecrets for jobs.\n',
    });
    expect(b.problems).toEqual([]);
    expect(b.pages.map((p) => p.slug)).toEqual(['vault', 'lanes']);
    expect(b.pages[1]).toEqual(expect.objectContaining({ title: 'Lanes', summary: 'A lane is a slot for one job.' }));
    expect(b.index.title).toBe('Help');
  });

  it('renders a link to another page to its help URL, and gives every heading an id to link to', () => {
    const b = book({
      'index.md': '# Help\n\n- [Vault](vault.md)\n',
      'vault.md': '# The vault\n\nSee [the index](index.md) and [grants](vault.md#vault-grants), or [the web](https://example.org/x.md).\n\n## Vault grants\n',
    });
    const html = b.pages[0]!.html;
    expect(html).toContain('href="/help/"');
    expect(html).toContain('href="/help/vault#vault-grants"');
    expect(html).toContain('href="https://example.org/x.md"');
    expect(html).toContain('<h2 id="vault-grants">Vault grants</h2>');
  });

  it('names a page the contents page does not list, and a link to a page that is not there', () => {
    const b = book({
      'index.md': '# Help\n\n- [Vault](vault.md)\n- [Gone](gone.md)\n',
      'vault.md': '# The vault\n\nSee [lanes](lanes.md).\n',
      'orphan.md': '# Orphan\n\nNobody links here.\n',
    });
    expect(b.problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/index\.md links gone\.md/),
      expect.stringMatching(/vault\.md links lanes\.md/),
      expect.stringMatching(/orphan\.md is not on the contents page/),
    ]));
    expect(b.pages.map((p) => p.slug)).toEqual(['vault', 'orphan']);
  });

  it('is empty, with its problem said, when the build has no help directory', () => {
    const b = loadHelpBook(join(tmpdir(), 'no-such-help-dir'));
    expect(b.pages).toEqual([]);
    expect(b.problems).toEqual([expect.stringMatching(/no help pages/)]);
  });
});

describe('the help pages this build ships', () => {
  it('have no problems: every page is on the contents page, every link names a page that is there', () => {
    const b = loadHelpBook(HELP_DIR);
    expect(b.problems).toEqual([]);
    expect(b.pages.length).toBeGreaterThanOrEqual(9);
    for (const p of b.pages) {
      expect(p.title, p.slug).toBeTruthy();
      expect(p.summary.length, p.slug).toBeGreaterThan(20);
    }
  });
});
