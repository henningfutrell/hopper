// Issue #945: a job as a search document. Its words, status, labels, requester, machine and lane, its result, its
// questions with their answers, why it failed and the assessor's verdict; a direct job's is private; and no secret is
// ever in it.
import { describe, expect, it } from 'vitest';
import { artifactDocument, jobDocument, planDocument } from '../../src/search/document.ts';
import type { Artifact } from '../../src/domain/artifacts.ts';
import type { InfraPlan } from '../../src/domain/infra-plans.ts';
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

// Part 3: an artifact and an infra plan as search documents. An artifact's metadata, and its text where that is cheap
// (markdown, text, CSV, JSON; an HTML deck or an SVG with its tags taken out); an infra plan's summary, never its text.
describe('an artifact as a search document (issue #945, part 3)', () => {
  const artifact = (o: Partial<Artifact> = {}): Artifact => ({
    id: 'a1', userId: 'u1', jobId: 'j1', issue: { url: 'https://github.com/o/r/issues/1', ref: 'o/r#1' }, title: 'Login timeline', name: 'timeline.md',
    type: 'text/markdown', kind: 'markdown', size: 10, sha256: 'x', createdAt: '2026-10-01T10:00:00.000Z', summary: 'When each sign-in failed',
    revision: 2, updatedAt: '2026-10-01T12:00:00.000Z', revisedBy: 'job j1', note: 'added the retries', pinned: false, ...o,
  });

  it('holds its title, summary, note, repository, job and times, and a markdown artifact\'s text', () => {
    const d = artifactDocument({ scope, artifact: artifact(), content: Buffer.from('# Timeline\n\nThe second sign-in failed at noon.'), job: job() });
    expect(d).toMatchObject({
      id: 'inst/u1/artifact/a1', type: 'artifact', ref: 'a1', private: false, title: 'Login timeline', repo: 'o/r', job: 'j1',
      labels: [], created: '2026-10-01T10:00:00.000Z', updated: '2026-10-01T12:00:00.000Z',
    });
    expect(d.brief).toBe('When each sign-in failed\nadded the retries');
    expect(d.content).toContain('The second sign-in failed at noon.');
    expect(d.status).toBeUndefined();
  });

  it('reads an HTML deck\'s slide text without its tags, scripts and styles', () => {
    const html = '<html><head><style>h1{color:red}</style><script>alert("x")</script></head><body><section><h1>Q3 &amp; Q4 plan</h1><p>Ship the search</p></section></body></html>';
    const d = artifactDocument({ scope, artifact: artifact({ kind: 'html', type: 'text/html', name: 'deck.html' }), content: Buffer.from(html) });
    expect(d.content).toContain('Q3 & Q4 plan');
    expect(d.content).toContain('Ship the search');
    expect(d.content).not.toContain('alert');
    expect(d.content).not.toContain('color:red');
    expect(d.content).not.toContain('<');
  });

  it('indexes no text of an image or a PDF, and masks every secret in a text', () => {
    expect(artifactDocument({ scope, artifact: artifact({ kind: 'image', type: 'image/png' }), content: Buffer.from('not text') }).content).toBeUndefined();
    const d = artifactDocument({ scope, artifact: artifact({ summary: `key ${TOKEN}` }), content: Buffer.from(`token: ${TOKEN}`) });
    expect(JSON.stringify(d)).not.toContain(TOKEN);
  });

  it('is private when its job is a direct job', () => {
    const d = artifactDocument({ scope, artifact: artifact({ issue: undefined }), job: job({ source: { source: 'direct', kind: 'direct', key: 'direct:d1' } }) });
    expect(d.private).toBe(true);
    expect(d.repo).toBeUndefined();
  });
});

describe('an infra plan as a search document (issue #945, part 3)', () => {
  const plan = (o: Partial<InfraPlan> = {}): InfraPlan => ({
    id: 'p1', tool: 'terraform', asset: { kind: 'aws-role', name: '123456789012/deploy' }, target: 'uat-network', repo: 'o/infra', ref: 'issue-1',
    commit: 'a'.repeat(40), text: `resource "aws_security_group_rule" "a" { secret = "${TOKEN}" }`, job: 'j1', createdAt: '2026-10-01T10:00:00.000Z', expiresAt: 'x',
    summary: {
      words: 'Adds 1 security group rule in uat; changes nothing in prod; destroys nothing', level: 'low', counts: { create: 1, update: 0, replace: 0, delete: 0 },
      environments: ['uat'], risks: [{ risk: 'network', words: 'Changes network access', resources: ['aws_security_group_rule.a'] }], blastRadius: 'one rule in uat', checks: [], failed: false,
    },
    ...o,
  } as InfraPlan);

  it('holds its target, tool, summary, risks, repository and job, never the plan\'s text', () => {
    const d = planDocument({ scope, plan: plan(), job: job() });
    expect(d).toMatchObject({ id: 'inst/u1/infra-plan/p1', type: 'infra-plan', ref: 'p1', private: false, title: 'uat-network (terraform plan)', status: 'recorded', repo: 'o/infra', job: 'j1', updated: '2026-10-01T10:00:00.000Z' });
    expect(d.brief).toContain('Adds 1 security group rule in uat');
    expect(d.brief).toContain('Changes network access');
    expect(d.brief).toContain('one rule in uat');
    expect(JSON.stringify(d)).not.toContain('aws_security_group_rule" "a"');
    expect(JSON.stringify(d)).not.toContain(TOKEN);
  });

  it('says approved once approved, and failed when a check failed', () => {
    expect(planDocument({ scope, plan: plan(), approval: { plan: 'p1', by: 'octo', at: '2026-10-01T10:30:00.000Z' } })).toMatchObject({ status: 'approved', updated: '2026-10-01T10:30:00.000Z' });
    expect(planDocument({ scope, plan: plan({ summary: { ...plan().summary!, failed: true } }) }).status).toBe('failed');
  });
});
