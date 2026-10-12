// The Grok Bot routine names a direct job's requester (issue #901, part 4): every notice about a direct job — its question,
// its end, a login it waits on, an artifact it made — says which direct job it is and who submitted it, so the receiver
// tells that person. A job of any other source carries neither.
import { describe, expect, it } from 'vitest';
import type { DomainEvent, Job, Question } from '../../src/domain/types.ts';
import { artifactPayload, jobPayload, loginPayload, questionPayload } from '../../src/plugins/notifier/grokbot-routine/payload.ts';

const direct = {
  id: 'j1', status: 'done', priority: 50, spec: { executor: 'test', payload: {} },
  source: { source: 'direct', kind: 'direct', key: 'direct:d1', url: 'http://hopper/#direct-job-d1', title: 'Look up a lockout', author: 'ops-lead', labels: ['sme:identity'] },
} as unknown as Job;
const github = { ...direct, source: { source: 'github-account', kind: 'github-account', key: 'https://github.com/o/r/issues/1', author: 'someone' } } as unknown as Job;

const question: Question = {
  id: 'q1', jobId: 'j1', text: 'Which realm?', recentOutput: '', detectedBy: 'marker', status: 'open', tier: 'human',
  attempts: [], notifyCount: 1, createdAt: '2026-10-12T10:00:00.000Z', updatedAt: '2026-10-12T10:00:00.000Z',
};
const event = (type: string, data: Record<string, unknown>): DomainEvent => ({ seq: 1, at: '2026-10-12T10:01:00.000Z', type, jobId: 'j1', data } as unknown as DomainEvent);
const now = new Date('2026-10-12T10:01:00.000Z');

const bodies = (job: Job) => [
  questionPayload({ question, job, answerUrl: undefined, at: 'x', now, offered: false }),
  jobPayload(event('job.finished', { result: 'reset done' }), job),
  jobPayload(event('job.failed', { error: 'no access' }), job),
  loginPayload(event('auth.pending', { loginId: 'l1', tool: 'kcadm', expiresAt: '2026-10-12T10:10:00.000Z' }), job, now, undefined),
  artifactPayload(event('artifact.created', { artifact: 'a1', title: 'Report', type: 'text/html', size: 10 }), job, undefined),
];

describe('Grok Bot routine: a direct job\'s notice names its requester (issue #901)', () => {
  it('every notice of a direct job carries the direct job and its requester', () => {
    for (const body of bodies(direct)) expect(body).toMatchObject({ directJob: 'd1', requester: 'ops-lead' });
  });

  it('a job of another source carries neither', () => {
    for (const body of bodies(github)) {
      expect('directJob' in body).toBe(false);
      expect('requester' in body).toBe(false);
    }
  });

  it('a direct job with no author known: requester null', () => {
    const anon = { ...direct, source: { ...direct.source, author: undefined } } as unknown as Job;
    expect(jobPayload(event('job.finished', {}), anon)).toMatchObject({ directJob: 'd1', requester: null });
  });
});
