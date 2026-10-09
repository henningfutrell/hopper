// A question's listed options (issue #550): the numbered lines a job's question lists, which Jev first offers as
// the options of the decision; and which option an answer names — its number, or its words.
import { describe, expect, it } from 'vitest';
import { optionNamed, questionOptions } from '../../src/minor-decisions/options.ts';

describe('questionOptions', () => {
  it('reads numbered options, in order, with their words', () => {
    expect(questionOptions('Which one?\n1. ledger\n2. journal\n  3) book')).toEqual([{ id: '1', label: 'ledger' }, { id: '2', label: 'journal' }, { id: '3', label: 'book' }]);
  });

  it('the cursor and box marks of a dialog are not part of an option', () => {
    expect(questionOptions('Trust this folder?\n│ ❯ 1. Yes, proceed │\n│   2. No, exit │')).toEqual([{ id: '1', label: 'Yes, proceed' }, { id: '2', label: 'No, exit' }]);
  });

  it('fewer than two options, or numbers out of order, are no pick', () => {
    expect(questionOptions('Which colour?')).toEqual([]);
    expect(questionOptions('Steps done:\n1. built')).toEqual([]);
    expect(questionOptions('Notes:\n2. second\n5. fifth')).toEqual([]);
  });

  it('the last run of options counts when the text lists more than one', () => {
    expect(questionOptions('Done so far:\n1. built\n2. tested\nNext?\n1. ship\n2. wait')).toEqual([{ id: '1', label: 'ship' }, { id: '2', label: 'wait' }]);
  });
});

describe('optionNamed', () => {
  const options = [{ id: '1', label: 'ledger' }, { id: '2', label: 'Journal entry' }];
  it('an option by its number or its words', () => {
    expect(optionNamed(options, '2')).toBe('2');
    expect(optionNamed(options, ' 1. ')).toBe('1');
    expect(optionNamed(options, 'journal  entry')).toBe('2');
    expect(optionNamed(options, 'something else')).toBeUndefined();
    expect(optionNamed(options, '7')).toBeUndefined();
  });
});
