// Issue #900: the job graph — each job's stage (partly done among them), the typed edges between jobs, issues and pull
// requests, the job trees and what blocks a root. Pure.
import { describe, expect, it } from 'vitest';
import { handoffNodeId, issueNodeId, jobGraph, jobNodeId, pullRequestNodeId, questionNodeId, stageOf, type JobGraph } from '../../src/domain/job-graph.ts';
import { placeGraph } from '../../src/domain/issue-graph.ts';
import type { Job, JobStatus } from '../../src/domain/types.ts';

const PR = (n: number) => `https://github.com/acme/app/pull/${n}`;

let made = 0;
const job = (id: string, status: JobStatus, over: Partial<Job> = {}, issue = 1): Job => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 50, status, approved: true, attempts: 1,
  createdAt: new Date(Date.UTC(2026, 9, 1, 0, made++)).toISOString(), updatedAt: '2026-10-02T00:00:00.000Z',
  source: { source: 'github', kind: 'issue', key: `https://github.com/acme/app/issues/${issue}`, url: `https://github.com/acme/app/issues/${issue}`, repo: 'acme/app', number: issue, title: `issue ${issue}` },
  ...over,
} as Job);
const followed = (pullRequest: string, follow: string, seen?: object) => ({ sourceState: { source: { pullRequest, follow, ...(seen ? { seen } : {}) } } });

const node = (g: JobGraph, id: string) => g.nodes.find((n) => n.id === id)!;
const kinds = (g: JobGraph) => g.edges.map((e) => `${e.from} ${e.kind} ${e.to}`).sort();

describe('the stage of a job (issue #900)', () => {
  it.each<[JobStatus, string]>([
    ['queued', 'queued'], ['held', 'queued'], ['claimed', 'queued'], ['running', 'running'],
    ['waiting_answer', 'waiting'], ['operator_led', 'waiting'], ['parked', 'waiting'], ['waiting_on', 'waiting'],
    ['failed', 'failed'], ['cancelled', 'cancelled'], ['rejected', 'cancelled'], ['finished', 'done'],
  ])('%s is %s', (status, stage) => { expect(stageOf(job('j', status))).toBe(stage); });

  it('a job waiting on its own command runs (issue #1037); flagged stuck, it waits', () => {
    const wait = { for: 'the test run', until: 'background command 1 ends', since: '2026-10-02T01:00:00.000Z', ownCommand: true as const };
    expect(stageOf(job('j', 'waiting_on', { wait }))).toBe('running');
    expect(stageOf(job('j', 'waiting_on', { wait: { ...wait, stuckAt: '2026-10-02T02:00:00.000Z' } }))).toBe('waiting');
  });

  it('a finished job with its pull request open is PR open; merged, done', () => {
    expect(stageOf(job('j', 'finished', followed(PR(5), 'open')))).toBe('pr_open');
    expect(stageOf(job('j', 'finished', followed(PR(5), 'merged')))).toBe('done');
  });

  it('a partly done job is partly done until its pull request merges', () => {
    expect(stageOf(job('j', 'finished', { partlyDone: PR(5), ...followed(PR(5), 'open') }))).toBe('partly_done');
    expect(stageOf(job('j', 'finished', { partlyDone: PR(5) }))).toBe('partly_done');
    expect(stageOf(job('j', 'finished', { partlyDone: PR(5), ...followed(PR(5), 'merged') }))).toBe('done');
  });

  it('a partly done job that handed its pull request on to a tend or a rework is done (issue #994)', () => {
    expect(stageOf(job('j', 'finished', { partlyDone: PR(5), ...followed(PR(5), 'tended') }))).toBe('done');
    expect(stageOf(job('j', 'finished', { partlyDone: PR(5), ...followed(PR(5), 'reworked') }))).toBe('done');
  });
});

describe('the job graph (issue #900)', () => {
  it('a job node carries its stage, tasks, lane, time in stage and pull request with its checks', () => {
    const g = jobGraph({ jobs: [
      job('run', 'running', { tasks: { done: 2, total: 5 }, laneId: 'm1/lane-1', startedAt: '2026-10-02T01:00:00.000Z' }, 1),
      job('pr', 'finished', { finishedAt: '2026-10-02T02:00:00.000Z', ...followed(PR(7), 'open', { checks: 'failing', draft: false, conflicting: true }) }, 2),
    ] });
    expect(node(g, jobNodeId('run'))).toMatchObject({ kind: 'job', stage: 'running', tasks: { done: 2, total: 5 }, laneId: 'm1/lane-1', stageSince: '2026-10-02T01:00:00.000Z', repo: 'acme/app', number: 1 });
    expect(node(g, jobNodeId('pr'))).toMatchObject({ stage: 'pr_open', stageSince: '2026-10-02T02:00:00.000Z', pullRequest: { url: PR(7), state: 'open', checks: 'failing', conflicting: true } });
    expect(node(g, pullRequestNodeId(PR(7)))).toMatchObject({ kind: 'pull_request', label: 'goal pr', number: 7, stage: 'pr_open' });
    expect(g.stages).toEqual({ running: 1, pr_open: 1 });
  });

  it('a partly done job names the pull request that blocks the rest and what runs after the merge', () => {
    const g = jobGraph({ jobs: [job('part', 'finished', { partlyDone: PR(9), ...followed(PR(9), 'open') }, 4)] });
    expect(node(g, jobNodeId('part')).partlyDone).toEqual({ pullRequest: PR(9), afterMerge: 'the next part of acme/app#4 runs' });
    expect(kinds(g)).toContain(`${jobNodeId('part')} waits_on_merge ${pullRequestNodeId(PR(9))}`);
    expect(node(g, issueNodeId('acme/app', 4)).stage).toBe('partly_done');
  });

  it('types its edges: works, next part, rerun, spawned, plan to apply, opened', () => {
    const part = job('part', 'finished', { partlyDone: PR(9), ...followed(PR(9), 'merged') }, 1);
    const next = job('next', 'running', { rerunOf: 'part' }, 1);
    const again = job('again', 'queued', { rerunOf: 'next' }, 1);
    const fork = job('fork', 'running', { forkOf: { jobId: 'next', questionId: 'q', kind: 'research', question: 'why?' } }, 1);
    const plan = job('plan', 'finished', {}, 2);
    const apply = job('apply', 'queued', { followOn: { jobId: 'plan', proposalId: 'p', pathId: 'a', title: 't', text: 'x' } as Job['followOn'] }, 2);
    const g = jobGraph({ jobs: [apply, again, fork, plan, next, part] });
    expect(kinds(g)).toEqual([
      `${issueNodeId('acme/app', 1)} works ${jobNodeId('again')}`,
      `${issueNodeId('acme/app', 1)} works ${jobNodeId('fork')}`,
      `${issueNodeId('acme/app', 1)} works ${jobNodeId('next')}`,
      `${issueNodeId('acme/app', 1)} works ${jobNodeId('part')}`,
      `${issueNodeId('acme/app', 2)} works ${jobNodeId('apply')}`,
      `${issueNodeId('acme/app', 2)} works ${jobNodeId('plan')}`,
      `${jobNodeId('next')} rerun ${jobNodeId('again')}`,
      `${jobNodeId('next')} spawned ${jobNodeId('fork')}`,
      `${jobNodeId('part')} next_part ${jobNodeId('next')}`,
      `${jobNodeId('part')} opened ${pullRequestNodeId(PR(9))}`,
      `${jobNodeId('plan')} plan_apply ${jobNodeId('apply')}`,
    ].sort());
  });

  it('adds required children as parent edges and the rest as follow-ups, from the lineage links', () => {
    const g = jobGraph({
      jobs: [job('root', 'finished', {}, 1), job('child', 'running', {}, 2)],
      links: [
        { parent: { repo: 'acme/app', number: 1 }, child: { repo: 'acme/app', number: 2 }, required: true },
        { parent: { repo: 'acme/app', number: 1 }, child: { repo: 'acme/app', number: 3, url: 'https://github.com/acme/app/issues/3' }, required: false },
      ],
    });
    expect(kinds(g)).toContain(`${issueNodeId('acme/app', 1)} parent ${issueNodeId('acme/app', 2)}`);
    expect(kinds(g)).toContain(`${issueNodeId('acme/app', 1)} follow_up ${issueNodeId('acme/app', 3)}`);
    expect(node(g, issueNodeId('acme/app', 3)).stage).toBe('no_job');
  });

  it('reads sub-issues and closing pull requests from the issue graph for the issues it has', () => {
    const issueGraph = placeGraph({
      issue: { repo: 'acme/app', number: 1, url: 'https://github.com/acme/app/issues/1', title: 'Root work', state: 'OPEN', updatedAt: '2026-10-01T00:00:00Z' },
      owner: { login: 'acme' }, projects: [], references: [],
      closedBy: [{ kind: 'pull_request', repo: 'acme/app', number: 8, url: PR(8), state: 'OPEN' }],
      subIssues: [{ kind: 'issue', repo: 'acme/app', number: 6, url: 'https://github.com/acme/app/issues/6', state: 'CLOSED' }],
    });
    const g = jobGraph({ jobs: [job('root', 'finished', followed(PR(8), 'open'), 1)], issueGraph });
    expect(kinds(g)).toContain(`${issueNodeId('acme/app', 1)} parent ${issueNodeId('acme/app', 6)}`);
    expect(kinds(g)).toContain(`${pullRequestNodeId(PR(8))} closes ${issueNodeId('acme/app', 1)}`);
    expect(node(g, issueNodeId('acme/app', 1))).toMatchObject({ label: 'Root work', repo: 'acme/app', number: 1 });
    // The sub-issue is closed on GitHub and no job works it: it is done.
    expect(node(g, issueNodeId('acme/app', 6)).stage).toBe('done');
  });

  it('groups connected nodes into trees rooted at an issue, and marks what blocks the root', () => {
    const g = jobGraph({
      jobs: [job('root', 'finished', {}, 1), job('child', 'failed', {}, 2), job('done', 'finished', {}, 3), job('alone', 'queued', {}, 9)],
      links: [
        { parent: { repo: 'acme/app', number: 1 }, child: { repo: 'acme/app', number: 2 }, required: true },
        { parent: { repo: 'acme/app', number: 1 }, child: { repo: 'acme/app', number: 3 }, required: true },
      ],
    });
    expect(g.trees).toHaveLength(2);
    const tree = g.trees.find((t) => t.root === issueNodeId('acme/app', 1))!;
    expect(tree.nodes).toHaveLength(6);
    expect(tree.blocking.sort()).toEqual([issueNodeId('acme/app', 2), jobNodeId('child')].sort());
    expect(tree.stages).toEqual({ done: 2, failed: 1 });
    expect(g.trees.find((t) => t.root === issueNodeId('acme/app', 9))!.blocking).toEqual([jobNodeId('alone')]);
  });

  it('survives a cycle and an edge to a job it does not have', () => {
    const a = job('a', 'running', { rerunOf: 'b' }, 1);
    const b = job('b', 'finished', { rerunOf: 'a' }, 1);
    const c = job('c', 'running', { rerunOf: 'gone' }, 1);
    const g = jobGraph({ jobs: [a, b, c] });
    expect(g.trees).toHaveLength(1);
    expect(kinds(g).filter((k) => k.includes('gone'))).toEqual([]);
  });

  it('reads blocked-by links from the issue graph: a blocked issue to its blocker, which blocks the root', () => {
    const issueGraph = placeGraph({
      issue: { repo: 'acme/app', number: 1, url: 'https://github.com/acme/app/issues/1', title: 'Root work', state: 'OPEN', updatedAt: '2026-10-01T00:00:00Z' },
      owner: { login: 'acme' }, projects: [], references: [], closedBy: [], subIssues: [],
      blockedBy: [{ kind: 'issue', repo: 'acme/lib', number: 4, url: 'https://github.com/acme/lib/issues/4', state: 'OPEN' }],
    });
    const g = jobGraph({ jobs: [job('root', 'finished', {}, 1)], issueGraph });
    expect(kinds(g)).toContain(`${issueNodeId('acme/app', 1)} blocked_by ${issueNodeId('acme/lib', 4)}`);
    expect(node(g, issueNodeId('acme/lib', 4)).stage).toBe('no_job');
    expect(g.trees[0]).toMatchObject({ root: issueNodeId('acme/app', 1), blocking: [issueNodeId('acme/lib', 4)] });
  });

  it('adds an open question and an open hand-off as nodes of their job, which wait on a person', () => {
    const g = jobGraph({
      jobs: [job('asks', 'waiting_answer', {}, 1), job('broke', 'failed', {}, 2)],
      questions: [
        { id: 'q1', jobId: 'asks', text: 'Which database should the cache use? Options follow.', since: '2026-10-02T03:00:00.000Z' },
        { id: 'q2', jobId: 'gone', text: 'no job here', since: '2026-10-02T03:00:00.000Z' },
      ],
      handoffs: [{ id: 'h1', jobId: 'broke', text: 'The build fails on a missing secret.', since: '2026-10-02T04:00:00.000Z' }],
    });
    expect(node(g, questionNodeId('q1'))).toMatchObject({ kind: 'question', stage: 'waiting', label: 'Which database should the cache use? Options follow.', stageSince: '2026-10-02T03:00:00.000Z', jobId: 'asks' });
    expect(node(g, handoffNodeId('h1'))).toMatchObject({ kind: 'handoff', stage: 'waiting', label: 'The build fails on a missing secret.', jobId: 'broke' });
    expect(g.nodes.some((n) => n.id === questionNodeId('q2'))).toBe(false);
    expect(kinds(g)).toContain(`${jobNodeId('asks')} asks ${questionNodeId('q1')}`);
    expect(kinds(g)).toContain(`${jobNodeId('broke')} hands_off ${handoffNodeId('h1')}`);
    expect(g.trees.find((t) => t.root === issueNodeId('acme/app', 1))!.blocking).toContain(questionNodeId('q1'));
    // Only jobs count in the stages.
    expect(g.stages).toEqual({ waiting: 1, failed: 1 });
  });

  it('links a pull request based on another one\'s branch to it: stacked on', () => {
    const g = jobGraph({ jobs: [
      job('low', 'finished', followed(PR(10), 'open', { checks: 'passing', draft: false, conflicting: false, base: 'dev', headRef: 'issue-1-part' }), 1),
      job('high', 'finished', followed(PR(11), 'open', { checks: 'pending', draft: false, conflicting: false, base: 'issue-1-part', headRef: 'issue-2' }), 2),
      job('other', 'finished', { source: { ...job('x', 'queued').source!, repo: 'acme/other', number: 3 }, ...followed('https://github.com/acme/other/pull/12', 'open', { checks: 'none', draft: false, conflicting: false, base: 'issue-1-part', headRef: 'x' }) }),
    ] });
    expect(kinds(g)).toContain(`${pullRequestNodeId(PR(11))} stacked_on ${pullRequestNodeId(PR(10))}`);
    expect(kinds(g).filter((k) => k.includes('stacked_on'))).toHaveLength(1);
    expect(node(g, jobNodeId('high')).pullRequest).toMatchObject({ base: 'issue-1-part', headRef: 'issue-2' });
  });
});

describe('the job graph in plain words (issue #935)', () => {
  it('leads a node with its title, the repository and number apart', () => {
    const g = jobGraph({ jobs: [job('a', 'running', {}, 3)] });
    expect(node(g, issueNodeId('acme/app', 3))).toMatchObject({ label: 'issue 3', repo: 'acme/app', number: 3 });
    expect(node(g, jobNodeId('a'))).toMatchObject({ label: 'goal a', repo: 'acme/app', number: 3 });
  });

  it('says each stage in human terms', () => {
    const g = jobGraph({
      maxAttempts: 2,
      jobs: [
        job('run', 'running', {}, 1),
        job('first', 'failed', {}, 2), job('second', 'running', { rerunOf: 'first' }, 2),
        job('plan', 'running', { spec: { executor: 'test', payload: {}, goal: 'p', proposal: true } } as Partial<Job>, 3),
        job('ask', 'waiting_answer', { proposalId: 'p1', spec: { executor: 'test', payload: {}, goal: 'p', proposal: true } } as Partial<Job>, 4),
        job('q', 'waiting_answer', { questionId: 'q1' }, 5),
        job('review', 'finished', followed(PR(1), 'open', { checks: 'passing' }), 6),
        job('red', 'finished', followed(PR(2), 'open', { checks: 'failing' }), 7),
        job('merged', 'finished', followed(PR(3), 'merged'), 8),
        job('part', 'finished', { partlyDone: PR(4), ...followed(PR(4), 'open') }, 9),
        job('pending', 'finished', followed(PR(5), 'open', { checks: 'pending' }), 10),
        job('draft', 'finished', followed(PR(6), 'open', { draft: true }), 11),
      ],
      questions: [{ id: 'q1', jobId: 'q', text: 'Which?', since: '2026-10-02T00:00:00.000Z' }],
    });
    const words = (id: string) => node(g, id).stageText;
    expect(words(jobNodeId('run'))).toBe('Building it');
    expect(words(jobNodeId('second'))).toBe('Building it (attempt 2 of 3)');
    expect(words(jobNodeId('plan'))).toBe('Plan');
    expect(words(jobNodeId('ask'))).toBe('Waiting on you: approve the plan');
    expect(words(jobNodeId('q'))).toBe('Waiting on you: answer a question');
    expect(words(questionNodeId('q1'))).toBe('Waiting on you: answer it');
    expect(words(jobNodeId('review'))).toBe('PR open: waiting for the merge');
    expect(words(jobNodeId('red'))).toBe('PR open: fixing checks');
    // No "Ready for review" (issue #1067): an open pull request names what it waits on.
    expect(words(jobNodeId('pending'))).toBe('PR open: checks running');
    expect(words(jobNodeId('draft'))).toBe('PR open: draft');
    expect(g.nodes.map((n) => n.stageText)).not.toContain('Ready for review');
    expect(words(jobNodeId('merged'))).toBe('Merged');
    expect(words(pullRequestNodeId(PR(3)))).toBe('Merged');
    expect(words(jobNodeId('part'))).toBe('Part shipped: the rest runs after the merge');
    expect(words(issueNodeId('acme/app', 1))).toBe('Building it');
    expect(node(g, jobNodeId('q')).waitsOnYou).toBe(true);
    expect(node(g, questionNodeId('q1')).waitsOnYou).toBe(true);
    expect(node(g, jobNodeId('run')).waitsOnYou).toBeUndefined();
  });

  it('says a wait on its own command as running, with its runtime; the outside world only for the other waits (issue #1037)', () => {
    const wait = { for: 'the test run', until: 'background command 1 ends', since: '2026-10-02T01:00:00.000Z', ownCommand: true as const };
    const g = jobGraph({
      jobs: [
        job('own', 'waiting_on', { wait }, 1),
        job('stuck', 'waiting_on', { wait: { ...wait, stuckAt: '2026-10-02T02:00:00.000Z' } }, 2),
        job('out', 'waiting_on', { wait: { for: 'a review', until: 'a background poll of the review', since: '2026-10-02T01:00:00.000Z' } }, 3),
      ],
    });
    expect(node(g, jobNodeId('own'))).toMatchObject({ stage: 'running', stageText: 'Running: waiting on its own command', stageSince: '2026-10-02T01:00:00.000Z' });
    expect(node(g, jobNodeId('own')).waitsOnYou).toBeUndefined();
    expect(node(g, jobNodeId('stuck'))).toMatchObject({ stage: 'waiting', stageText: 'Waiting on you: its own command is gone, so it is stuck', waitsOnYou: true });
    expect(node(g, jobNodeId('out'))).toMatchObject({ stage: 'waiting', stageText: 'Waiting on nothing recorded' });
  });

  it('a job on its own wait carries what it waits on, and says it (issue #1245)', () => {
    const since = '2026-10-02T01:00:00.000Z';
    const g = jobGraph({
      jobs: [
        job('pr', 'waiting_on', { wait: { for: 'the base change', since, on: { kind: 'pull_request', number: 12, about: 'merge' } } }, 1),
        job('legacy', 'waiting_on', { wait: { for: 'something', since } }, 2),
      ],
    });
    expect(node(g, jobNodeId('pr'))).toMatchObject({ stage: 'waiting', stageText: 'Waiting on PR #12 to merge', stageSince: since, waitOn: { kind: 'pull_request', number: 12, about: 'merge' } });
    expect(node(g, jobNodeId('legacy'))).toMatchObject({ stage: 'waiting', stageText: 'Waiting on nothing recorded' });
    expect(node(g, jobNodeId('legacy')).waitOn).toBeUndefined();
  });

  it('sums up each tree in one line: pieces shipped, being redone, waiting on you', () => {
    const g = jobGraph({
      jobs: [
        job('r', 'finished', followed(PR(1), 'merged'), 1), job('a', 'finished', {}, 2), job('b', 'finished', {}, 3),
        job('c1', 'failed', {}, 4), job('c2', 'running', { rerunOf: 'c1' }, 4),
      ],
      links: [2, 3, 4].map((n) => ({ parent: { repo: 'acme/app', number: 1 }, child: { repo: 'acme/app', number: n }, required: true })),
    });
    expect(g.trees[0]!.summary).toBe('3 of 4 pieces shipped, 1 being redone, nothing waiting on you.');
    const asks = jobGraph({ jobs: [job('w', 'waiting_answer', {}, 1)], questions: [{ id: 'q', jobId: 'w', text: 'Which?', since: '2026-10-02T00:00:00.000Z' }] });
    expect(asks.trees[0]!.summary).toBe('0 of 1 piece shipped, 1 waiting on you.');
  });
});

describe('the tend attempts of a pull request (issue #927)', () => {
  const tended = (id: string, step: string, nextJobId: string, over: Partial<Job> = {}) =>
    job(id, 'finished', { sourceState: { source: { pullRequest: PR(5), follow: 'tended', tended: { pullRequest: PR(5), step, nextJobId } } }, ...over });

  it('its node lists each tend, oldest first: the job, the step, its status, and when it started and ended', () => {
    const a = tended('a', 'rebase', 'b');
    const b = tended('b', 'fix_checks', 'c', { rerunOf: 'a', startedAt: '2026-10-02T01:00:00.000Z', finishedAt: '2026-10-02T01:10:00.000Z' });
    const c = job('c', 'running', { rerunOf: 'b', startedAt: '2026-10-02T02:00:00.000Z' });
    const g = jobGraph({ jobs: [a, b, c] });
    expect(node(g, pullRequestNodeId(PR(5))).tends).toEqual([
      { jobId: 'b', step: 'rebase', status: 'finished', startedAt: '2026-10-02T01:00:00.000Z', endedAt: '2026-10-02T01:10:00.000Z' },
      { jobId: 'c', step: 'fix_checks', status: 'running', startedAt: '2026-10-02T02:00:00.000Z' },
    ]);
  });

  it('while a tend job works on it, the pull request is open, not ended', () => {
    const g = jobGraph({ jobs: [tended('a', 'rebase', 'b'), job('b', 'running', { rerunOf: 'a' })] });
    expect(node(g, pullRequestNodeId(PR(5))).stage).toBe('pr_open');
  });

  it('a pull request no tend touched has no attempts', () => {
    const g = jobGraph({ jobs: [job('a', 'finished', followed(PR(5), 'open'))] });
    expect(node(g, pullRequestNodeId(PR(5)))).not.toHaveProperty('tends');
  });
});

describe('an issue that waits on its batch (issue #1337)', () => {
  const ISSUE = 'https://github.com/acme/app/issues/1';

  it('is done, says its batch run closes it, and waits on nobody, though its job failed and the ledger missed the merge', () => {
    const g = jobGraph({ jobs: [job('a', 'failed', {}, 1)], awaitingBatch: new Set([ISSUE]) });
    expect(node(g, issueNodeId('acme/app', 1))).toMatchObject({ stage: 'done', awaitsBatch: true, stageText: 'Merged: waits on its batch run' });
    expect(node(g, issueNodeId('acme/app', 1))).not.toHaveProperty('waitsOnYou');
    expect(g.trees[0]!.summary).toBe('1 of 1 piece shipped, nothing waiting on you.');
  });

  it('an issue not in the list is as before', () => {
    const g = jobGraph({ jobs: [job('a', 'failed', {}, 1)], awaitingBatch: new Set(['https://github.com/acme/app/issues/2']) });
    expect(node(g, issueNodeId('acme/app', 1))).toMatchObject({ stage: 'failed' });
    expect(node(g, issueNodeId('acme/app', 1))).not.toHaveProperty('awaitsBatch');
  });

  it('adds no issue the graph does not hold', () => {
    const g = jobGraph({ jobs: [job('a', 'finished', {}, 1)], awaitingBatch: new Set(['https://github.com/acme/app/issues/9']) });
    expect(g.nodes.find((n) => n.id === issueNodeId('acme/app', 9))).toBeUndefined();
  });
});

describe('a job that ended well, with a process of it that failed (issue #2722 part 7)', () => {
  it('says it after where it stands, on its node and its issue\'s', () => {
    const note = { said: 'a process of the job failed: tsc ran out of heap', processes: 1 };
    const g = jobGraph({ jobs: [job('j', 'finished', { failedProcesses: note }, 3), job('k', 'failed', { failedProcesses: note }, 4)] });
    expect(node(g, jobNodeId('j'))).toMatchObject({ stage: 'done', failedProcesses: note, stageText: `Done, but ${note.said}` });
    expect(node(g, issueNodeId('acme/app', 3)).stageText).toBe(`Done, but ${note.said}`);
    expect(node(g, jobNodeId('k')).failedProcesses).toBeUndefined();
  });

  it('a job with no such note says only where it stands', () => {
    const g = jobGraph({ jobs: [job('j', 'finished', {}, 3)] });
    expect(node(g, jobNodeId('j')).failedProcesses).toBeUndefined();
    expect(node(g, jobNodeId('j')).stageText).toBe('Done');
  });
});
