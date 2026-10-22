// A GitLab issue's end labels come from its item's state (issue #1892 part 16, design.md "GitLab's labels from the ledger"),
// as a GitHub issue's do (parts 14 and 15): the follow's end and the report's end name the state they move the item to, and
// `labelsFor` names its end label. Every end label that state does not want comes off, from the issue's labels as just read,
// with the ended job's claim; a write that changes nothing is not sent. Over a fake GitLab on loopback.
//
// Feature: a GitLab issue's end labels come from its item's state
//   Scenario: a merge takes off every end label but hopper:done, and the claim
//   Scenario: a close without a merge takes off every end label but hopper:pr-closed
//   Scenario: a merge on an issue that carries what the state wants sends no label write
//   Scenario: a done job's end takes off an end label its state does not want
//   Scenario: a failed job's end puts hopper:failed on and takes the claim off; a fixing one changes nothing
//   Scenario: a cancelled job's end takes only the claim off
import { afterEach, describe, expect, it } from 'vitest';
import { createGitLabAccount } from '../../src/gitlab/account.ts';
import { createGitLabSource } from '../../src/gitlab/source.ts';
import type { GitLabAccountRecord } from '../../src/domain/gitlab-account.ts';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitLab, type FakeGitLabIssue, type FakeGitLabMergeRequest } from '../support/fake-gitlab.ts';
import { memoryAccountStore, systemOf } from '../support/system-secrets.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const AFTER = '2026-10-17T11:00:00Z';
const ISSUE: FakeGitLabIssue = { project: 'ada/tools', iid: 1, title: 'Fix the parser', description: 'x', author: 'ada', assignees: ['ada'], labels: ['hopper'] };

async function setup(o: { labels: string[]; issue?: Partial<FakeGitLabIssue>; mergeRequest?: Partial<FakeGitLabMergeRequest> }) {
  const gitlab = await createFakeGitLab({ issues: [{ ...ISSUE, labels: o.labels, ...o.issue }] });
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
  const source = createGitLabSource({ name: 'gitlab-account', account });
  const url = `${gitlab.url}/ada/tools/-/merge_requests/4`;
  const labelWrites = () => gitlab.requests.filter((r) => r.method === 'PUT' && r.path === '/api/v4/projects/ada%2Ftools/issues/1');
  return { gitlab, source, url, labels: () => gitlab.issues[0]!.labels, labelWrites };
}

const job = (source: Record<string, unknown> = {}): Job => ({
  id: 'j1', status: 'finished', createdAt: '2026-10-17T10:00:00Z',
  source: { source: 'gitlab-account', kind: 'gitlab-account', key: 'https://gitlab.test/ada/tools/-/issues/1', url: 'u', title: 't', author: 'ada', assignee: 'ada', repo: 'ada/tools', number: 1, labels: [] },
  sourceState: { source },
} as unknown as Job);

const follow = (s: Awaited<ReturnType<typeof setup>>) => s.source.follow!(job({ pullRequest: s.url, follow: 'open' }), undefined, { keep: () => undefined });

describe('a GitLab issue\'s end labels come from its item\'s state', () => {
  it('takes off every end label but hopper:done, and the claim, at a merge', async () => {
    const s = await setup({ labels: ['hopper', 'hopper:claimed', 'hopper:pr-ready', 'hopper:blocked', 'hopper:partly-done'], mergeRequest: { state: 'merged', mergedAt: AFTER } });
    expect((await follow(s))?.outcome).toBe('merged');
    expect(s.labels()).toEqual(['hopper', 'hopper:done']);
  });

  it('takes off every end label but hopper:pr-closed at a close without a merge', async () => {
    const s = await setup({ labels: ['hopper', 'hopper:pr-ready', 'hopper:failed'], mergeRequest: { state: 'closed' } });
    expect((await follow(s))?.outcome).toBe('closed');
    expect(s.labels()).toEqual(['hopper', 'hopper:pr-closed']);
  });

  it('sends no label write at a merge when the issue carries what the state wants', async () => {
    const s = await setup({ labels: ['hopper', 'hopper:done'], mergeRequest: { state: 'merged', mergedAt: AFTER } });
    expect((await follow(s))?.outcome).toBe('merged');
    expect(s.labelWrites()).toEqual([]);
  });

  it('takes off an end label a done job\'s state does not want', async () => {
    const s = await setup({ labels: ['hopper', 'hopper:claimed', 'hopper:pr-closed'] });
    await s.source.report({ kind: 'finished', job: job() });
    expect(s.labels()).toEqual(['hopper', 'hopper:pr-ready']);
  });

  it('puts hopper:failed on a failed job\'s issue and takes the claim off; a job the hopper fixes changes nothing', async () => {
    const s = await setup({ labels: ['hopper', 'hopper:claimed'] });
    await s.source.report({ kind: 'failed', job: job(), fixing: true } as never);
    expect(s.labelWrites()).toEqual([]);
    await s.source.report({ kind: 'failed', job: job() } as never);
    expect(s.labels()).toEqual(['hopper', 'hopper:failed']);
  });

  it('takes only the claim off at a cancelled job\'s end', async () => {
    const s = await setup({ labels: ['hopper', 'hopper:claimed'] });
    await s.source.report({ kind: 'cancelled', job: job() } as never);
    expect(s.labels()).toEqual(['hopper']);
  });
});
