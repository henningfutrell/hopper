// What's new (issue #104): the plain-language bullets of WHATS-NEW.md, and which of them an update brings.
// Issue #824: a change adds its bullets in a fragment of whats-new/, the release assembly moves them into
// WHATS-NEW.md, and the pull request check refuses a direct edit of WHATS-NEW.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allBullets, assemble, breaksPlainWords, bullets, newSince, type Notes, problems, readNotes } from '../../src/update/whats-new.ts';

const FILE = "# What's new\n\nWritten for people who use the hopper.\n\n- Older news.\n- Oldest news.\n";
const notes = (fragments: Record<string, string[]>, file = FILE): Notes => ({
  file,
  fragments: Object.entries(fragments).map(([name, lines]) => ({ name, text: lines.map((l) => `- ${l}\n`).join('') })),
});

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

describe("what's new fragments (issue #824)", () => {
  it('reads the fragments first, the higher issue number first, then WHATS-NEW.md; other files are not fragments', () => {
    const n = notes({ '9.md': ['Nine.'], '824.md': ['Pause.', 'Resume.'], '824-b.md': ['B.'], '10.md': ['Ten.'], 'README.md': ['How to.'], 'x.md': ['X.'] });
    expect(allBullets(n)).toEqual(['Pause.', 'Resume.', 'B.', 'Ten.', 'Nine.', 'Older news.', 'Oldest news.']);
    expect(allBullets(notes({}, ''))).toEqual([]);
  });

  it('assembly puts the fragments above the first line of WHATS-NEW.md, in the same order: What\'s new reads the same', () => {
    const n = notes({ '9.md': ['Nine.'], '10.md': ['Ten.'] });
    const file = assemble(n);
    expect(file).toBe("# What's new\n\nWritten for people who use the hopper.\n\n- Ten.\n- Nine.\n- Older news.\n- Oldest news.\n");
    expect(bullets(file)).toEqual(allBullets(n));
    expect(assemble(notes({ '1.md': ['First.'] }, "# What's new\n"))).toBe("# What's new\n\n- First.\n");
  });

  it('the check passes a new fragment, and the assembly that moves fragments into WHATS-NEW.md', () => {
    const base = notes({ '9.md': ['Nine.'] });
    expect(problems(base, notes({ '9.md': ['Nine.'], '10.md': ['Ten.'] }))).toEqual([]);
    expect(problems(base, { file: assemble(base), fragments: [] })).toEqual([]);
    expect(problems(base, base)).toEqual([]);
  });

  it('the check refuses a line added to WHATS-NEW.md directly, and says to use a fragment', () => {
    const base = notes({});
    const head = { ...base, file: FILE.replace('- Older news.', '- Sneaked in.\n- Older news.') };
    expect(problems(base, head)).toEqual(['WHATS-NEW.md got a line directly: put it in whats-new/<issue number>.md instead: "Sneaked in."']);
  });

  it('the check refuses a released line that changed or went away, in WHATS-NEW.md or in a fragment', () => {
    const base = notes({ '9.md': ['Nine.'] });
    expect(problems(base, notes({ '9.md': ['Nine, now better.'] }))).toEqual(['a released line changed or went away; never edit one: "Nine."']);
    expect(problems(base, notes({ '9.md': ['Nine.'] }, FILE.replace('- Oldest news.\n', '')))).toEqual(['a released line changed or went away; never edit one: "Oldest news."']);
  });

  it('the check passes a revert that deletes a whole fragment; an assembly that drops its line is refused', () => {
    const base = notes({ '9.md': ['Nine.'], '10.md': ['Ten.'] });
    expect(problems(base, notes({ '10.md': ['Ten.'] }))).toEqual([]);
    expect(problems(base, { file: assemble(notes({ '10.md': ['Ten.'] })), fragments: [] })).toEqual(['a released line changed or went away; never edit one: "Nine."']);
  });

  it('the check refuses a fragment with a wrong name or no line, and a line twice', () => {
    const base = notes({});
    expect(problems(base, notes({ 'notes.md': ['A.'], '12.md': [], 'README.md': [] }))).toEqual([
      'whats-new/notes.md: name a fragment <issue number>.md or <issue number>-<word>.md',
      'whats-new/12.md: has no "- " line',
    ]);
    expect(problems(base, notes({ '12.md': ['Older news.'] }))).toEqual(['a line is in What\'s new twice: "Older news."']);
  });
});

describe("what's new in plain words (issue #1483)", () => {
  it('the check refuses a new line with an issue number, a hash, a prefix, a file name or a code word', () => {
    const base = notes({});
    for (const line of ['Fixes #12.', 'Reverts 2ff398333026.', 'Machines: a new card.', 'Edit hopper.yaml.', 'Run `hopper`.']) {
      expect(problems(base, notes({ '12.md': [line] }))).toEqual([`a line is not in plain words: no issue numbers, hashes, prefixes, file names or code words: "${line}"`]);
    }
    expect(problems(base, notes({ '12.md': ['You can pause the queue.'] }))).toEqual([]);
  });

  it('a merged line that is not in plain words may be written again in plain words; a plain one may not change', () => {
    const base = notes({ '12.md': ['Machines: a new card.', 'You can pause the queue.'] });
    expect(problems(base, notes({ '12.md': ['The Machines page has a new card.', 'You can pause the queue.'] }))).toEqual([]);
    // A pull request that leaves such a merged line as it is passes: the check names only the lines it adds.
    expect(problems(base, notes({ '12.md': ['Machines: a new card.', 'You can pause all queues.'] }))).toEqual([
      'a released line changed or went away; never edit one: "You can pause the queue."',
    ]);
  });
});

describe("What's new of this repository", () => {
  const ROOT = join(import.meta.dirname, '..', '..');

  it('speaks plainly: no issue or pull request numbers, commit hashes, commit prefixes or file names', () => {
    const lines = allBullets(readNotes(ROOT));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(breaksPlainWords(line), line).toBe(false);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('has only well-named fragments, and readNotes reads WHATS-NEW.md like the file it is', () => {
    const n = readNotes(ROOT);
    expect(problems(n, n)).toEqual([]);
    expect(bullets(n.file)).toEqual(bullets(readFileSync(join(ROOT, 'WHATS-NEW.md'), 'utf8')));
  });
});
