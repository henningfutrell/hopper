// A GitLab job's merge request and its signals (issue #1642, design.md "A GitLab job's merge request"): done is judged by
// the merge requests that close its issue — one open, ready, its pipeline not failed, or one merged since the job began —,
// and `check` cancels a job whose issue closed, lost the label, or went away, and flags one unassigned. Over a fake GitLab on
// loopback.
//
// Feature: a GitLab job's merge request
//   Scenario: an open merge request that closes the issue, not a draft, free of merge conflicts, its pipeline not failed: done
//   Scenario: a draft, one with merge conflicts or a failed pipeline, or none: not done, and why, by the merge request's number
//   Scenario: a merge request merged since the job began: done; one merged before it: not
//   Scenario: the issue closed by a merged merge request: done
// Feature: signals for a running GitLab job
//   Scenario: the issue closed by somebody else's work, the label removed, or the issue gone: the job is cancelled
//   Scenario: the issue closed by the job's own merge request: no cancel; a job on its own wait ends finished
//   Scenario: unassigned while it waits: cancelled; once started: flagged, and flagged again when assigned again
//   Scenario: a waiting job's issue on the backburner: cancelled
//   Scenario: another source's jobs, and ended jobs, are not read; with no account, nothing is read
import { afterEach, describe, expect, it } from 'vitest';
import { createGitLabAccount } from '../../src/gitlab/account.ts';
import { createGitLabSource } from '../../src/gitlab/source.ts';
import type { GitLabAccountRecord } from '../../src/domain/gitlab-account.ts';
import type { Job, JobStatus } from '../../src/domain/types.ts';
import { createFakeGitLab, type FakeGitLabIssue, type FakeGitLabMergeRequest } from '../support/fake-gitlab.ts';
import { memoryAccountStore, systemOf } from '../support/system-secrets.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const BEGAN = '2026-10-17T10:00:00Z';
const BEFORE = '2026-10-17T09:00:00Z';
const AFTER = '2026-10-17T11:00:00Z';

const ISSUE: FakeGitLabIssue = { project: 'ada/tools', iid: 1, title: 'Fix the parser', description: 'x', author: 'ada', assignees: ['ada'], labels: ['hopper', 'hopper:claimed'] };

async function setup(o: { issue?: Partial<FakeGitLabIssue>; mergeRequests?: Omit<FakeGitLabMergeRequest, 'project'>[]; connect?: boolean } = {}) {
  const gitlab = await createFakeGitLab({ issues: [{ ...ISSUE, ...o.issue }] });
  cleanups.push(() => gitlab.close());
  gitlab.tokens.set('glpat-ada', { id: 7, username: 'ada', email: 'ada@example.com', projects: ['ada/tools'] });
  gitlab.mergeRequests.push(...(o.mergeRequests ?? []).map((m) => ({ project: 'ada/tools', ...m })));
  let kept: GitLabAccountRecord | undefined;
  const account = createGitLabAccount({
    settings: { getGitLabAccount: () => (kept ? structuredClone(kept) : undefined), setGitLabAccount: (r) => { kept = r ?? undefined; } },
    secrets: systemOf(memoryAccountStore().store), clock: { now: () => new Date() }, logger: { info: () => undefined, warn: () => undefined },
  });
  if (o.connect !== false) {
    await account.connect({ token: 'glpat-ada', baseUrl: gitlab.url });
    account.choose(['ada/tools']);
  }
  const source = createGitLabSource({ name: 'gitlab-account', account });
  return { gitlab, source };
}

const job = (o: { status?: JobStatus; iid?: number; source?: string; unassignedAt?: string } = {}): Job => ({
  id: 'j1', status: o.status ?? 'running', createdAt: BEGAN,
  source: { source: o.source ?? 'gitlab-account', kind: 'gitlab-account', key: 'k', url: 'u', title: 't', author: 'ada', assignee: 'ada', repo: 'ada/tools', number: o.iid ?? 1, labels: [] },
  ...(o.unassignedAt ? { sourceState: { sync: { unassignedAt: o.unassignedAt } } } : {}),
} as unknown as Job);

const open = (iid: number, more: Partial<FakeGitLabMergeRequest> = {}) => ({ iid, closes: [1], state: 'opened' as const, createdAt: AFTER, ...more });

describe('a GitLab job\'s merge request', () => {
  it('is done with an open merge request that closes the issue, ready, its pipeline not failed', async () => {
    for (const pipeline of [undefined, 'success', 'running']) {
      const s = await setup({ mergeRequests: [open(4, pipeline ? { pipeline } : {})] });
      expect(await s.source.notComplete!(job())).toBeUndefined();
    }
  });

  it('is not done with a draft, merge conflicts, a failed pipeline or none, and says why', async () => {
    const s = await setup({ mergeRequests: [open(4, { draft: true }), open(5, { conflicts: true }), open(6, { pipeline: 'failed' }), { ...open(7), state: 'closed' }] });
    expect(await s.source.notComplete!(job())).toBe(`the issue ${s.gitlab.url}/ada/tools/-/issues/1 is open, and no merge request that closes it is ready for review or merged since the job began: !4 (opened, draft), !5 (opened, merge conflicts), !6 (opened, pipeline failed), !7 (closed)`);
    const none = await setup();
    expect(await none.source.notComplete!(job())).toBe(`the issue ${none.gitlab.url}/ada/tools/-/issues/1 is open, and no merge request in ada/tools closes it`);
  });

  it('is done with a merge request merged since the job began, not one merged before', async () => {
    const since = await setup({ mergeRequests: [{ ...open(4), state: 'merged', mergedAt: AFTER }] });
    expect(await since.source.notComplete!(job())).toBeUndefined();
    const before = await setup({ mergeRequests: [{ ...open(4, { createdAt: BEFORE }), state: 'merged', mergedAt: BEFORE }] });
    expect(await before.source.notComplete!(job())).toContain('!4 (merged)');
  });

  it('is done when a merged merge request closed the issue', async () => {
    const s = await setup({ issue: { state: 'closed' }, mergeRequests: [{ ...open(4, { createdAt: BEFORE }), state: 'merged', mergedAt: BEFORE }] });
    expect(await s.source.notComplete!(job())).toBeUndefined();
    const by = await setup({ issue: { state: 'closed' } });
    expect(await by.source.notComplete!(job())).toBe(`the issue ${by.gitlab.url}/ada/tools/-/issues/1 is closed, not by a merge request, and no merge request in ada/tools closes it`);
  });
});

describe('signals for a running GitLab job', () => {
  it('cancels a job whose issue closed by other work, lost the label, or is gone', async () => {
    const closed = await setup({ issue: { state: 'closed' }, mergeRequests: [{ ...open(4, { createdAt: BEFORE }), state: 'merged', mergedAt: BEFORE }] });
    expect(await closed.source.check([job()])).toEqual([{ kind: 'cancel', jobId: 'j1', reason: 'issue closed' }]);
    const unlabelled = await setup({ issue: { labels: ['hopper:claimed'] } });
    expect(await unlabelled.source.check([job()])).toEqual([{ kind: 'cancel', jobId: 'j1', reason: 'label removed' }]);
    const gone = await setup();
    expect(await gone.source.check([job({ iid: 77 })])).toEqual([{ kind: 'cancel', jobId: 'j1', reason: 'issue gone' }]);
  });

  it('lets a job whose own merge request closed the issue run on, and finishes one on its own wait', async () => {
    const s = await setup({ issue: { state: 'closed' }, mergeRequests: [{ ...open(4), state: 'merged', mergedAt: AFTER }] });
    expect(await s.source.check([job()])).toEqual([]);
    expect(await s.source.check([job({ status: 'waiting_on' })])).toEqual([{ kind: 'finish', jobId: 'j1', reason: 'issue closed as complete' }]);
  });

  it('cancels a waiting job unassigned, and flags a started one', async () => {
    const s = await setup({ issue: { assignees: ['bob'] } });
    expect(await s.source.check([job({ status: 'queued' })])).toEqual([{ kind: 'cancel', jobId: 'j1', reason: 'unassigned' }]);
    expect(await s.source.check([job()])).toEqual([{ kind: 'unassigned', jobId: 'j1' }]);
    expect(await s.source.check([job({ unassignedAt: BEGAN })])).toEqual([]);
    const again = await setup();
    expect(await again.source.check([job({ unassignedAt: BEGAN })])).toEqual([{ kind: 'reassigned', jobId: 'j1' }]);
  });

  it('cancels a waiting job on the backburner, and lets a running one finish', async () => {
    const s = await setup({ issue: { labels: ['hopper', 'hopper:backburner'] } });
    expect(await s.source.check([job({ status: 'held' })])).toEqual([{ kind: 'cancel', jobId: 'j1', reason: 'backburner' }]);
    expect(await s.source.check([job()])).toEqual([]);
  });

  it('reads no other source\'s job, no ended job, and nothing with no account', async () => {
    const s = await setup({ issue: { state: 'closed' } });
    expect(await s.source.check([job({ source: 'github' }), job({ status: 'finished' })])).toEqual([]);
    expect(s.gitlab.requests.filter((r) => r.path.includes('/issues/1'))).toEqual([]);
    const none = await setup({ connect: false });
    expect(await none.source.check([job()])).toEqual([]);
  });
});
