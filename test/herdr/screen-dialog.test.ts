// Issue #377: the question a dialog asks is the dialog, not the screen above it.
import { describe, expect, it } from 'vitest';
import { autoDenyMs, dialogText, readTurn } from '../../src/executors/herdr/screen.ts';

// As seen live (paths shortened): a permission dialog under earlier tool output.
const RM_DIALOG = [
  'apps/web 2>/dev/null; /usr/bin/git show HEAD:a…)',
  '  ⎿  added 226 packages, and audited 227 packages in 7s',
  '     45 packages are looking for funding',
  '     … +11 lines (ctrl+o to expand)',
  '  ⎿  (timeout 5m)',
  '● Bash(rm -rf /w/repo/.hopper-scratch/npmci140; W=/w/repo/…)',
  '  ⎿  Waiting…',
  ' Bash command',
  '   │ rm -rf /w/repo/.hopper-scratch/npmci140; …',
  ' │ Dangerous rm operation on working directory or its ancestor: /w/repo',
  ' ⚠ Claude Code will automatically deny this request in 1:59, unless you respond',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
].join('\n');

// A hook asks for confirmation; hook errors sit above the dialog.
const HOOK_DIALOG = [
  "  jq -r '.items[] | .id' out.json)",
  '  ⎿  UserPromptSubmit hook error',
  '  ⎿  Error: Cannot find module loader.mjs',
  '  ⎿  PreToolUse:Bash hook timed out',
  '─────────────────────────────────────────',
  ' Bash command',
  '',
  '   git push origin :refs/heads/old-branch',
  '   Delete the old branch',
  '',
  ' Hook PreToolUse:Bash requires confirmation for this command: REMOTE REF DELETION. Confirm.',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No, and tell Claude what to do differently (esc)',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');

describe('dialogText', () => {
  it('is the dialog alone: title, command, warning, countdown and options, without the output above it', () => {
    expect(dialogText(RM_DIALOG)).toBe([
      'Bash command',
      'rm -rf /w/repo/.hopper-scratch/npmci140; …',
      'Dangerous rm operation on working directory or its ancestor: /w/repo',
      '⚠ Claude Code will automatically deny this request in 1:59, unless you respond',
      'Do you want to proceed?',
      '1. Yes',
      '2. No',
    ].join('\n'));
  });

  it('starts below the dialog border, so hook errors above it stay out; the key hints are not the question', () => {
    expect(dialogText(HOOK_DIALOG)).toBe([
      'Bash command',
      'git push origin :refs/heads/old-branch',
      'Delete the old branch',
      'Hook PreToolUse:Bash requires confirmation for this command: REMOTE REF DELETION. Confirm.',
      'Do you want to proceed?',
      '1. Yes',
      '2. No, and tell Claude what to do differently (esc)',
    ].join('\n'));
  });

  it("keeps the agent's own words right above a choice", () => {
    expect(dialogText(['● Done with step 1.', '● Pick one', '  ❯ 1. Red', '    2. Blue'].join('\n'))).toBe('Pick one\n1. Red\n2. Blue');
  });

  it('without a cursor on an option, is the last block under the transcript', () => {
    expect(dialogText(['● Bash(make)', '  ⎿  Running…', '', ' Something needs you', ' Press enter'].join('\n'))).toBe('Something needs you\nPress enter');
  });
});

// Issue #376: Claude Code denies some dialogs by itself when its countdown runs out.
describe('autoDenyMs', () => {
  it('reads the countdown as minutes and seconds', () => {
    expect(autoDenyMs(RM_DIALOG)).toBe(119_000);
    expect(autoDenyMs(' ⚠ Claude Code will automatically deny this request in 0:05, to avoid blocking progress on an unattended session')).toBe(5_000);
  });

  it('reads the rounded form', () => {
    expect(autoDenyMs('Claude Code will automatically deny this request in about 2 minutes, to avoid blocking progress')).toBe(120_000);
    expect(autoDenyMs('Claude Code will automatically deny this request in about 1 second, to avoid blocking progress')).toBe(1_000);
  });

  it('is undefined for a dialog with no countdown', () => {
    expect(autoDenyMs(HOOK_DIALOG)).toBeUndefined();
  });
});

describe('the final message is not a tool call', () => {
  it('the summary skips a tool call and its output that share the block with the final message', () => {
    const screen = [
      '❯ go',
      '● Bash(O=/w/out; B=$PWD/workspace/…)',
      '  ⎿  pushed',
      '     … +3 lines (ctrl+o to expand)',
      '',
      '  Merged the pull request and verified the deploy.',
      '  HOPPER_DONE',
    ].join('\n');
    expect(readTurn(screen, 'go')).toMatchObject({ lastMarker: 'done', assistantText: 'Merged the pull request and verified the deploy.' });
  });
});
