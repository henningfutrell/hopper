// Issue #661: the section is called Decider everywhere a person sees it. No text in the repo says "minor decision":
// not the UI, the docs, WHATS-NEW, the guide, the API and CLI help, or the event descriptions. Identifiers that name
// stored data stay (the event types `minor_decision.*`, the API paths `/api/minor-decisions`); they have no space.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SELF = 'test/decider-name/no-minor-decision.test.ts';
const files = execFileSync('/usr/bin/git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
  .filter((f) => f && f !== SELF && !/\.(png|jpe?g|gif|webp|ico|woff2?|ttf)$/.test(f));

describe('the decider name (issue #661)', () => {
  it('no tracked text says "minor decision"', () => {
    const hits = files.filter((f) => { try { return /minor[\s-]+decision/i.test(readFileSync(join(ROOT, f), 'utf8').replace(/minor-decisions?(?=[/'".:`_\w])/gi, '')); } catch { return false; } });
    expect(hits).toEqual([]);
  });
});
