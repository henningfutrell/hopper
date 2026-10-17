// The core docs are never empty (issue #466). Twice a base merge left docs/design.md, docs/glossary.md and
// docs/hopper-io-security.md as 0-byte files on the landing branch, and nothing failed. This test fails then.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CORE_DOCS: readonly { path: string; title: string; mustHold: readonly string[] }[] = [
  { path: 'docs/design.md', title: '# hopper — design', mustHold: ['## The hopper.io state snapshot', '**What hopper.io would get**'] },
  { path: 'docs/glossary.md', title: '# hopper glossary', mustHold: ['**hopper.io state snapshot**'] },
  { path: 'docs/hopper-io-security.md', title: '# hopper.io — threat model, account isolation and privacy', mustHold: ['## Rules', '## What is built', '**The hopper.io state snapshot and what hopper.io would get**'] },
];

describe('the core docs', () => {
  for (const doc of CORE_DOCS) {
    it(`${doc.path} has its title and its sections`, () => {
      const text = readFileSync(new URL(`../../${doc.path}`, import.meta.url), 'utf8');
      expect(text.split('\n', 1)[0]).toBe(doc.title);
      for (const s of doc.mustHold) expect(text).toContain(s);
    });
  }
});
