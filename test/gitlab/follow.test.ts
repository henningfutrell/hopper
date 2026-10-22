// A GitLab job's merge request followed (issue #1642 part 2, design.md "A GitLab job's merge request"): the report keeps the
// job's ready merge request to follow and labels the issue `hopper:pr-ready`; each follow reads it — its draft, its merge
// conflicts, its head pipeline — and, with yolo mode on for its project, the hopper merges it once ready, at the head it read.
// Merged, the issue is `hopper:done`; closed without a merge, `hopper:pr-closed`. Over a fake GitLab on loopback.
//
// Feature: a GitLab job's merge request followed
//   Scenario: a done job's report keeps its ready merge request to follow, and labels the issue hopper:pr-ready
//   Scenario: a done job whose issue is closed already is hopper:done, and follows nothing
//   Scenario: a follow keeps what it sees of the open merge request, and answers nothing while that does not change
//   Scenario: with yolo mode on, a ready merge request whose pipeline passed is merged at its head, the merge marker kept first
//   Scenario: a draft, merge conflicts, a failed or a running pipeline, or yolo mode off: not merged
//   Scenario: no pipeline: merged only after the grace window since its last change
//   Scenario: GitLab refusing the merge is kept on what is seen, and asked again at the next follow
//   Scenario: merged or closed by a person on GitLab: recorded, hopper:done or hopper:pr-closed
//   Scenario: merged after a stop with the merge marker on it: the hopper's merge
//   Scenario: yolo mode is asked for the project by its GitLab URL, never by its path alone
//   Scenario: an issue labelled hopper:pr-ready or hopper:pr-closed is not taken again
//   Scenario: a person's Merge now or Close PR is not taken on GitLab yet
import { afterEach, describe, expect, it } from 'vitest';
import { createGitLabAccount } from '../../src/gitlab/account.ts';
import { createGitLabSource } from '../../src/gitlab/source.ts';
import type { GitLabAccountRecord } from '../../src/domain/gitlab-account.ts';
import { SourceError } from '../../src/domain/ports.ts';
import { DEFAULT_YOLO_MODE, pullRequestList, type Job } from '../../src/domain/types.ts';
import { createFakeGitLab, type FakeGitLabIssue, type FakeGitLabMergeRequest } from '../support/fake-gitlab.ts';
import { memoryAccountStore, systemOf } from '../support/system-secrets.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const BEGAN = '2026-10-17T10:00:00Z';
const AFTER = '2026-10-17T11:00:00Z';

const ISSUE: FakeGitLabIssue = { project: 'ada/tools', iid: 1, title: 'Fix the parser', description: 'x', author: 'ada', assignees: ['ada'], labels: ['hopper', 'hopper:claimed'] };

async function setup(o: { issue?: Partial<FakeGitLabIssue>; mergeRequest?: Partial<FakeGitLabMergeRequest>; yolo?: boolean } = {}) {
  const gitlab = await createFakeGitLab({ issues: [{ ...ISSUE, ...o.issue }] });
  cleanups.push(() => gitlab.close());
  gitlab.tokens.set('glpat-ada', { id: 7, username: 'ada', email: 'ada@example.com', projects: ['ada/tools'] });
  gitlab.mergeRequests.push({ project: 'ada/tools', iid: 4, closes: [1], state: 'opened', createdAt: AFTER, updatedAt: AFTER, pipeline: 'running', ...o.mergeRequest });
  let kept: GitLabAccountRecord | undefined;
  const account = createGitLabAccount({
    settings: { getGitLabAccount: () => (kept ? structuredClone(kept) : undefined), setGitLabAccount: (r) => { kept = r ?? undefined; } },
    secrets: systemOf(memoryAccountStore().store), clock: { now: () => new Date() }, logger: { info: () => undefined, warn: () => undefined },
  });
  await account.connect({ token: 'glpat-ada', baseUrl: gitlab.url });
  account.choose(['ada/tools']);
  const yoloAsked: string[] = [];
  const source = createGitLabSource({ name: 'gitlab-account', account, yoloMode: (project) => { yoloAsked.push(project); return o.yolo ?? false; } });
  const mr = () => gitlab.mergeRequests[0]!;
  const issue = () => gitlab.issues[0]!;
  const url = `${gitlab.url}/ada/tools/-/merge_requests/4`;
  return { gitlab, source, mr, issue, url, yoloAsked };
}

const job = (source: Record<string, unknown> = {}): Job => ({
  id: 'j1', status: 'finished', createdAt: BEGAN,
  source: { source: 'gitlab-account', kind: 'gitlab-account', key: 'https://gitlab.test/ada/tools/-/issues/1', url: 'u', title: 't', author: 'ada', assignee: 'ada', repo: 'ada/tools', number: 1, labels: [] },
  sourceState: { source },
} as unknown as Job);

/** The job after its report and each follow: its source state as the sync loop keeps it. */
async function reported(s: Awaited<ReturnType<typeof setup>>): Promise<Job> {
  return job(await s.source.report({ kind: 'finished', job: job() }));
}

const merges = (s: Awaited<ReturnType<typeof setup>>) => s.gitlab.requests.filter((r) => r.method === 'PUT' && r.path.endsWith('/merge'));

describe('a GitLab job\'s merge request followed', () => {
  it('keeps the done job\'s ready merge request to follow, and labels the issue hopper:pr-ready', async () => {
    const s = await setup();
    const j = await reported(s);
    expect(j.sourceState?.source).toEqual({ reported: 'finished', pullRequest: s.url, follow: 'open' });
    expect(s.issue().labels).toEqual(['hopper', 'hopper:pr-ready']);
  });

  it('labels a done job whose issue is closed already hopper:done, and follows nothing', async () => {
    const s = await setup({ issue: { state: 'closed' }, mergeRequest: { state: 'merged', mergedAt: AFTER } });
    const j = await reported(s);
    expect(j.sourceState?.source).toEqual({ reported: 'finished' });
    expect(s.issue().labels).toEqual(['hopper', 'hopper:done']);
  });

  it('keeps what it sees of the open merge request, and answers nothing while that does not change', async () => {
    const s = await setup();
    const j = await reported(s);
    const first = await s.source.follow!(j, undefined, { keep: () => undefined });
    expect(first).toEqual({
      outcome: 'open', pullRequest: s.url, part: false,
      state: { reported: 'finished', pullRequest: s.url, follow: 'open', seen: { draft: false, conflicting: false, checks: 'pending', openedAt: AFTER, pushedAt: AFTER, base: 'main', headRef: 'issue-1' } },
    });
    expect(await s.source.follow!(job(first!.state), undefined, { keep: () => undefined })).toBeUndefined();
    expect(merges(s)).toEqual([]);
    // The Pull requests list names it by its number.
    const followed = job(first!.state);
    const list = pullRequestList([followed], () => followed, DEFAULT_YOLO_MODE, [], Date.now(), () => undefined);
    expect(list.repos[0]?.pullRequests[0]?.pullRequest).toEqual({ number: 4, url: s.url });
  });

  it('merges a ready merge request whose pipeline passed, with yolo mode on, at its head, the merge marker kept first', async () => {
    const s = await setup({ yolo: true, mergeRequest: { pipeline: 'success', sha: 'f00d' } });
    const j = await reported(s);
    const kept: Record<string, unknown>[] = [];
    const r = await s.source.follow!(j, undefined, { keep: (state) => { kept.push(state); } });
    expect(kept).toEqual([{ reported: 'finished', pullRequest: s.url, follow: 'open', merging: { pullRequest: s.url, head: 'f00d', byHopper: true } }]);
    expect(merges(s)).toEqual([expect.objectContaining({ path: '/api/v4/projects/ada%2Ftools/merge_requests/4/merge', body: { sha: 'f00d' } })]);
    expect(r).toEqual({ outcome: 'merged', pullRequest: s.url, byHopper: true, part: false, state: { reported: 'finished', pullRequest: s.url, follow: 'merged', mergeChecked: true } });
    expect(s.issue().labels).toEqual(['hopper', 'hopper:done']);
    expect(s.yoloAsked).toContain(`${s.gitlab.url}/ada/tools`);
  });

  it.each([
    ['a draft', { pipeline: 'success', draft: true }, true],
    ['merge conflicts', { pipeline: 'success', conflicts: true }, true],
    ['a failed pipeline', { pipeline: 'failed' }, true],
    ['a running pipeline', { pipeline: 'running' }, true],
    ['yolo mode off', { pipeline: 'success' }, false],
  ] as const)('does not merge one with %s', async (_what, mergeRequest, yolo) => {
    const s = await setup({ yolo, mergeRequest });
    const r = await s.source.follow!(job({ pullRequest: s.url, follow: 'open' }), undefined, { keep: () => undefined });
    expect(r?.outcome).toBe('open');
    expect(merges(s)).toEqual([]);
  });

  it('keeps a failed pipeline as failing checks, which a tend reads', async () => {
    const s = await setup({ mergeRequest: { pipeline: 'failed' } });
    const r = await s.source.follow!(job({ pullRequest: s.url, follow: 'open' }), undefined, { keep: () => undefined });
    expect(r?.state.seen).toMatchObject({ checks: 'failing' });
  });

  it('merges one with no pipeline only after the grace window since its last change', async () => {
    const recent = await setup({ yolo: true, mergeRequest: { pipeline: undefined, updatedAt: new Date().toISOString() } });
    const waits = await recent.source.follow!(job({ pullRequest: recent.url, follow: 'open' }), undefined, { keep: () => undefined });
    expect(waits?.state.seen).toMatchObject({ checks: 'none' });
    expect(merges(recent)).toEqual([]);
    const settled = await setup({ yolo: true, mergeRequest: { pipeline: undefined, updatedAt: AFTER } });
    expect((await settled.source.follow!(job({ pullRequest: settled.url, follow: 'open' }), undefined, { keep: () => undefined }))?.outcome).toBe('merged');
  });

  it('keeps GitLab\'s refusal of the merge on what is seen, and asks again at the next follow', async () => {
    const s = await setup({ yolo: true, mergeRequest: { pipeline: 'success', mergeRefusal: 405 } });
    const r = await s.source.follow!(job({ pullRequest: s.url, follow: 'open' }), undefined, { keep: () => undefined });
    expect(r).toMatchObject({ outcome: 'open', state: { follow: 'open', seen: { mergeError: expect.stringContaining('405') } } });
    expect(r!.state).not.toHaveProperty('merging');
    s.mr().mergeRefusal = undefined;
    expect((await s.source.follow!(job(r!.state), undefined, { keep: () => undefined }))?.outcome).toBe('merged');
  });

  it('records a merge or a close a person made on GitLab', async () => {
    const merged = await setup({ issue: { labels: ['hopper', 'hopper:pr-ready'] }, mergeRequest: { state: 'merged', mergedAt: AFTER } });
    expect(await merged.source.follow!(job({ pullRequest: merged.url, follow: 'open' }), undefined, { keep: () => undefined }))
      .toEqual({ outcome: 'merged', pullRequest: merged.url, part: false, state: { pullRequest: merged.url, follow: 'merged', mergeChecked: true } });
    expect(merged.issue().labels).toEqual(['hopper', 'hopper:done']);
    const closed = await setup({ issue: { labels: ['hopper', 'hopper:pr-ready'] }, mergeRequest: { state: 'closed' } });
    expect(await closed.source.follow!(job({ pullRequest: closed.url, follow: 'open' }), undefined, { keep: () => undefined }))
      .toEqual({ outcome: 'closed', pullRequest: closed.url, part: false, state: { pullRequest: closed.url, follow: 'closed' } });
    expect(closed.issue().labels).toEqual(['hopper', 'hopper:pr-closed']);
  });

  it('records a merge read after a stop, with the merge marker on it, as the hopper\'s', async () => {
    const s = await setup({ mergeRequest: { state: 'merged', mergedAt: AFTER, sha: 'f00d' } });
    const r = await s.source.follow!(job({ pullRequest: s.url, follow: 'open', merging: { pullRequest: s.url, head: 'f00d', byHopper: true } }), undefined, { keep: () => undefined });
    expect(r).toMatchObject({ outcome: 'merged', byHopper: true, state: { follow: 'merged', mergeChecked: true } });
    expect(r!.state).not.toHaveProperty('merging');
  });

  it('checks a merge recorded before once, and answers nothing after', async () => {
    const s = await setup({ mergeRequest: { state: 'merged', mergedAt: AFTER } });
    const r = await s.source.follow!(job({ pullRequest: s.url, follow: 'merged' }), undefined, { keep: () => undefined });
    expect(r).toEqual({ outcome: 'checked', pullRequest: s.url, part: false, state: { pullRequest: s.url, follow: 'merged', mergeChecked: true } });
  });

  it('asks yolo mode for the project by its GitLab URL', async () => {
    const s = await setup({ yolo: true });
    expect(s.source.mergesOnReady!('ada/tools')).toBe(true);
    expect(s.yoloAsked).toEqual([`${s.gitlab.url}/ada/tools`]);
  });

  it('does not take an issue labelled hopper:pr-ready or hopper:pr-closed again', async () => {
    const s = await setup({ issue: { labels: ['hopper', 'hopper:pr-ready'] } });
    s.gitlab.issues.push({ ...ISSUE, iid: 2, labels: ['hopper', 'hopper:pr-closed'] });
    expect(await s.source.discover()).toEqual([]);
    expect(s.source.intake!().map((x) => x.reason)).toEqual([
      'labelled hopper:pr-ready: remove the label at GitLab to offer it again', 'labelled hopper:pr-closed: remove the label at GitLab to offer it again',
    ]);
  });

  it('does not take a person\'s Merge now or Close PR on GitLab yet', async () => {
    const s = await setup();
    await expect(s.source.follow!(job({ pullRequest: s.url, follow: 'open' }), 'merge', { keep: () => undefined })).rejects.toBeInstanceOf(SourceError);
    expect(merges(s)).toEqual([]);
  });
});
