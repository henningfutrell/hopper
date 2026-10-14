// Issue #537: an agent asked for a proposal ends its message with HOPPER_PROPOSAL. The screen and the print-mode
// executors read it as a proposal, never as a question; its parts are read from their labels; a job asked for a
// proposal is told so after the job rules, and every job learns the marker from the protocol.
import { describe, expect, it } from 'vitest';
import { reviewSections } from '../../src/domain/types.ts';
const proposalSections = (text: string) => reviewSections('proposal', text);
import { FOOTER_ANCHOR, readTurn } from '../../src/executors/herdr/screen.ts';
import { outcomeOf } from '../../src/executors/print-agent.ts';
import { askLine, PROTOCOL_LINES, withAsks } from '../../src/job-rules/index.ts';
const proposalAsk = askLine('proposal');

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
    // A set of paths (issue #651): a TL;DR, the problem, each path with its tradeoffs, the recommendation, the context.
    expect(PROTOCOL_LINES.slice(0, -1).some((l) => ['HOPPER_PROPOSAL', 'TL;DR:', 'Problem:', 'Path N: <title>', 'Friction:', 'Creates:', 'Recommended:', 'Paths: none', 'Context:', 'Markdown']
      .every((w) => l.includes(w)))).toBe(true);
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
    expect(outcomeOf(text, 'm', 'c')).toEqual({ kind: 'report', review: 'proposal', report: { text: 'Goal: paint it\nApproach: a brush', recentOutput: text } });
  });

  it('a job asked for a proposal is told so after its job rules; any other job is not', () => {
    expect(withAsks('the rules', { proposal: true })).toBe(`the rules\n${proposalAsk}`);
    expect(withAsks('the rules', {})).toBe('the rules');
    expect(proposalAsk).toContain('HOPPER_PROPOSAL');
  });
});

describe('the parts of a proposal', () => {
  it('each top part runs from its label to the next; headings, lists and emphasis read too; paths are read apart', () => {
    const text = [
      'Some preamble.',
      '## TL;DR',
      'Paint the shed.',
      '- **Problem:** bare wood',
      'rots in the rain',
      '## Path 1: Brush',
      'Summary: two coats',
      '*Recommended:* 1, because it is cheap',
      'Context: the shed is wood; see docs/shed.md',
    ].join('\n');
    expect(proposalSections(text)).toEqual({
      sections: { tldr: 'Paint the shed.', problem: 'bare wood\nrots in the rain', recommended: '1, because it is cheap', context: 'the shed is wood; see docs/shed.md' },
      missing: [],
    });
  });

  it('a part left out, or left empty, is missing; text with no labels is all missing', () => {
    expect(proposalSections('TL;DR: x\nProblem:\nPath 1: y').missing).toEqual(['problem', 'recommended', 'context']);
    expect(proposalSections('').missing).toEqual(['tldr', 'problem', 'paths', 'context']);
  });

  it('a word that is not a label, with a colon, stays in its part', () => {
    expect(proposalSections('TL;DR: x\nNote: keep it\nProblem: y').sections).toEqual({ tldr: 'x\nNote: keep it', problem: 'y' });
  });
});
