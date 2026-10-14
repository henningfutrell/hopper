// Agent text in Markdown (issue #569): the UI renders what an agent writes for people as Markdown, so the agent is told
// to write it so — one line in the default job rules, and a clause in the question, research and proposal protocol
// lines: a short summary first, then sections and lists, a question's options as a numbered list.
import { describe, expect, it } from 'vitest';
import { DEFAULT_JOB_RULES, MARKDOWN_RULE, PROTOCOL_LINES } from '../../src/job-rules/index.ts';

const line = (marker: string): string => PROTOCOL_LINES.find((l) => l.includes(`containing only: ${marker}`))!;

describe('Markdown in what agents write', () => {
  it('the default job rules carry the one formatting line', () => {
    expect(MARKDOWN_RULE).toBe('[hopper formatting] Format the text you write for a person in the hopper (a question, a research report, a proposal, a note) in Markdown: a short summary first, then sections and lists. Put names, paths and commands in code spans. Do not use raw HTML or images.');
    expect(DEFAULT_JOB_RULES.split('\n')).toContain(MARKDOWN_RULE);
  });

  it('the question line asks for Markdown, the summary first and the options as a numbered list', () => {
    const q = line('HOPPER_QUESTION');
    expect(q).toContain('in Markdown');
    expect(q).toContain('one short sentence that says what you need first');
    expect(q).toContain('the options as a numbered list');
  });

  it('the research and proposal lines ask for each part in Markdown, a short summary first', () => {
    for (const marker of ['HOPPER_RESEARCH_REPORT', 'HOPPER_PROPOSAL']) {
      expect(line(marker), marker).toContain('Write each part in Markdown, with a short summary first');
    }
  });
});
