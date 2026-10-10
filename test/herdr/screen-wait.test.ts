// Issue #483: a job blocked on something only a person or the outside world can do ends its turn with
// HOPPER_WAITING and what it waits for. The screen reads it as the job's own wait: never a question, never a
// status note.
import { describe, expect, it } from 'vitest';
import { PROTOCOL_LINES } from '../../src/job-rules/index.ts';
import { FOOTER_ANCHOR, STATUS_NOTE_NUDGE, readTurn } from '../../src/executors/herdr/screen.ts';

const ECHO = ['❯ Push the branch.', `  ${FOOTER_ANCHOR}`];
const WAIT = [
  '● The fix is committed and tested. The push needs write access.',
  '  HOPPER_WAITING',
  '  for: write access to the repository',
  '  until: a background poll of git push --dry-run, which ends when it works',
];
const END = ['✻ Worked for 4s', '──────────────', '❯ ', '──────────────'];
const screen = (...parts: string[][]): string => parts.flat().join('\n');

describe('the wait marker', () => {
  it('the protocol tells a job how to wait, and never to open a question only to wait', () => {
    const line = PROTOCOL_LINES.find((l) => l.includes('HOPPER_WAITING'));
    expect(line).toContain('for:');
    expect(line).toContain('until:');
    expect(line).toContain('Never open a question only to wait');
    expect(FOOTER_ANCHOR).toContain('HOPPER_FAILED');
  });

  it('the status note nudge names it', () => {
    expect(STATUS_NOTE_NUDGE).toContain('HOPPER_WAITING');
  });

  it('a turn that ends with it is a wait, with what it waits for and how it will know', () => {
    const turn = readTurn(screen(ECHO, WAIT, END), FOOTER_ANCHOR);
    expect(turn.lastMarker).toBe('wait');
    expect(turn.wait).toEqual({ for: 'write access to the repository', until: 'a background poll of git push --dry-run, which ends when it works' });
    expect(turn.assistantText).toBe('The fix is committed and tested. The push needs write access.');
  });

  it('until: may be left out; markdown around the marker and the field still reads', () => {
    const turn = readTurn(screen(ECHO, ['● Blocked.', '  **HOPPER_WAITING**', '  - For: `a review of the pull request`'], END), FOOTER_ANCHOR);
    expect(turn.lastMarker).toBe('wait');
    expect(turn.wait).toEqual({ for: 'a review of the pull request' });
  });

  it('a wait that names nothing it waits for is no wait: the turn is a status note', () => {
    const turn = readTurn(screen(ECHO, ['● Blocked.', '  HOPPER_WAITING'], END), FOOTER_ANCHOR);
    expect(turn.lastMarker).toBeNull();
  });

  it('markers up to `markersAfter` lines of the turn are the wait already taken: the job went on after it', () => {
    const before = readTurn(screen(ECHO, WAIT), FOOTER_ANCHOR);
    const after = readTurn(screen(ECHO, WAIT, ['● The poll ended: access is granted. Pushed the branch.'], END), FOOTER_ANCHOR, before.outputLines);
    expect(after.lastMarker).toBeNull();
    expect(after.lastLine).toBe('The poll ended: access is granted. Pushed the branch.');
    const done = readTurn(screen(ECHO, WAIT, ['● Pushed.', '  HOPPER_DONE'], END), FOOTER_ANCHOR, before.outputLines);
    expect(done.lastMarker).toBe('done');
  });
});
