// Issue #537: an agent asked for a proposal ends its message with HOPPER_PROPOSAL. The screen and the print-mode
// executors read it as a proposal, never as a question; its parts are read from their labels; a job asked for a
// proposal is told so after the job rules, and every job learns the marker from the protocol.
import { describe, expect, it } from 'vitest';
import { proposalSections } from '../../src/domain/types.ts';
import { FOOTER_ANCHOR, readTurn } from '../../src/executors/herdr/screen.ts';
import { outcomeOf } from '../../src/executors/print-agent.ts';
import { PROTOCOL_LINES, proposalAsk, withProposalAsk } from '../../src/job-rules/index.ts';

const ECHO = ['❯ Paint the shed.', `  ${FOOTER_ANCHOR}`];
const BODY = [
  '● Here is my proposal.',
  '  Goal: paint the shed',
  '  Approach: two coats',
  '  with a brush',
  '  HOPPER_PROPOSAL',
];
const END = ['✻ Worked for 4s', '──────────────', '❯ ', '──────────────'];
const screen = (...parts: string[][]): string => parts.flat().join('\n');

describe('the proposal marker', () => {
  it('the protocol tells every job how to come back with a proposal, before the turn anchor', () => {
    expect(PROTOCOL_LINES.slice(0, -1).some((l) => l.includes('HOPPER_PROPOSAL') && l.includes('Goal:') && l.includes('Context:'))).toBe(true);
    expect(FOOTER_ANCHOR).toContain('HOPPER_FAILED');
  });

  it('a pane turn that ends with it is a proposal, its text without the marker', () => {
    const turn = readTurn(screen(ECHO, BODY, END), FOOTER_ANCHOR);
    expect(turn.lastMarker).toBe('proposal');
    expect(turn.assistantText).toContain('Goal: paint the shed');
    expect(turn.assistantText).not.toContain('HOPPER_PROPOSAL');
  });

  it('a print-mode answer that ends with it is a proposal outcome', () => {
    const text = 'Goal: paint it\nApproach: a brush\nHOPPER_PROPOSAL';
    expect(outcomeOf(text, 'm', 'c')).toEqual({ kind: 'proposal', proposal: { text: 'Goal: paint it\nApproach: a brush', recentOutput: text } });
  });

  it('a job asked for a proposal is told so after its job rules; any other job is not', () => {
    expect(withProposalAsk('the rules', { proposal: true })).toBe(`the rules\n${proposalAsk}`);
    expect(withProposalAsk('the rules', {})).toBe('the rules');
    expect(proposalAsk).toContain('HOPPER_PROPOSAL');
  });
});

describe('the parts of a proposal', () => {
  it('each part runs from its label to the next; headings, lists and emphasis read too', () => {
    const text = [
      'Some preamble.',
      '## Goal',
      'Paint the shed.',
      '- **Approach:** two coats',
      'with a brush',
      '*Alternatives:* spray',
      'Risks: rain',
      'Effort: an afternoon',
      'Context: the shed is wood; see docs/shed.md',
    ].join('\n');
    expect(proposalSections(text)).toEqual({
      sections: { goal: 'Paint the shed.', approach: 'two coats\nwith a brush', alternatives: 'spray', risks: 'rain', effort: 'an afternoon', context: 'the shed is wood; see docs/shed.md' },
      missing: [],
    });
  });

  it('a part left out, or left empty, is missing; text with no labels is all missing', () => {
    expect(proposalSections('Goal: x\nRisks:\nEffort: y').missing).toEqual(['approach', 'alternatives', 'risks', 'context']);
    expect(proposalSections('').missing).toEqual(['goal', 'approach', 'alternatives', 'risks', 'effort', 'context']);
  });

  it('a word that is not a label, with a colon, stays in its part', () => {
    expect(proposalSections('Goal: x\nNote: keep it\nApproach: y').sections).toEqual({ goal: 'x\nNote: keep it', approach: 'y' });
  });
});
