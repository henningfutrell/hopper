// What's new (issue #104): the plain-language bullets of WHATS-NEW.md, and which of them an update brings.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bullets, newSince } from '../../src/update/whats-new.ts';

describe("what's new", () => {
  it('reads the bullets of WHATS-NEW.md, in order; headings and other lines are not bullets', () => {
    const text = "# What's new\n\nWritten for people who use the hopper.\n\n## October\n\n- You can pause the queue.\n* Jobs show their machine.  \n-not a bullet\n- \n";
    expect(bullets(text)).toEqual(['You can pause the queue.', 'Jobs show their machine.']);
    expect(bullets('')).toEqual([]);
  });

  it('an update brings the bullets the installed version does not have, newest first', () => {
    expect(newSince(['B.', 'A.'], ['D.', 'C.', 'B.', 'A.'])).toEqual(['D.', 'C.']);
    expect(newSince([], ['B.', 'A.'])).toEqual(['B.', 'A.']);
    expect(newSince(['B.', 'A.'], ['B.', 'A.'])).toEqual([]);
  });
});

describe('WHATS-NEW.md of this repository', () => {
  it('speaks plainly: no issue or pull request numbers, commit hashes, commit prefixes or file names', () => {
    const lines = bullets(readFileSync(new URL('../../WHATS-NEW.md', import.meta.url), 'utf8'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/#\d+|\b[0-9a-f]{7,40}\b|^\w+(\(.*\))?!?:|\b[\w-]+\.(ts|tsx|sh|md|yaml|json)\b|`/);
    }
    expect(new Set(lines).size).toBe(lines.length);
  });
});
