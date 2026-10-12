// Issue #945: a job as a search document. Its words, status, labels, requester, machine and lane, its result, its
// questions with their answers, why it failed and the assessor's verdict; a direct job's is private; and no secret is
// ever in it.
import { describe, expect, it } from 'vitest';
import { jobDocument } from '../../src/search/document.ts';
import type { Job } from '../../src/domain/types.ts';
import type { Question } from '../../src/domain/questions.ts';
import type { DirectJob } from '../../src/domain/direct-jobs.ts';

const scope = { instance: 'inst', user: 'u1' };
const TOKEN = `ghp_${'a'.repeat(36)}`;
const job = (o: Partial<Job> = {}): Job => ({
  id: 'j1', spec: { executor: 'herdr-claude', payload: { prompt: `Fix the login page.\nUse token ${TOKEN}` } }, priority: 50, status: 'finished',
  approved: true, createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T11:00:00.000Z', finishedAt: '2026-10-01T11:00:00.000Z', attempts: 1,
  source: { source: 'github', kind: 'github', key: 'https://github.com/o/r/issues/1', title: 'Login page fails', repo: 'o/r', author: 'octo', labels: ['hopper', 'bug'] },
  laneId: 'box-1/lane-2', result: { summary: 'fixed it' }, ...o,
});
const question = (o: Partial<Question>): Question => ({ id: 'q', jobId: 'j1', text: 'Which browser?', recentOutput: '', detectedBy: 'x', status: 'answered', tier: 'human', attempts: [], notifyCount: 0, ...o } as Question);

describe('a job as a search document (issue #945)', () => {
  it('holds its title, brief, status, labels, repository, requester, machine, lane, result, questions and times', () => {
    const d = jobDocument({ scope, job: job(), questions: [question({ answer: 'Safari' }), question({ id: 'q2', text: 'Ship it?', answer: undefined })] });
    expect(d).toMatchObject({
      id: 'inst/u1/job/j1', instance: 'inst', user: 'u1', type: 'job', ref: 'j1', private: false,
      title: 'Login page fails', status: 'finished', labels: ['hopper', 'bug'], repo: 'o/r', source: 'github', requester: 'octo',
      machine: 'box-1', lane: 'box-1/lane-2', result: '{"summary":"fixed it"}', questions: ['Which browser?\nSafari', 'Ship it?'],
      created: '2026-10-01T10:00:00.000Z', updated: '2026-10-01T11:00:00.000Z', finished: '2026-10-01T11:00:00.000Z',
    });
    expect(d.brief).toContain('Fix the login page.');
  });

  it('masks every secret: a token in its prompt, result, error or answer is never indexed', () => {
    const d = jobDocument({ scope, job: job({ status: 'failed', error: `push refused for ${TOKEN}`, result: TOKEN }), questions: [question({ answer: TOKEN })] });
    expect(JSON.stringify(d)).not.toContain(TOKEN);
    expect(d.brief).toContain('masked');
    expect(d.failure).toContain('push refused');
  });

  it('carries why it failed and the failure assessor\'s verdict', () => {
    const d = jobDocument({ scope, job: job({ status: 'failed', error: 'tests failed', assessment: { recordId: 'r', at: 'x', class: 'job', decision: 'retry', summary: 'flaky test', reasons: ['seen twice'] } as Job['assessment'] }), questions: [] });
    expect(d.failure).toBe('tests failed');
    expect(d.verdict).toBe('retry: flaky test\nseen twice');
  });

  it('is private for a direct job, titled and briefed from its submission, its submitter the requester', () => {
    const direct: DirectJob = { id: 'd1', title: 'Unlock a sign-in', brief: 'Customer locked out', labels: ['sme:identity'], authorizations: [], submittedBy: { person: 'ada', via: 'ui' }, submittedAt: 'x' };
    const d = jobDocument({ scope, job: job({ source: { source: 'direct', kind: 'direct', key: 'direct:d1', labels: ['sme:identity'] } }), questions: [], direct });
    expect(d).toMatchObject({ private: true, title: 'Unlock a sign-in', brief: 'Customer locked out', requester: 'ada', labels: ['sme:identity'], source: 'direct' });
  });

  it('takes its title from the goal, else the prompt\'s first line, when its item has none', () => {
    expect(jobDocument({ scope, job: job({ source: undefined, spec: { executor: 'x', payload: {}, goal: 'Tidy up' } }), questions: [] }).title).toBe('Tidy up');
    expect(jobDocument({ scope, job: job({ source: undefined }), questions: [] }).title).toBe('Fix the login page.');
  });
});
