// An issue waits on its batch, read from GitHub (issue #1337): job pull requests merge into the landing branch (`main`), and a batch run
// carries them into the default branch (`dev`), whose merge closes their issues. Between the two the issue is open and its
// timeline may show no cross-reference of the merge. The done-check counts the merge as done, and Intake neither offers
// the issue again nor runs it again: one rule, read from GitHub (batch-wait.ts).
import { describe, expect, it } from 'vitest';
import type { IntakeContext } from '../../src/domain/intake.ts';
import { createFakeGitHub, createGitHubSource } from '../../src/sources/github/index.ts';
import { AWAITS_BATCH } from '../../src/sources/github/origin.ts';
import { issueNodeId, jobGraph } from '../../src/domain/job-graph.ts';
import { awaitingBatchKeys } from '../../src/sources/intake-live.ts';
import { REPO, githubConfig, jobForIssue, testTrust } from './fixtures/github-support.ts';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const at = (msBeforeNow: number) => new Date(NOW - msBeforeNow).toISOString();
const MIN = 60_000;
/** Longer than a merge waits for its batch run (three hours, `BATCH_WAIT_MS`). */
const LONG_AGO = 4 * 60 * MIN;
const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;

function setup(o: { landing?: boolean; ended?: string[] } = {}) {
  const gh = createFakeGitHub({ defaultBranch: 'dev' });
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ended = new Set(o.ended ?? []);
  const intake: IntakeContext = {
    holder: 'a1b2c3d4e5f6', othersKnown: () => new Set(), migration: () => ({ at: '2026-10-01T09:00:00.000Z', changes: [] }), migrated: () => undefined,
    record: (type, data) => { events.push({ type, data }); },
    requestOpened: (key, hash) => events.some((e) => e.type === 'source.request_opened' && e.data.key === key && e.data.hash === hash),
    requestsWaiting: () => [], history: () => ({ jobs: [{ id: 'job-1', status: 'finished' }] }),
  };
  const source = createGitHubSource({
    name: 'github', kind: 'github-account', mode: 'account', whoami: 'owner', assignee: () => 'owner', config: githubConfig(), api: gh,
    clock: { now: () => new Date(NOW) }, trust: testTrust(), intake,
    knownKeys: (keys) => new Set(keys.filter((k) => ended.has(k))), rerunnable: (keys) => new Set(keys.filter((k) => ended.has(k))),
    ...(o.landing === false ? {} : { landingBranch: () => 'main' }),
  });
  return { gh, source, events };
}

/** A pull request that closes issue `n`, into `main`, merged at `mergedAt`: GitHub leaves the issue open. */
function mergedIntoMain(gh: ReturnType<typeof setup>['gh'], n: number, createdAt: string, mergedAt: string, o: { crossReferenced?: false } = {}) {
  const pr = gh.openPullRequest(REPO, n, { createdAt, base: 'main', ...o });
  gh.mergePullRequest(pr.url, mergedAt);
  return { url: pr.url, number: Number(pr.url.split('/').pop()) };
}

/** An open batch run of `main` into `dev`, with the text the batch runner writes (`batchBody`). */
const openBatch = (gh: ReturnType<typeof setup>['gh'], createdAt: string, merges: number[], closes: number[]) =>
  gh.openUnlinkedPullRequest(REPO, {
    createdAt, headRef: 'hopper-batch/abc123def456', base: 'dev',
    body: ['A batch run.', '', ...merges.map((m) => `- #${m}`), '', ...closes.map((c) => `Closes #${c}`)].join('\n'),
  });

describe('the done-check counts a merge into the landing branch (issue #1337)', () => {
  it('the job\'s own pull request merged into main, no cross-reference on the issue: done, the issue still open', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    mergedIntoMain(gh, 1, '2026-10-02T10:30:00.000Z', '2026-10-02T11:00:00.000Z', { crossReferenced: false });
    expect(gh.issue(REPO, 1).state).toBe('open');
    expect(await source.notComplete!(jobForIssue(1))).toBeUndefined();
  });

  it('a job made after the merge, while the open batch run closes the issue: done, and no run again', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const pr = mergedIntoMain(gh, 1, at(5 * 60 * MIN), at(4 * 60 * MIN));
    openBatch(gh, at(30 * MIN), [pr.number], [1]);
    expect(await source.notComplete!(jobForIssue(1))).toBeUndefined();
  });

  it('a merge into main no open batch run names, older than the wait and before the job, is not this job\'s work', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    mergedIntoMain(gh, 1, at(LONG_AGO + 60 * MIN), at(LONG_AGO));
    expect(await source.notComplete!(jobForIssue(1))).toMatch(/^the issue .* is open/);
  });

  it('with no landing branch, a merge into another branch is not read', async () => {
    const { gh, source } = setup({ landing: false });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    mergedIntoMain(gh, 1, '2026-10-02T10:30:00.000Z', '2026-10-02T11:00:00.000Z', { crossReferenced: false });
    expect(await source.notComplete!(jobForIssue(1))).toMatch(/no pull request in .* closes or references it/);
    expect(gh.calls.map((c) => c.method)).not.toContain('mergedPullRequestsInto');
  });
});

describe('Intake does not offer an issue that waits on its batch (issue #1337)', () => {
  it('an issue named by an open batch run\'s closing lines, its job ended: no reopened card, no job', async () => {
    const { gh, source, events } = setup({ ended: [url(1)] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:done'] });
    const pr = mergedIntoMain(gh, 1, at(90 * MIN), at(80 * MIN));
    openBatch(gh, at(20 * MIN), [pr.number], [1]);
    expect(await source.discover()).toEqual([]);
    const [card] = source.intake!();
    expect(card).toMatchObject({ key: url(1), reason: AWAITS_BATCH, group: 'pr-waiting' });
    expect(card!.action).toBeUndefined();
    expect(card!.request).toBeUndefined();
    expect(events.filter((e) => e.type === 'source.request_opened')).toEqual([]);
  });

  it('a new issue whose closing pull request merged into main, no batch run yet: not taken, waits on its batch run', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    mergedIntoMain(gh, 1, at(40 * MIN), at(30 * MIN), { crossReferenced: false });
    expect(await source.discover()).toEqual([]);
    expect(source.intake!()[0]).toMatchObject({ key: url(1), reason: AWAITS_BATCH, group: 'pr-waiting' });
  });

  it('a merge an open batch run opened after does not carry is history: the issue is taken again', async () => {
    const { gh, source } = setup({ ended: [url(1)] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    mergedIntoMain(gh, 1, at(90 * MIN), at(80 * MIN));
    openBatch(gh, at(20 * MIN), [], []);
    expect((await source.discover()).map((i) => i.key)).toEqual([url(1)]);
  });
});

describe('the job graph shows an issue that waits on its batch (issue #1337)', () => {
  it('an issue named by an open batch run\'s closing lines is done in the graph, waiting on its batch run', async () => {
    const { gh, source } = setup({ ended: [url(1)] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:done'] });
    const pr = mergedIntoMain(gh, 1, at(90 * MIN), at(80 * MIN));
    openBatch(gh, at(20 * MIN), [pr.number], [1]);
    await source.discover();
    const status = { name: 'github', kind: 'github-account', state: 'ok' as const, detail: { intake: source.intake!() } };
    const g = jobGraph({ jobs: [{ ...jobForIssue(1), status: 'failed' }], awaitingBatch: awaitingBatchKeys([status]) });
    expect(g.nodes.find((n) => n.id === issueNodeId(REPO, 1))).toMatchObject({ stage: 'done', awaitsBatch: true });
  });
});
