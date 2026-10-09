// The writing style (issue #571): what a job writes for people is in Simplified Technical English
// (ASD-STE100). One line in the default job rules; a short clause in the question, research and
// proposal protocol lines and in the research and proposal asks. No other process.
import { describe, expect, it } from 'vitest';
import { askLine, DEFAULT_JOB_RULES, PROTOCOL_LINES, STE_RULE } from '../../src/job-rules/index.ts';

const STE = 'Simplified Technical English (ASD-STE100)';

describe('the writing style', () => {
  it('the default job rules carry the one STE line', () => {
    expect(STE_RULE).toBe('[hopper writing style] Write all text for people in Simplified Technical English (ASD-STE100): short sentences, one instruction per sentence, active voice, simple common words, one meaning per word.');
    expect(DEFAULT_JOB_RULES.split('\n')).toContain(STE_RULE);
  });

  it('the question, research and proposal protocol lines ask for STE', () => {
    for (const marker of ['HOPPER_QUESTION', 'HOPPER_RESEARCH_REPORT', 'HOPPER_PROPOSAL']) {
      const line = PROTOCOL_LINES.find((l) => l.includes(`containing only: ${marker}`));
      expect(line, marker).toContain(STE);
    }
  });

  it('a research or proposal ask asks for STE in its own line', () => {
    expect(askLine('research')).toContain(STE);
    expect(askLine('proposal')).toContain(STE);
  });
});
