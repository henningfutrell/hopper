import { describe, expect, it } from 'vitest';
import type { AnswerRequest } from '../../src/domain/ports.ts';
import type { Question } from '../../src/domain/types.ts';
import { buildPrompt } from '../../src/questions/prompt.ts';

const q = (over: Partial<Question> = {}) => ({
  id: 'q', jobId: 'j', text: 'Which?', recentOutput: '', detectedBy: 'marker', status: 'open', tier: 'opus',
  attempts: [], notifyCount: 0, createdAt: '', updatedAt: '', ...over,
}) as Question;
const req = (over: Partial<AnswerRequest> = {}): AnswerRequest => ({
  question: q(), jobPrompt: 'JOBPROMPT', rules: '', previous: [], ...over,
});

describe('buildPrompt', () => {
  it('states the role, risk guidance and the JSON contract', () => {
    const p = buildPrompt(req());
    expect(p).toContain("on the owner's behalf");
    expect(p).toMatch(/risky/);
    expect(p).toMatch(/"confident"/);
    expect(p).toContain('JOBPROMPT');
  });

  it('keeps only the last 120 lines of recent output', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `row-${i}`).join('\n');
    const p = buildPrompt(req({ question: q({ recentOutput: lines }) }));
    expect(p).toContain('row-199');
    expect(p).toContain('row-80');
    expect(p).not.toContain('row-79\n');
  });

  it('says so when there are no standing rules', () => {
    expect(buildPrompt(req())).toMatch(/no standing rules/i);
  });

  it('adds the idle hint only when detected by idle', () => {
    const idle = buildPrompt(req({ question: q({ detectedBy: 'idle' }) }));
    expect(idle).toContain('If the job is complete, end your message with JOB_HOPPER_DONE');
    expect(buildPrompt(req())).not.toContain('JOB_HOPPER_DONE');
  });
});
