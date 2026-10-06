import { describe, expect, it } from 'vitest';
import { inputBoxText } from '../../src/executors/herdr/screen.ts';

const SEP = '─'.repeat(40);
const FOOT = '  ⏵⏵ bypass permissions on (shift+tab to cycle)';

describe('inputBoxText: what sits unsent in Claude\'s input box', () => {
  it('a pasted prompt never submitted (real capture)', () => {
    expect(inputBoxText(['● earlier', SEP, '❯ [Pasted text #1 +29 lines]', SEP, FOOT].join('\n'))).toBe('[Pasted text #1 +29 lines]');
  });

  it('typed text over several lines', () => {
    expect(inputBoxText([SEP, '❯ first line', '  second line', SEP, FOOT].join('\n'))).toBe('first line\nsecond line');
  });

  it('an empty box is empty', () => {
    expect(inputBoxText([SEP, '❯ ', SEP, FOOT].join('\n'))).toBe('');
  });

  it('a placeholder suggestion is not input', () => {
    expect(inputBoxText([SEP, '❯ Try "refactor the parser"', SEP, FOOT].join('\n'))).toBe('');
  });

  it('no input box on screen (a dialog) is empty', () => {
    expect(inputBoxText(['● Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n'))).toBe('');
  });
});
