// Claude's select dialogs without numbers (issue #534): its startup dialogs, read as a question and answered with arrows.
import { describe, expect, it } from 'vitest';
import { importsDialog, trustDialog } from '../../src/executors/herdr/fake-screens.ts';
import { dialogText } from '../../src/executors/herdr/screen.ts';
import { selectKeys } from '../../src/executors/herdr/select-dialog.ts';

const screen = (dialog: string[]): string => ['$ claude --session-id 1', ...dialog, '─'.repeat(40), '❯ ', '─'.repeat(40)].join('\n');

describe('select dialogs without numbers', () => {
  it('the question is the dialog from its border, its options numbered, no key hints', () => {
    const text = dialogText(screen(importsDialog('/home/dev/work/AGENTS.md')));
    expect(text.split('\n')[0]).toBe('Allow external CLAUDE.md file imports?');
    expect(text).toContain('/home/dev/work/AGENTS.md');
    expect(text.endsWith('1. No, disable external imports\n2. Yes, allow external imports')).toBe(true);
    expect(text).not.toContain('Enter to confirm');
    expect(text).not.toContain('$ claude');
  });

  it('an answer naming an option by number or by its words picks it with arrows from the cursor, then Enter', () => {
    const trust = screen(trustDialog('/w'));
    expect(selectKeys(trust, '2')).toEqual({ keys: ['down', 'enter'], option: 2 });
    expect(selectKeys(trust, ' yes, I TRUST this folder. ')).toEqual({ keys: ['down', 'enter'], option: 2 });
    expect(selectKeys(trust, '1')).toEqual({ keys: ['enter'], option: 1 });
    const moved = trust.replace(' ❯ No, exit', '   No, exit').replace('   Yes, I trust', ' ❯ Yes, I trust');
    expect(selectKeys(moved, 'No, exit')).toEqual({ keys: ['up', 'enter'], option: 1 });
  });

  it('names none: no keys; a numbered dialog or no dialog is not a select', () => {
    const trust = screen(trustDialog('/w'));
    expect(selectKeys(trust, '3')).toBeUndefined();
    expect(selectKeys(trust, 'maybe')).toBeUndefined();
    expect(selectKeys(screen([' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel']), '1')).toBeUndefined();
    expect(selectKeys('$ ls\nREADME.md', '1')).toBeUndefined();
  });
});
