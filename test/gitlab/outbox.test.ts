// A GitLab issue's label changes go through the outbox (issue #1892 part 17, design.md "GitLab's labels through the outbox"),
// as a GitHub issue's do (parts 14 and 15): the follow's end and the report's end are kept as rows of the source, and sent in
// their own pass. A write GitLab refuses for now fails neither: its rows wait their backoff, and a later flush sends them,
// after a restart too. An issue whose rows are not sent is not taken. Over a fake GitLab on loopback.
//
// Feature: a GitLab issue's label changes go through the outbox
//   Scenario: a merge GitLab's label write refuses for now is recorded, and a later flush puts hopper:done on
//   Scenario: a failed job's end kept before a restart is sent by the source after it
//   Scenario: an issue whose label change is not sent is not taken
//   Scenario: while GitLab refuses the token, the rows wait with no attempt counted
import { afterEach, describe, expect, it } from 'vitest';
import { createGitLabAccount } from '../../src/gitlab/account.ts';
import { createGitLabSource } from '../../src/gitlab/source.ts';
import { memoryGitHubOutbox } from '../../src/sources/github/outbox.ts';
import type { GitHubOutboxRepository } from '../../src/domain/github-outbox.ts';
import type { GitLabAccountRecord } from '../../src/domain/gitlab-account.ts';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitLab, type FakeGitLabIssue } from '../support/fake-gitlab.ts';
import { memoryAccountStore, systemOf } from '../support/system-secrets.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const AFTER = '2026-10-17T11:00:00Z';
const ISSUE: FakeGitLabIssue = { project: 'ada/tools', iid: 1, title: 'Fix the parser', description: 'x', author: 'ada', assignees: ['ada'], labels: ['hopper', 'hopper:claimed'] };

async function setup() {
  const gitlab = await createFakeGitLab({ issues: [{ ...ISSUE }] });
  cleanups.push(() => gitlab.close());
  gitlab.tokens.set('glpat-ada', { id: 7, username: 'ada', email: 'ada@example.com', projects: ['ada/tools'] });
  gitlab.mergeRequests.push({ project: 'ada/tools', iid: 4, closes: [1], state: 'merged', createdAt: AFTER, updatedAt: AFTER, mergedAt: AFTER });
  let kept: GitLabAccountRecord | undefined;
  let at = Date.parse('2026-10-17T12:00:00Z');
  const clock = { now: () => new Date(at) };
  const account = createGitLabAccount({
    settings: { getGitLabAccount: () => (kept ? structuredClone(kept) : undefined), setGitLabAccount: (r) => { kept = r ?? undefined; } },
    secrets: systemOf(memoryAccountStore().store), clock, logger: { info: () => undefined, warn: () => undefined },
  });
  await account.connect({ token: 'glpat-ada', baseUrl: gitlab.url });
  account.choose(['ada/tools']);
  const rows = memoryGitHubOutbox();
  const sourceOver = (outbox: GitHubOutboxRepository) => createGitLabSource({ name: 'gitlab-account', account, clock, outbox });
  const key = `${gitlab.url}/ada/tools/-/issues/1`;
  const job = (source: Record<string, unknown> = {}): Job => ({
    id: 'j1', status: 'finished', createdAt: '2026-10-17T10:00:00Z',
    source: { source: 'gitlab-account', kind: 'gitlab-account', key, url: key, title: 't', author: 'ada', assignee: 'ada', repo: 'ada/tools', number: 1, labels: [] },
    sourceState: { source },
  } as unknown as Job);
  return {
    gitlab, rows, account, key, job, source: sourceOver(rows), sourceOver, labels: () => gitlab.issues[0]!.labels,
    later: (ms: number) => { at += ms; },
  };
}

describe('a GitLab issue\'s label changes go through the outbox', () => {
  it('records a merge whose label write GitLab refuses for now, and a later flush puts hopper:done on', async () => {
    const s = await setup();
    s.gitlab.failingWrites.add('ada/tools');
    const url = `${s.gitlab.url}/ada/tools/-/merge_requests/4`;
    const up = await s.source.follow!(s.job({ pullRequest: url, follow: 'open' }), undefined, { keep: () => undefined });
    expect(up?.outcome).toBe('merged');
    expect(s.labels()).toEqual(['hopper', 'hopper:claimed']);
    expect(s.rows.open('gitlab-account').map((r) => [r.act, r.state, r.lastError !== undefined])).toEqual([['follow', 'pending', true], ['follow', 'pending', true]]);
    s.gitlab.failingWrites.delete('ada/tools');
    s.later(60_000);
    expect((await s.source.flushOutbox!()).due).toBe(2);
    expect(s.labels()).toEqual(['hopper', 'hopper:done']);
    expect(s.rows.open('gitlab-account')).toEqual([]);
  });

  it('sends a failed job\'s end, kept before a restart, from the source after it', async () => {
    const s = await setup();
    s.gitlab.failingWrites.add('ada/tools');
    await s.source.report({ kind: 'failed', job: s.job() } as never);
    expect(s.labels()).toEqual(['hopper', 'hopper:claimed']);
    s.source.releaseOutbox!();
    s.gitlab.failingWrites.delete('ada/tools');
    s.later(60_000);
    const after = s.sourceOver(s.rows);
    expect((await after.flushOutbox!()).due).toBeGreaterThan(0);
    expect(s.labels()).toEqual(['hopper', 'hopper:failed']);
  });

  it('does not take an issue whose label change is not sent', async () => {
    const s = await setup();
    s.gitlab.failingWrites.add('ada/tools');
    await s.source.report({ kind: 'failed', job: s.job() } as never);
    expect(await s.source.discover()).toEqual([]);
    expect(s.source.intake!().find((x) => x.key === s.key)?.reason).toMatch(/label change is on its way to GitLab/);
    s.gitlab.failingWrites.delete('ada/tools');
    s.later(60_000);
    await s.source.flushOutbox!();
    await s.source.discover();
    expect(s.source.intake!().find((x) => x.key === s.key)?.reason).toMatch(/labelled hopper:failed/);
  });

  it('keeps the rows waiting, with no attempt counted, while GitLab refuses the token', async () => {
    const s = await setup();
    s.gitlab.refused.add('glpat-ada');
    await s.source.report({ kind: 'failed', job: s.job() } as never).catch(() => undefined);
    expect(s.account.status().state).toBe('expired');
    await s.source.flushOutbox!();
    expect(s.rows.open('gitlab-account').map((r) => [r.state, r.attempts])).toEqual([['pending', 0], ['pending', 0]]);
  });
});
