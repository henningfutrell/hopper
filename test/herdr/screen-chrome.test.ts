import { describe, expect, it } from 'vitest';
import { readTurn } from '../../src/executors/herdr/screen.ts';

// The CLI's chrome that is never job progress (issue #360). Captures from live job panes.

const CHROME = [
  '──────────────────────────────',
  '❯ ',
  '──────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
];

const screen = (...parts: string[][]): string => parts.flat().join('\n');

describe('readTurn progress under the CLI chrome', () => {
  // Real capture (issue #360): under the spinner sit a wrapped tip and the CLI's own update notice,
  // right-aligned above the input box. None of it is the agent's activity.
  const UNDER_SPINNER = [
    '✻ Actualizing… (22m 22s · ↓ 69.9k tokens)',
    '  ⎿  Tip: Use /btw to ask a quick side question',
    "     without interrupting Claude's current work",
    '             ✔ Update installed · Restart to update',
  ];

  it('does not report the update notice or a wrapped tip under the spinner as progress', () => {
    const lines = ['❯ go', '● Running 1 shell command · 5s…', '  ⎿  $ npx vitest run', '     (ctrl+b to run in background)', '', ...UNDER_SPINNER];
    const t = readTurn(screen(lines, CHROME), 'go');
    expect(t.lastLine).toBe('$ npx vitest run');
  });

  it.each([
    ['             ✔ Update installed · Restart to update'],
    ['  ✗ Auto-update failed · Try claude doctor or npm i -g @anthropic-ai/claude-code'],
  ])('does not report the CLI notice %j as progress when no spinner shows', (notice) => {
    const t = readTurn(screen(['❯ go', '● Writing hello.txt', '', notice], CHROME), 'go');
    expect(t.lastLine).toBe('Writing hello.txt');
  });

  it.each([
    ['* Crafting… (18m 43s · ↓ 41.8k tokens)'],
    ['· Hashing… (1h 2m · ↓ 86.3k tokens)'],
  ])('does not report the tip under the plain-glyph spinner %j as progress (seen live)', (spinner) => {
    const lines = ['❯ go', '● Bash(git show)', '  ⎿  grep "^+" | head -20', '', spinner, ...UNDER_SPINNER.slice(1)];
    const t = readTurn(screen(lines, CHROME), 'go');
    expect(t.lastLine).toBe('grep "^+" | head -20');
  });

  it('does not report the truncation mark of a long command as progress (seen live)', () => {
    const lines = ['❯ go', "● Bash(python3 - <<'EOF'", "  ⎿  $ python3 - <<'EOF'", "     p='a.ts'", '     …', ''];
    const t = readTurn(screen(lines, CHROME), 'go');
    expect(t.lastLine).toBe("p='a.ts'");
  });

  it.each([['     (12s)'], ['     (1m 5s)']])('does not report the elapsed timer %j of a running command as progress (seen live)', (timer) => {
    const lines = ['❯ go', '● Running 1 shell command…', '  ⎿  $ npm test', timer, '     (ctrl+b to run in background)', ''];
    const t = readTurn(screen(lines, CHROME), 'go');
    expect(t.lastLine).toBe('$ npm test');
  });

  it('reads the marker of a turn that ends above the update notice', () => {
    const t = readTurn(screen(['❯ go', '● All done.', '  HOPPER_DONE', '', '             ✔ Update installed · Restart to update'], CHROME), 'go');
    expect(t.lastMarker).toBe('done');
    expect(t.assistantText).toBe('All done.');
    expect(t.lastLine).toBe('All done.');
  });
});
