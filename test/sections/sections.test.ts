// The section model (issue #543): every category of things waiting on or involving a person — Questions, Proposals,
// Research, Logins, Failures — is a section type declared once. Proposals and Research are review sections: one
// generic model (statuses, versions, review trail, decisions, events, settings), each declared by its type, so a
// future one follows the same path. A source item asks for a section's special job by its label, or by a heading of
// that section in its body (the layout of issue #542); the job is told its asks after its job rules.
import { describe, expect, it } from 'vitest';
import { EVENT_SCHEMAS } from '../../src/events/schemas.ts';
import { EVENT_DOCS } from '../../src/events/docs.ts';
import {
  asksOf, EVENT_TYPES, REVIEW_KINDS, REVIEW_SECTIONS, reviewSections, SECTION_KINDS, SECTIONS, type ReviewKind,
} from '../../src/domain/types.ts';
import { FOOTER_ANCHOR, readTurn } from '../../src/executors/herdr/screen.ts';
import { outcomeOf } from '../../src/executors/print-agent.ts';
import { askLine, PROTOCOL_LINES, withAsks } from '../../src/job-rules/index.ts';

describe('the section types', () => {
  it('are declared once, in nav order, each with a label and the event types it emits', () => {
    expect(SECTION_KINDS).toEqual(['questions', 'proposals', 'research', 'logins', 'failures']);
    for (const kind of SECTION_KINDS) {
      const s = SECTIONS[kind];
      expect(s.kind).toBe(kind);
      expect(s.label).toMatch(/^[A-Z]/);
      expect(s.events.length).toBeGreaterThan(0);
      for (const e of s.events) expect(EVENT_TYPES).toContain(e);
    }
  });

  it('Proposals and Research are review sections: the same model, each declared by its type', () => {
    expect(REVIEW_KINDS).toEqual(['research', 'proposal']);
    expect(REVIEW_SECTIONS.research).toMatchObject({ section: 'research', marker: 'HOPPER_RESEARCH_REPORT', label: 'hopper:research', jobField: 'researchId', idField: 'researchId' });
    expect(REVIEW_SECTIONS.proposal).toMatchObject({ section: 'proposals', marker: 'HOPPER_PROPOSAL', label: 'hopper:proposal', jobField: 'proposalId', idField: 'proposalId' });
    expect(REVIEW_SECTIONS.research.decisions.map((d) => [d.id, d.effect, d.notes])).toEqual([
      ['accept', 'accept', 'optional'], ['dig_deeper', 'send_back', 'optional'], ['steer', 'send_back', 'required'],
    ]);
    expect(REVIEW_SECTIONS.proposal.decisions.map((d) => [d.id, d.effect, d.notes])).toEqual([
      ['accept', 'accept', 'optional'], ['request_changes', 'send_back', 'required'], ['reject', 'reject', 'required'],
    ]);
    expect(SECTIONS.research.events).toEqual(expect.arrayContaining(['research.submitted', 'research.accepted', 'research.cancelled']));
    expect(SECTIONS.research.events).not.toContain('research.rejected');
  });

  it('every event a review section emits has a payload schema and docs', () => {
    for (const kind of REVIEW_KINDS) {
      for (const e of SECTIONS[REVIEW_SECTIONS[kind].section].events) {
        expect(EVENT_SCHEMAS[e]).toBeDefined();
        expect(EVENT_DOCS[e]).toMatch(/\S/);
      }
    }
  });
});

describe('the parts of a research report', () => {
  it('each part runs from its label to the next', () => {
    const text = [
      '## Question', 'What can a machine reach?', 'Findings: the probe reads PATH', '**Sources and evidence:** src/machines/probe.ts',
      'Confidence: medium', 'Open threads: kubectl contexts', 'Next step: probe AWS',
    ].join('\n');
    expect(reviewSections('research', text)).toEqual({
      sections: { question: 'What can a machine reach?', findings: 'the probe reads PATH', sources: 'src/machines/probe.ts', confidence: 'medium', openThreads: 'kubectl contexts', nextStep: 'probe AWS' },
      missing: [],
    });
    expect(reviewSections('research', 'Findings: x').missing).toEqual(['question', 'sources', 'confidence', 'openThreads', 'nextStep']);
  });
});

describe('the research marker', () => {
  const ECHO = ['❯ Look into it.', `  ${FOOTER_ANCHOR}`];
  const END = ['✻ Worked for 4s', '──────────────', '❯ ', '──────────────'];

  it('the protocol tells every job how to come back with a research report, before the turn anchor', () => {
    expect(PROTOCOL_LINES.slice(0, -1).some((l) => l.includes('HOPPER_RESEARCH_REPORT') && l.includes('Question:') && l.includes('Next step:'))).toBe(true);
  });

  it('a pane turn that ends with it is a research report', () => {
    const turn = readTurn([...ECHO, '● Done looking.', '  Findings: none', '  HOPPER_RESEARCH_REPORT', ...END].join('\n'), FOOTER_ANCHOR);
    expect(turn.lastMarker).toBe('research');
    expect(turn.assistantText).toContain('Findings: none');
    expect(turn.assistantText).not.toContain('HOPPER_RESEARCH_REPORT');
  });

  it('a print-mode answer that ends with it is a report outcome; a proposal is one too, of its own kind', () => {
    expect(outcomeOf('Findings: x\nHOPPER_RESEARCH_REPORT', 'm', 'c')).toEqual({ kind: 'report', review: 'research', report: { text: 'Findings: x', recentOutput: 'Findings: x\nHOPPER_RESEARCH_REPORT' } });
    expect(outcomeOf('Goal: x\nHOPPER_PROPOSAL', 'm', 'c')).toEqual({ kind: 'report', review: 'proposal', report: { text: 'Goal: x', recentOutput: 'Goal: x\nHOPPER_PROPOSAL' } });
  });
});

describe('what a source item asks for', () => {
  it('a label asks for its section\'s special job', () => {
    expect(asksOf(['hopper', 'hopper:research'], '')).toEqual(['research']);
    expect(asksOf(['hopper:proposal'], '')).toEqual(['proposal']);
    expect(asksOf(['hopper'], 'just do it')).toEqual([]);
  });

  it('a section heading in the body asks too (the issue #542 layout); research always comes first', () => {
    const body = '## Proposal\n\nGoal.\n\n## Research\n\n- R1\n\n## Special jobs (inferred)\n\n- S1';
    expect(asksOf([], body)).toEqual<ReviewKind[]>(['research', 'proposal']);
    expect(asksOf([], '# Research\nfindings')).toEqual(['research']);
    expect(asksOf([], '### Proposal\nx')).toEqual(['proposal']);
    // Only a heading: a word in the text asks for nothing.
    expect(asksOf([], 'We did some research on the proposal.')).toEqual([]);
    expect(asksOf(['hopper:proposal'], '## Research')).toEqual(['research', 'proposal']);
  });

  it('a job is told its first ask after its job rules, and that a proposal follows accepted research', () => {
    expect(withAsks('the rules', {})).toBe('the rules');
    expect(withAsks('the rules', { proposal: true })).toBe(`the rules\n${askLine('proposal')}`);
    const both = withAsks('the rules', { research: true, proposal: true });
    expect(both.startsWith(`the rules\n${askLine('research')}`)).toBe(true);
    expect(both).toContain('HOPPER_RESEARCH_REPORT');
    expect(both).toMatch(/proposal/i);
  });
});
