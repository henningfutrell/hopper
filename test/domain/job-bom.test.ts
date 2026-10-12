// Issue #935: a job's parts list (BOM) — everything a job touched or made, grouped (what was asked, work, code, outputs,
// infra, decisions, machines), each part with its status and its page; a header in plain words (what was asked, where it
// stands, what is next) and a one-line summary; what waits on the person first. Pure.
import { describe, expect, it } from 'vitest';
import { jobBom, type JobBomInput } from '../../src/domain/job-bom.ts';
import type { Artifact } from '../../src/domain/artifacts.ts';
import type { Question } from '../../src/domain/questions.ts';
import type { DomainEvent, Job, JobStatus } from '../../src/domain/types.ts';

const ISSUE = 'https://github.com/acme/app/issues/7';
const PR = 'https://github.com/acme/app/pull/12';

const job = (status: JobStatus, over: Partial<Job> = {}): Job => ({
  id: 'j1', spec: { executor: 'test', payload: {}, goal: 'Make the cache faster' }, priority: 50, status, approved: true, attempts: 1,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T01:00:00.000Z', startedAt: '2026-10-01T00:10:00.000Z',
  source: { source: 'github', kind: 'issue', key: ISSUE, url: ISSUE, repo: 'acme/app', number: 7, title: 'Make the cache faster' },
  ...over,
} as Job);

let seq = 0;
const event = (type: string, data: Record<string, unknown> = {}, over: Partial<DomainEvent> = {}): DomainEvent =>
  ({ seq: ++seq, schemaVersion: 1, id: `e${seq}`, type, at: new Date(Date.UTC(2026, 9, 1, 0, seq)).toISOString(), jobId: 'j1', data, ...over } as DomainEvent);

const question = (id: string, status: Question['status'], over: Partial<Question> = {}): Question => ({
  id, jobId: 'j1', text: `Which store, ${id}?`, recentOutput: '', detectedBy: 'test', status, tier: 'human', attempts: [], notifyCount: 0,
  createdAt: '2026-10-01T00:20:00.000Z', updatedAt: '2026-10-01T00:30:00.000Z', ...over,
} as Question);

const artifact = (id: string, revision = 1): Artifact => ({
  id, userId: 'u', jobId: 'j1', title: `Chart ${id}`, name: 'chart.svg', type: 'image/svg+xml', kind: 'image', size: 10, sha256: 'a'.repeat(64),
  createdAt: '2026-10-01T00:40:00.000Z', revision,
} as unknown as Artifact);

const input = (over: Partial<JobBomInput>): JobBomInput => ({ job: job('running'), events: [], questions: [], artifacts: [], related: [], now: '2026-10-01T02:10:00.000Z', ...over });
const part = (bom: ReturnType<typeof jobBom>, id: string) => bom.parts.find((p) => p.id === id);

describe('a job\'s parts list (issue #935)', () => {
  it('lists what was asked: the issue, the follow-ups it filed, and added scope', () => {
    const bom = jobBom(input({ events: [
      event('job.child_issue_filed', { parent: { repo: 'acme/app', number: 7 }, child: { repo: 'acme/app', number: 9, url: 'https://github.com/acme/app/issues/9' }, required: false }),
      event('job.rework_requested', { pullRequest: PR, notes: 'Add a test for the empty cache.', nextJobId: 'j2' }),
    ] }));
    expect(part(bom, 'issue:acme/app#7')).toMatchObject({ group: 'asked', label: 'Make the cache faster', detail: 'acme/app#7', url: ISSUE });
    expect(part(bom, 'issue:acme/app#9')).toMatchObject({ group: 'asked', kind: 'follow_up', url: 'https://github.com/acme/app/issues/9' });
    expect(bom.parts.find((p) => p.kind === 'scope')).toMatchObject({ group: 'asked', label: 'Rework asked', detail: 'Add a test for the empty cache.' });
  });

  it('lists the work: each run, the task list, the lane, the time it took and the runs after it', () => {
    const bom = jobBom(input({
      job: job('running', { attempts: 2, tasks: { done: 3, total: 4 }, laneId: 'm1/lane-2' }),
      events: [event('job.claimed', {}, { machineId: 'm1', laneId: 'm1/lane-1' }), event('job.started', { attempts: 1 }), event('job.claimed', {}, { machineId: 'm1', laneId: 'm1/lane-2' }), event('job.started', { attempts: 2 })],
      related: [job('queued', { id: 'j2', rerunOf: 'j1', createdAt: '2026-10-01T03:00:00.000Z' })],
    }));
    const runs = bom.parts.filter((p) => p.kind === 'run');
    expect(runs.map((p) => [p.label, p.status])).toEqual([['Run 2', 'running'], ['Run 1', 'done']]);
    expect(part(bom, 'tasks')).toMatchObject({ group: 'work', label: '3 of 4 tasks done', status: 'running' });
    expect(part(bom, 'lane')).toMatchObject({ group: 'work', label: 'm1/lane-2' });
    expect(part(bom, 'time')).toMatchObject({ group: 'work', label: '2h running so far' });
    expect(part(bom, 'job:j2')).toMatchObject({ group: 'work', kind: 'rerun', status: 'open', href: '#job/j2' });
    expect(part(bom, 'machine:m1')).toMatchObject({ group: 'machines', label: 'm1', detail: '2 runs' });
  });

  it('lists the code: its pull request, its checks, its branch and its merge', () => {
    const bom = jobBom(input({
      job: job('finished', { finishedAt: '2026-10-01T01:00:00.000Z', sourceState: { source: { pullRequest: PR, follow: 'merged', seen: { checks: 'passing', headRef: 'issue-7-cache', base: 'dev' } } } }),
      events: [event('job.pull_request_merged', { pullRequest: PR, part: false, byHopper: true })],
    }));
    expect(part(bom, `pr:${PR}`)).toMatchObject({ group: 'code', label: 'Pull request #12', status: 'done', url: PR, href: '#pull-requests' });
    expect(part(bom, 'checks')).toMatchObject({ group: 'code', label: 'Checks passing', status: 'done' });
    expect(part(bom, 'branch')).toMatchObject({ group: 'code', label: 'issue-7-cache', detail: 'into dev' });
    expect(bom.parts.find((p) => p.kind === 'merge')).toMatchObject({ group: 'code', label: 'Merged by the hopper', status: 'done' });
  });

  it('lists its checkpoints under machines, and the commits its latest checkpoint names under code', () => {
    const bom = jobBom(input({
      job: job('running', { checkpoint: { at: '2026-10-01T00:50:00.000Z', machineId: 'm1', branch: 'issue-7', base: 'a', head: 'b', commits: ['abc1234 Add the cache', 'def5678 Test the cache'], bytes: 2048, session: true } }),
      events: [event('job.checkpointed', { machineId: 'm1', bytes: 2048, session: true, commits: 2 })],
    }));
    expect(bom.parts.find((p) => p.kind === 'checkpoint')).toMatchObject({ group: 'machines', label: 'Checkpoint on m1', detail: '2 commits, with its session', status: 'recorded' });
    expect(bom.parts.filter((p) => p.kind === 'commit').map((p) => [p.id, p.label])).toEqual([['commit:abc1234', 'Add the cache'], ['commit:def5678', 'Test the cache']]);
  });

  it('lists the outputs: its artifacts and their revisions, and its report', () => {
    const bom = jobBom(input({
      job: job('waiting_answer', { proposalId: 'p1' }),
      artifacts: [artifact('a1', 2)],
      events: [event('artifact.revised', { artifact: 'a1', revision: 2, title: 'Chart a1', name: 'chart.svg', type: 'image/svg+xml', size: 10, sha256: 'b', by: 'job' })],
    }));
    expect(part(bom, 'artifact:a1')).toMatchObject({ group: 'outputs', label: 'Chart a1', detail: 'revision 2', href: '#artifacts/a1' });
    expect(part(bom, 'artifact:a1/2')).toMatchObject({ group: 'outputs', kind: 'revision', href: '#artifacts/a1/2' });
    expect(part(bom, 'proposal:p1')).toMatchObject({ group: 'outputs', label: 'Plan', status: 'waiting_on_you', href: '#proposals' });
  });

  it('lists the infra: plans and their approvals, minted credentials with their scopes, and drift', () => {
    const asset = { kind: 'aws', name: 'prod' };
    const bom = jobBom(input({ events: [
      event('infra.plan_recorded', { plan: 'pl1', tool: 'terraform', asset, target: 'network', repo: 'acme/app', ref: 'b', commit: 'c', file: false, expiresAt: 'x' }),
      event('infra.plan_recorded', { plan: 'pl2', tool: 'terraform', asset, target: 'dns', repo: 'acme/app', ref: 'b', commit: 'c', file: false, expiresAt: 'x' }),
      event('infra.plan_approved', { plan: 'pl1', tool: 'terraform', asset, target: 'network', by: 'admin' }),
      event('vault.minted', { kind: 'aws', operation: 'read', asset, template: 't', machine: 'm1', job: 'j1', credential: 'c1', decision: 'd', expiresAt: '2026-10-01T03:00:00.000Z', renewal: false }),
      event('infra.out_of_band_recorded', { change: 'oob1', source: 's', key: 'k', target: 'dns', what: 'a record changed by hand', at: '2026-10-01T00:00:00.000Z' }),
      event('vault.grant_asked', { job: 'j1', key: ISSUE, name: 'aws read prod' }),
    ] }));
    expect(part(bom, 'plan:pl1')).toMatchObject({ group: 'infra', label: 'terraform plan for network', status: 'done', detail: 'approved', href: '#infra' });
    expect(part(bom, 'plan:pl2')).toMatchObject({ status: 'waiting_on_you', detail: 'waits for an admin to approve it' });
    expect(part(bom, 'credential:c1')).toMatchObject({ group: 'infra', label: 'read credential for aws prod', detail: 'until 2026-10-01T03:00:00.000Z' });
    expect(part(bom, 'drift:oob1')).toMatchObject({ group: 'infra', label: 'Drift: dns', detail: 'a record changed by hand', status: 'open' });
    expect(part(bom, 'grant')).toMatchObject({ group: 'infra', label: 'Vault grant asked', detail: 'aws read prod', status: 'waiting_on_you', href: '#settings/vault' });
  });

  it('lists the decisions: each question with who answered it, an override, and a hand-off', () => {
    const bom = jobBom(input({
      job: job('waiting_answer', { questionId: 'q2' }),
      questions: [question('q1', 'answered', { answer: 'Redis', answeredBy: 'human' }), question('q2', 'open'), question('q3', 'answered', { answer: 'yes', answeredBy: 'rules' })],
      events: [event('minor_decision.overridden', { pickId: 'p', point: 'which cache', pick: 'memory', actual: 'redis' })],
      handoff: { id: 'h1', jobId: 'j1', status: 'open', reason: 'failed', openedAt: '2026-10-01T00:50:00.000Z', summary: 'The build fails.', reasons: [], error: 'x' } as unknown as JobBomInput['handoff'],
    }));
    expect(part(bom, 'question:q1')).toMatchObject({ group: 'decisions', status: 'done', detail: 'answered by a person: Redis', href: '#questions/history' });
    expect(part(bom, 'question:q2')).toMatchObject({ status: 'waiting_on_you', href: '#questions' });
    expect(part(bom, 'question:q3')).toMatchObject({ detail: 'answered by rules: yes' });
    expect(bom.parts.find((p) => p.kind === 'override')).toMatchObject({ group: 'decisions', label: 'Override: which cache', detail: 'memory → redis' });
    expect(part(bom, 'handoff:h1')).toMatchObject({ group: 'decisions', status: 'waiting_on_you', href: '#failures' });
  });

  it('puts what waits on the person first, then the parts by group', () => {
    const bom = jobBom(input({ job: job('waiting_answer', { questionId: 'q1' }), questions: [question('q1', 'open')] }));
    expect(bom.parts[0]).toMatchObject({ id: 'question:q1', status: 'waiting_on_you' });
    expect(bom.parts.slice(1).map((p) => p.group)).toEqual([...bom.parts.slice(1).map((p) => p.group)].sort((a, b) => ['asked', 'work', 'code', 'outputs', 'infra', 'decisions', 'machines'].indexOf(a) - ['asked', 'work', 'code', 'outputs', 'infra', 'decisions', 'machines'].indexOf(b)));
  });

  it('says in plain words what was asked, where it stands, what is next, and sums it up', () => {
    const waiting = jobBom(input({ job: job('waiting_answer', { questionId: 'q1' }), questions: [question('q1', 'open')] }));
    expect(waiting.header).toEqual({ asked: 'Make the cache faster (acme/app#7)', stands: 'Waiting on you: answer a question', next: 'You: answer the question.' });
    expect(waiting.summary).toBe('0 of 1 parts done, 1 waiting on you.');
    const review = jobBom(input({ job: job('finished', { sourceState: { source: { pullRequest: PR, follow: 'open', seen: { checks: 'passing' } } } }) }));
    expect(review.header.stands).toBe('Ready for review');
    expect(review.header.next).toBe('Review and merge the pull request.');
    expect(review.summary).toMatch(/nothing waiting on you\.$/);
    const running = jobBom(input({ job: job('running', { tasks: { done: 1, total: 3 } }) }));
    expect(running.header).toMatchObject({ stands: 'Building it', next: 'The agent works on it: 1 of 3 tasks done.' });
  });

  it('keeps the job\'s events, newest first, for the timeline', () => {
    const a = event('job.queued');
    const b = event('job.started', { attempts: 1 });
    expect(jobBom(input({ events: [a, b] })).events.map((e) => e.seq)).toEqual([b.seq, a.seq]);
  });
});
