// Issue #1958: the screen-drift check compares a recorded screen with the real one, line by line, whitespace aside.
import { describe, expect, it } from 'vitest';
import { bypassDialog } from '../../src/executors/herdr/fake-screens.ts';
import { screenDrift } from './screen-drift.ts';

/** The bypass warning as Claude Code 2.1.292 renders it in a 94-column pane: wrapped, indented, with lines the recording leaves out. */
const REAL_BYPASS = [
  '─'.repeat(94),
  '  WARNING: Claude Code running in Bypass Permissions mode', '',
  '  In Bypass Permissions mode, Claude Code will not ask for your approval before running',
  '  potentially dangerous commands.',
  '  This mode should only be used in a sandboxed container/VM that has restricted internet',
  '  access and can easily be restored if damaged.', '',
  '  By proceeding, you accept all responsibility for actions taken while running in Bypass',
  '  Permissions mode.', '', '  https://code.claude.com/docs/en/security', '',
  '  ❯ No, exit', '    Yes, I accept', '', '  Enter to confirm · Esc to cancel',
].join('\n');

describe('the screen-drift check', () => {
  it('passes a real screen that wraps, indents and adds lines to the recording', () => {
    expect(screenDrift(bypassDialog(), REAL_BYPASS)).toBeUndefined();
  });

  it('names the first recorded line the real screen no longer shows', () => {
    expect(screenDrift(bypassDialog(), REAL_BYPASS.replace('Yes, I accept', 'Yes, I agree'))).toBe('   Yes, I accept');
  });

  it('passes a long path the pane breaks mid-word', () => {
    expect(screenDrift([' /home/user/a-long-directory/w'], ' /home/user/a-long-direc\n tory/w')).toBeUndefined();
  });

  it('passes over blank lines and the rules a pane draws at its own width', () => {
    expect(screenDrift(['─'.repeat(40), '', ' Enter to confirm'], 'Enter to confirm')).toBeUndefined();
  });
});
