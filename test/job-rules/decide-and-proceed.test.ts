// Decide and proceed (issue #1059): a job with a clear path inside the standing rules takes it and goes on to the pull
// request. It asks a person only in the cases the decisions line names, and says which rule does not settle it. A proposal
// says so with a Needs a person: line; without one, the hopper continues with its one recommended path.
import { describe, expect, it } from 'vitest';
import { DECIDE_LINE, PROTOCOL_LINES } from '../../src/job-rules/index.ts';
import { needsAPerson } from '../../src/domain/types.ts';

describe('the decisions line', () => {
  it('is a fixed protocol line, before the question line, so every job is told it', () => {
    expect(PROTOCOL_LINES[0]).toBe(DECIDE_LINE);
    expect(PROTOCOL_LINES[1]).toContain('HOPPER_QUESTION');
  });

  it('names the standing rules, the only cases for a person, the manual check, and the decisions made', () => {
    expect(DECIDE_LINE).toMatch(/^\[hopper decisions\] /);
    for (const words of [
      'AGENTS.md', 'take it and continue to the pull request',
      'the paths differ in security or cost in a way the rules do not settle', 'a credential or access from outside', 'the change is destructive',
      'which rule does not settle it', 'write the manual check in the pull request body', 'Decisions made',
    ]) expect(DECIDE_LINE).toContain(words);
  });

  it('the proposal protocol tells the job how to say a person must decide', () => {
    const line = PROTOCOL_LINES.find((l) => l.includes('containing only: HOPPER_PROPOSAL'))!;
    expect(line).toContain('Needs a person:');
  });
});

describe('Needs a person in a proposal', () => {
  it('reads the reason from its own line, labels and marks aside', () => {
    expect(needsAPerson('TL;DR: x\nNeeds a person: a credential is needed.\nContext: y')).toBe('a credential is needed.');
    expect(needsAPerson('**Needs a person:** the change is destructive.')).toBe('the change is destructive.');
    expect(needsAPerson('- needs a person: cost')).toBe('cost');
  });

  it('reads none from a missing line, an empty one, or one that says no', () => {
    expect(needsAPerson('TL;DR: x\nContext: y')).toBeUndefined();
    expect(needsAPerson('Needs a person:')).toBeUndefined();
    expect(needsAPerson('Needs a person: no')).toBeUndefined();
    expect(needsAPerson('Needs a person: none.')).toBeUndefined();
    expect(needsAPerson('Summary: this never needs a person: it is safe.')).toBeUndefined();
  });
});
