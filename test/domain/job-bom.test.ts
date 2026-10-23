// Issue #935: a job's parts list (BOM) — everything a job touched or made, grouped (what was asked, work, code, outputs,
// infra, decisions, machines), each part with its status and its page; a header in plain words (what was asked, where it
// stands, what is next) and a one-line summary; what waits on the person first. Pure.
import { describe, expect, it } from 'vitest';
import { jobBom, type JobBomInput } from '../../src/domain/job-bom.ts';
import { liveUseOf } from '../../src/domain/job-resources.ts';
import type { Artifact } from '../../src/domain/artifacts.ts';
import type { Question } from '../../src/domain/questions.ts';
import type { DomainEvent, Job, JobRun, JobStatus } from '../../src/domain/types.ts';

const GIB = 1024 ** 3;
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
  it('lists a Windows step on its host, and a need step in its need box with its template (issue #1007)', () => {
    const bom = jobBom(input({ events: [
      event('step.started', { step: 's1', host: 'build-host', command: 'msbuild App.sln' }),
      event('step.started', { step: 's2', host: 'hopper-need-asked-1-ab', template: 'asked-1', needs: ['read/aws-role/1/ro'], command: 'aws sts get-caller-identity' }),
    ] }));
    expect(part(bom, 'step:s1')).toMatchObject({ label: 'Windows step on build-host', detail: 'msbuild App.sln' });
    expect(part(bom, 'step:s2')).toMatchObject({ label: 'Need step in template asked-1', detail: 'aws sts get-caller-identity' });
  });

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

  it('lists its latest checkpoint under machines, one part however many were taken, and the commits it names under code', () => {
    const bom = jobBom(input({
      job: job('running', { checkpoint: { at: '2026-10-01T00:50:00.000Z', machineId: 'm1', branch: 'issue-7', base: 'a', head: 'b', commits: ['def5678 Test the cache', 'abc1234 Add the cache'], bytes: 2048, session: true } }),
      events: [
        event('job.checkpointed', { machineId: 'm1', bytes: 2048, session: true, commits: 2 }),
        event('job.checkpointed', { machineId: 'm1', bytes: 1024, session: true, commits: 1 }),
        event('job.checkpointed', { machineId: 'm1', bytes: 512, session: false, commits: 0 }),
      ],
    }));
    expect(bom.parts.filter((p) => p.kind === 'checkpoint')).toEqual([expect.objectContaining({
      id: 'checkpoint', group: 'machines', label: 'Last checkpoint on m1', detail: '2 commits, with its session; 3 checkpoints taken', status: 'recorded', at: '2026-10-01T00:50:00.000Z',
    })]);
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
    expect(part(bom, 'grant')).toMatchObject({ group: 'infra', label: 'Vault grant asked', detail: 'aws read prod', status: 'waiting_on_you', href: '#vault' });
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
    expect(review.header.stands).toBe('PR open: waiting for the merge');
    expect(review.header.next).toBe('Merge the pull request, or yolo mode merges it.');
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

describe('a job\'s parts list, part 2 (issue #935)', () => {
  const run = (over: Partial<JobRun> = {}): JobRun => ({
    jobId: 'j1', machineId: 'm1', startedAt: '2026-10-01T00:10:00.000Z', endedAt: '2026-10-01T00:40:00.000Z', end: 'finished', samples: 30, lanesBusyAvg: 2,
    cpu: { avg: 0.2, peak: 0.4 }, memoryBytes: { avg: 2 * GIB, peak: 3 * GIB }, usage: { session: 0.1, week: 0.02 }, ...over,
  });

  it('lists its cost and usage: the share of each usage limit its runs burned for their lane, and what they used of the machine', () => {
    const bom = jobBom(input({ job: job('finished'), runs: [run(), run({ startedAt: '2026-10-01T01:00:00.000Z', lanesBusyAvg: 1, usage: { session: 0.03 }, cpu: { avg: 0.1, peak: 0.6 }, memoryBytes: { avg: GIB, peak: GIB } })] }));
    expect(part(bom, 'usage')).toMatchObject({ group: 'work', kind: 'usage', label: 'Usage: 8% of session, 1% of week', status: 'recorded', href: '#machines' });
    expect(part(bom, 'usage')!.detail).toBe('2 runs, 60 samples: CPU 15% on average, 60% at peak; memory 3 GiB at peak');
  });

  it('says when its usage is not measured yet: no run ended, or no samples', () => {
    expect(part(jobBom(input({ job: job('running') })), 'usage')).toBeUndefined();
    expect(part(jobBom(input({ job: job('finished'), runs: [run({ samples: 0, usage: {}, cpu: undefined, memoryBytes: undefined })] })), 'usage')).toMatchObject({ label: 'Usage: not measured', detail: '1 run, no samples' });
  });

  it('lists the commits of its pull request, as the mirror last read them, and the files it changes', () => {
    const bom = jobBom(input({ job: job('finished', {
      checkpoint: { at: '2026-10-01T00:50:00.000Z', machineId: 'm1', base: 'a', head: 'b', commits: ['abc1234 Add the cache'], bytes: 1, session: false },
      sourceState: { source: { pullRequest: PR, follow: 'open', seen: { checks: 'passing', commits: ['def5678 Test the cache', 'abc1234 Add the cache'], files: ['src/cache.ts', 'help/cache.md', 'whats-new/7.md'] } } },
    }) }));
    const commits = bom.parts.filter((p) => p.kind === 'commit');
    expect(commits.map((p) => [p.label, p.detail, p.url])).toEqual([
      ['Add the cache', 'abc1234', `${PR}/commits/abc1234`],
      ['Test the cache', 'def5678', `${PR}/commits/def5678`],
    ]);
    expect(part(bom, 'files')).toMatchObject({ group: 'code', label: '3 files changed', url: `${PR}/files`, status: 'recorded' });
    expect(part(bom, 'file:help/cache.md')).toMatchObject({ group: 'outputs', kind: 'help_page', label: 'Help page: help/cache.md', status: 'open', url: `${PR}/files` });
    expect(part(bom, 'file:whats-new/7.md')).toMatchObject({ group: 'outputs', kind: 'whats_new', label: 'What\'s new: whats-new/7.md', status: 'open' });
    expect(part(bom, 'file:src/cache.ts')).toBeUndefined();
  });

  it('marks its help pages and What\'s new lines done once its pull request is merged; WHATS-NEW.md and a CHANGELOG count too', () => {
    const bom = jobBom(input({ job: job('finished', { sourceState: { source: { pullRequest: PR, follow: 'merged', seen: { checks: 'passing', files: ['WHATS-NEW.md', 'CHANGELOG.md', 'docs/help/setup.md', 'whats-new/README.md'] } } } }) }));
    expect(bom.parts.filter((p) => p.kind === 'whats_new').map((p) => [p.label, p.status])).toEqual([['What\'s new: WHATS-NEW.md', 'done'], ['What\'s new: CHANGELOG.md', 'done']]);
    expect(bom.parts.filter((p) => p.kind === 'help_page').map((p) => p.label)).toEqual(['Help page: docs/help/setup.md']);
  });

  it('lists its pushes, and says which came after its latest checkpoint', () => {
    const bom = jobBom(input({
      job: job('running', { checkpoint: { at: '2026-10-01T00:03:30.000Z', machineId: 'm1', base: 'a', head: 'b', commits: [], bytes: 1, session: false } }),
      events: [
        event('github_proxy.done', { requestId: 'r1', own: true, op: 'git.push', repo: 'acme/app', refs: ['refs/heads/issue-7'] }, { at: '2026-10-01T00:03:00.000Z' }),
        event('github_proxy.refused', { requestId: 'r2', own: true, op: 'git.push', repo: 'acme/app', refs: ['refs/heads/dev'], reason: 'no' }),
        event('github_proxy.done', { requestId: 'r3', own: true, op: 'git.push', repo: 'acme/app', refs: ['refs/heads/issue-7'] }, { at: '2026-10-01T00:04:00.000Z' }),
      ],
    }));
    const pushes = bom.parts.filter((p) => p.kind === 'push');
    expect(pushes.map((p) => [p.label, p.detail, p.status])).toEqual([
      ['Pushed issue-7', 'acme/app', 'done'],
      ['Pushed issue-7', 'acme/app, after the latest checkpoint', 'done'],
    ]);
  });

  it('says its place in the merge order: what it goes in after, and why', () => {
    const held = jobBom(input({ job: job('finished', { sourceState: { source: { pullRequest: PR, follow: 'open', seen: { checks: 'failing' }, heldBehind: { pullRequest: 'https://github.com/acme/app/pull/11', why: 'tending' } } } }) }));
    expect(part(held, 'merge_order')).toMatchObject({ group: 'code', kind: 'merge_order', label: 'Goes in after pull request #11', detail: 'a job fixes that pull request first', status: 'open', url: 'https://github.com/acme/app/pull/11', href: '#pull-requests' });
    const merging = jobBom(input({ job: job('finished', { sourceState: { source: { pullRequest: PR, follow: 'open', seen: { checks: 'passing', mergeHeldBehind: 'https://github.com/acme/app/pull/10' } } } }) }));
    expect(part(merging, 'merge_order')).toMatchObject({ label: 'Goes in after pull request #10', detail: 'the hopper merged that pull request first; they conflict' });
    expect(part(jobBom(input({ job: job('finished', { sourceState: { source: { pullRequest: PR, follow: 'merged', heldBehind: { pullRequest: 'https://github.com/acme/app/pull/11', why: 'merging' } } } }) })), 'merge_order')).toBeUndefined();
  });
});


describe('a job\'s GitHub calls (issue #1072)', () => {
  const done = (data: Record<string, unknown>) => event('github_proxy.done', { requestId: `r${seq}`, own: true, repo: 'acme/app', ...data });

  it('counts the calls the hopper made on GitHub for the job, and the reads it answered with no call', () => {
    const bom = jobBom(input({ events: [
      done({ op: 'pr.status', number: 12, source: 'hopper' }),
      done({ op: 'pr.status', number: 12, source: 'hopper', wait: 'w1' }),
      done({ op: 'issue.view', number: 7, source: 'github' }),
      done({ op: 'issue.view', number: 7, source: 'cache' }),
      done({ op: 'pr.reviews', number: 12, source: 'github' }),
      done({ op: 'pr.create', number: 12 }),
      done({ op: 'git.push', refs: ['refs/heads/issue-7'] }),
      event('github_proxy.refused', { requestId: 'rx', own: true, op: 'pr.view', reason: 'no' }),
      event('github_proxy.failed', { requestId: 'ry', own: true, op: 'pr.view', repo: 'acme/app', error: 'GitHub answered 502' }),
    ] }));
    expect(part(bom, 'github')).toEqual({
      id: 'github', group: 'work', kind: 'github_calls', label: '4 GitHub calls', status: 'recorded',
      detail: '2 reads of GitHub, 2 writes; 3 reads answered by the hopper with no GitHub call',
    });
  });

  it('says a job that asked only the hopper made no GitHub call; a job that asked nothing has no such part', () => {
    expect(part(jobBom(input({ events: [done({ op: 'pr.status', number: 12, source: 'hopper' })] })), 'github'))
      .toMatchObject({ label: 'No GitHub calls', detail: '0 reads of GitHub, 0 writes; 1 read answered by the hopper with no GitHub call' });
    expect(part(jobBom(input({ events: [] })), 'github')).toBeUndefined();
  });
});

describe('a job\'s test databases (issue #975)', () => {
  it('lists each container its reap removed under machines: a database image as a test database, with its machine, image, start, run time and removal', () => {
    const bom = jobBom(input({ job: job('finished', { finishedAt: '2026-10-01T01:00:00.000Z' }), events: [
      event('job.containers_removed', { containers: ['c1', 'c2', 'c3', 'c4'], volumes: ['v1'], details: [
        { id: 'c1', name: 'db-1', image: 'docker.io/library/postgres:16', startedAt: '2026-10-01T00:20:00.000Z', stoppedAt: '2026-10-01T00:35:00.000Z' },
        { id: 'c2', name: 'ryuk', image: 'testcontainers/ryuk:0.11', startedAt: '2026-10-01T00:19:00.000Z' },
        { id: 'c3', name: 'made', image: 'alpine:3' },
      ] }, { machineId: 'm1', at: '2026-10-01T01:01:00.000Z' }),
    ] }));
    expect(part(bom, 'container:c1')).toEqual({
      id: 'container:c1', group: 'machines', kind: 'test_database', label: 'Test database db-1', status: 'recorded', at: '2026-10-01T00:20:00.000Z',
      detail: 'docker.io/library/postgres:16 on m1, ran 15m, removed by its reap', href: '#machines',
    });
    expect(part(bom, 'container:c2')).toMatchObject({ kind: 'container', label: 'Container ryuk', at: '2026-10-01T00:19:00.000Z', detail: 'testcontainers/ryuk:0.11 on m1, ran 42m until its reap, removed by its reap' });
    expect(part(bom, 'container:c3')).toMatchObject({ kind: 'container', label: 'Container made', detail: 'alpine:3 on m1, never started, removed by its reap' });
    // A reap of a client older than this says only its id.
    expect(part(bom, 'container:c4')).toMatchObject({ kind: 'container', label: 'Container c4', at: '2026-10-01T01:01:00.000Z', detail: 'on m1, removed by its reap' });
  });

  it('a container two reaps name (the sweep after its end) is one part', () => {
    const removed = { containers: ['c1'], volumes: [], details: [{ id: 'c1', name: 'db-1', image: 'postgres:16' }] };
    const bom = jobBom(input({ events: [event('job.containers_removed', removed, { machineId: 'm1' }), event('job.containers_removed', removed, { machineId: 'm1' })] }));
    expect(bom.parts.filter((p) => p.id === 'container:c1')).toHaveLength(1);
  });
});

describe('what a job used (issue #2498)', () => {
  it('one part under machines: the highest peak memory, the CPU time of every reap, and the OOM kills, with each machine', () => {
    const bom = jobBom(input({ events: [
      event('job.resources_used', { memoryPeakBytes: 3 * 1024 ** 3, cpuSeconds: 700, oomKills: 0 }, { machineId: 'm1', at: '2026-10-01T00:30:00.000Z' }),
      event('job.resources_used', { memoryPeakBytes: 1024 ** 3, cpuSeconds: 54.5, oomKills: 1 }, { machineId: 'm2', at: '2026-10-01T01:00:00.000Z' }),
    ] }));
    expect(part(bom, 'resources')).toEqual({
      id: 'resources', group: 'machines', kind: 'resources', label: 'Peak memory 3 GiB, CPU 12m 34s', status: 'recorded', at: '2026-10-01T01:00:00.000Z',
      detail: '1 OOM kill, on m1 and m2', href: '#machines',
    });
  });

  it('says only what was read: a small job in MiB and seconds, no OOM count when none was read', () => {
    const bom = jobBom(input({ events: [event('job.resources_used', { memoryPeakBytes: 300 * 1024 ** 2, cpuSeconds: 12.4 }, { machineId: 'm1' })] }));
    expect(part(bom, 'resources')).toMatchObject({ label: 'Peak memory 300 MiB, CPU 12s', detail: 'on m1' });
    expect(part(jobBom(input({ events: [] })), 'resources')).toBeUndefined();
  });

  it('the most disk one reap found its scratch dir and worktrees held (part 4)', () => {
    const bom = jobBom(input({ events: [
      event('job.resources_used', { memoryPeakBytes: 1024 ** 3, cpuSeconds: 60, diskBytes: 2.5 * 1024 ** 3 }, { machineId: 'm1' }),
      event('job.resources_used', { diskBytes: 700 * 1024 ** 2 }, { machineId: 'm2' }),
    ] }));
    expect(part(bom, 'resources')).toMatchObject({ label: 'Peak memory 1 GiB, CPU 1m, disk 2.5 GiB', detail: 'on m1 and m2' });
    expect(part(jobBom(input({ events: [event('job.resources_used', { diskBytes: 700 * 1024 ** 2 }, { machineId: 'm2' })] })), 'resources'))
      .toMatchObject({ label: 'Disk 700 MiB' });
  });

  // While it runs (part 3): what its scope uses now, as its machine's meter last read it.
  it('a running job: one part with its memory now, its peak and its CPU cores busy, from its machine\'s reading', () => {
    const live = liveUseOf([
      { id: 'm1', resources: { cores: 4, memTotalBytes: 8 * GIB, memAvailableBytes: 2 * GIB, jobMemoryBytes: { j1: 2 * GIB, other: GIB }, jobUse: { j1: { memoryPeakBytes: 3 * GIB, cpuSeconds: 75, oomKills: 1, cpuCores: 1.46 } } } },
      { id: 'm2', resources: { cores: 4, memTotalBytes: 8 * GIB, memAvailableBytes: 2 * GIB } },
      { id: 'm3' },
    ], 'j1');
    expect(live).toEqual([{ machineId: 'm1', memoryBytes: 2 * GIB, use: { memoryPeakBytes: 3 * GIB, cpuSeconds: 75, oomKills: 1, cpuCores: 1.46 } }]);
    expect(part(jobBom(input({ live })), 'resources-now:m1')).toEqual({
      id: 'resources-now:m1', group: 'machines', kind: 'resources', label: 'Memory 2 GiB now, peak 3 GiB, CPU 1.5 cores', status: 'running',
      at: '2026-10-01T02:10:00.000Z', detail: 'CPU 1m 15s so far, 1 OOM kill, on m1', href: '#machines',
    });
  });

  it('a job no machine reads: no part now; a reading with only its memory says only that', () => {
    expect(liveUseOf([{ id: 'm1', resources: { cores: 4, memTotalBytes: 8 * GIB, memAvailableBytes: 2 * GIB } }], 'j1')).toEqual([]);
    expect(jobBom(input({ live: [] })).parts.find((p) => p.id.startsWith('resources-now'))).toBeUndefined();
    const live = [{ machineId: 'm1', memoryBytes: 300 * 1024 ** 2 }];
    expect(part(jobBom(input({ live })), 'resources-now:m1')).toMatchObject({ label: 'Memory 300 MiB now', detail: 'on m1' });
  });
});
