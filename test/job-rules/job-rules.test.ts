// The job rules (issue #172): the config record `job-rules`, a text every job's prompt carries before
// its work tree and the protocol. Missing → the default job rules (the publishing rule, parallel work);
// the work tree line and the protocol lines are fixed: the hopper reads the markers back.
import { describe, expect, it } from 'vitest';
import type { ConfigRecords } from '../../src/domain/ports.ts';
import { DEFAULT_JOB_RULES, FIXED_JOB_LINES, JOB_RULES, jobRulesProblem, jobRulesView, readJobRules, withAsks, writeJobRules } from '../../src/job-rules/index.ts';

function records(initial?: unknown): ConfigRecords & { value: unknown } {
  const r = {
    value: initial,
    read: () => r.value,
    version: () => (r.value === undefined ? 'missing' : `v:${JSON.stringify(r.value)}`),
    write(_name: string, value: unknown, version: string) {
      if (version !== r.version()) return false;
      r.value = value;
      return true;
    },
  };
  return r as ConfigRecords & { value: unknown };
}

describe('the default job rules', () => {
  it('carry the publishing rule and the parallel-work rule', () => {
    expect(DEFAULT_JOB_RULES).toMatch(/^\[hopper publishing rule\] Any text you send to GitHub/);
    expect(DEFAULT_JOB_RULES).toContain('Never quote or name the repository owner or any other person.');
    expect(DEFAULT_JOB_RULES).toContain('[hopper parallel work] Other jobs run at the same time as this one');
    expect(DEFAULT_JOB_RULES).not.toContain('HOPPER_');
  });

  it('leave the work tree and the protocol to the fixed lines', () => {
    expect(FIXED_JOB_LINES[0]).toMatch(/^\[hopper work tree\] This job's work tree is <work tree>\./);
    expect(FIXED_JOB_LINES.join('\n')).toContain('HOPPER_QUESTION');
    expect(FIXED_JOB_LINES.join('\n')).toContain('HOPPER_DONE');
    expect(FIXED_JOB_LINES.at(-1)).toBe('If the job cannot be done, end with a line containing only: HOPPER_FAILED followed by the reason.');
  });
});

describe('reading and writing the job rules', () => {
  it('is the record `job-rules`', () => expect(JOB_RULES).toBe('job-rules'));

  it('missing reads as the default; a saved text, even empty, is what jobs get', () => {
    expect(readJobRules(records())).toBe(DEFAULT_JOB_RULES);
    expect(readJobRules(records('Be brief.'))).toBe('Be brief.');
    expect(readJobRules(records(''))).toBe('');
  });

  it('a value that is not a text reads as the default', () => {
    expect(readJobRules(records({ not: 'text' }))).toBe(DEFAULT_JOB_RULES);
  });

  it('the view says whether they are the default, and shows the default and the fixed lines', () => {
    expect(jobRulesView(records())).toEqual({ text: DEFAULT_JOB_RULES, version: 'missing', missing: true, default: DEFAULT_JOB_RULES, fixed: [...FIXED_JOB_LINES] });
    expect(jobRulesView(records('x'))).toMatchObject({ text: 'x', version: 'v:"x"', missing: false });
  });

  it('a write replaces them against the version read; a stale one is a conflict', () => {
    const r = records();
    expect(writeJobRules(r, 'one', 'missing')).toMatchObject({ ok: true, view: { text: 'one', missing: false } });
    expect(writeJobRules(r, 'two', 'missing')).toEqual({ ok: false, code: 'conflict', error: 'the job rules changed since they were read; reload and edit again' });
    expect(r.value).toBe('one');
  });

  it('refuses anything but a text, and more than 16 KiB', () => {
    expect(jobRulesProblem(3)).toBe('the job rules are a text');
    expect(jobRulesProblem('a'.repeat(16 * 1024))).toBeUndefined();
    expect(jobRulesProblem('a'.repeat(16 * 1024 + 1))).toMatch(/at most 16 KiB/);
    const r = records();
    expect(writeJobRules(r, 'a'.repeat(16 * 1024 + 1), 'missing')).toMatchObject({ ok: false, code: 'invalid' });
    expect(r.value).toBeUndefined();
  });
});

describe('a fork\'s brief (issues #548, #570)', () => {
  const forkOf = { jobId: 'p1', questionId: 'q1', kind: 'proposal' as const, note: 'options for the schema', question: 'Which schema?' };

  it('names the question and the aspect', () => {
    const rules = withAsks('rules', { proposal: true }, forkOf);
    expect(rules).toContain('Which schema?');
    expect(rules).toContain('options for the schema');
    expect(rules).not.toContain('answered');
  });

  it('a question answered before the fork started: the fork is given the answer to take into account', () => {
    const rules = withAsks('rules', { proposal: true }, { ...forkOf, answered: { answer: 'Use OAuth', by: 'human', at: '2026-10-09T08:00:00.000Z' } });
    expect(rules).toContain('was answered meanwhile');
    expect(rules).toContain('Use OAuth');
  });
});
