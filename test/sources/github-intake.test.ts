// Issue #440: every open labelled issue in a source's scope is taken, or not taken for one stated reason. A
// claim names its holder (`hopper:held-by:<id>`): the user's own claim with no job here is released and taken
// again; another hopper's claim is respected, and the user may release it. Labelled issues not assigned to the
// user can be assigned from the Sources view. The intake migration runs once per source: claims written before
// holders were recorded, with no job anywhere in this hopper, are released, and what it changed is listed.
import { describe, expect, it } from 'vitest';
import type { IntakeMigration } from '../../src/domain/intake.ts';
import { GitHubApiError, createFakeGitHub, createGitHubSource } from '../../src/sources/github/index.ts';
import type { GitHubSourceOptions } from '../../src/sources/github/index.ts';
import { REPO, githubConfig } from './fixtures/github-support.ts';

const HOLDER = 'a1b2c3d4e5f6';
const MINE = `hopper:held-by:${HOLDER}`;
const THEIRS = 'hopper:held-by:0f0f0f0f0f0f';
const url = (n: number, repo = REPO) => `https://github.com/${repo}/issues/${n}`;

function setup(o: { migration?: IntakeMigration; knownKeys?: (k: string[]) => Set<string>; othersKnown?: (k: string[]) => Set<string>; repos?: string[]; hopperName?: string } = {}) {
  const gh = createFakeGitHub();
  const events: { type: string; data: Record<string, unknown> }[] = [];
  let migration = o.migration;
  const config = githubConfig({ ...(o.repos ? { repos: o.repos } : {}), ...(o.hopperName ? { hopperName: o.hopperName } : {}) });
  const options: GitHubSourceOptions = {
    name: 'github', kind: 'github-account', mode: 'account', whoami: 'owner', assignee: () => 'owner', config, api: gh,
    clock: { now: () => new Date('2026-10-08T10:00:00.000Z') },
    knownKeys: o.knownKeys ?? (() => new Set()),
    intake: {
      holder: HOLDER,
      othersKnown: o.othersKnown ?? (() => new Set()),
      migration: () => migration,
      migrated: (m) => { migration = m; },
      record: (type, data) => { events.push({ type, data }); },
    },
  };
  const source = createGitHubSource(options);
  return { gh, source, events, migration: () => migration };
}
const migrated: IntakeMigration = { at: '2026-10-08T09:00:00.000Z', changes: [] };
const reasons = (source: ReturnType<typeof setup>['source']) => Object.fromEntries((source.intake?.() ?? []).map((o) => [o.key, o.reason ?? 'taken']));

describe('intake outcomes (issue #440)', () => {
  it('every open labelled issue in scope is taken or has one reason', async () => {
    const { gh, source } = setup({ migration: migrated, hopperName: 'home' });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:backburner'] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:failed'] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:done'] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:rejected'] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper@work'] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper@home'] });
    expect((await source.discover()).map((i) => i.number)).toEqual([1, 8]);
    expect(reasons(source)).toEqual({
      [url(1)]: 'taken',
      [url(2)]: 'not assigned to you',
      [url(3)]: 'on the backburner',
      [url(4)]: 'failed: hopper:failed is on the issue',
      [url(5)]: 'done, but the issue is still open',
      [url(6)]: 'rejected: hopper:rejected is on the issue',
      [url(7)]: 'addressed to another hopper',
      [url(8)]: 'taken',
    });
    expect(source.intake?.().find((o) => o.key === url(2))).toMatchObject({ action: 'assign', title: 'Issue 2', repo: REPO });
  });

  it('a rejected issue says so until it is assigned again', async () => {
    const { gh } = setup({ migration: migrated });
    const rejecting = createGitHubSource({
      name: 'github', kind: 'github-account', mode: 'account', whoami: 'owner', assignee: () => 'owner', config: githubConfig(), api: gh,
      clock: { now: () => new Date() }, rejections: (keys) => new Map(keys.map((k) => [k, { at: '2026-10-08T09:30:00.000Z', assignee: 'owner' }])),
    });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    expect(await rejecting.discover()).toEqual([]);
    expect(rejecting.intake?.()[0]?.reason).toBe('rejected by you: not taken until assigned to you again');
  });
});

describe('claims name their holder (issue #440)', () => {
  it('the claim report adds the holder label; the end removes it with the claim', async () => {
    const { gh, source } = setup({ migration: migrated });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const job = { id: 'j1', source: { source: 'github', key: url(1), repo: REPO, number: 1 } } as never;
    await source.report({ kind: 'claimed', job });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:claimed', MINE]);
    await source.report({ kind: 'finished', job });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-ready']);
  });

  it('the user\'s own claim with no job here is stale: released and taken again, with an event', async () => {
    const { gh, source, events } = setup({ migration: migrated });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed', MINE] });
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(reasons(source)).toEqual({ [url(1)]: 'taken' });
    expect(events).toEqual([{ type: 'source.claim_released', data: { source: 'github', key: url(1), by: 'hopper', reason: 'claimed by this user of this hopper, with no job here' } }]);
  });

  it('a claim with a job here is the job\'s: kept and taken', async () => {
    const { gh, source, events } = setup({ migration: migrated, knownKeys: (k) => new Set(k) });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed', MINE] });
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
    expect(gh.issue(REPO, 1).labels).toContain('hopper:claimed');
    expect(events).toEqual([]);
  });

  it('another hopper\'s claim is respected, and can be released by the user', async () => {
    const { gh, source, events } = setup({ migration: migrated });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed', THEIRS] });
    expect(await source.discover()).toEqual([]);
    expect(source.intake?.()[0]).toMatchObject({ reason: 'claimed by another hopper', action: 'release' });
    expect(gh.issue(REPO, 1).labels).toContain('hopper:claimed');
    expect(await source.intakeAction?.({ kind: 'release', keys: [url(1)] })).toEqual({ done: [url(1)], failed: {} });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(events).toEqual([{ type: 'source.claim_released', data: { source: 'github', key: url(1), by: 'user', reason: 'released in Sources' } }]);
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
  });

  it('a claim of another user of this hopper says so, and offers no release', async () => {
    const { gh, source } = setup({ migration: migrated, othersKnown: (k) => new Set(k) });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed', THEIRS] });
    expect(await source.discover()).toEqual([]);
    expect(source.intake?.()[0]).toEqual(expect.objectContaining({ reason: 'claimed by another user of this hopper' }));
    expect(source.intake?.()[0]?.action).toBeUndefined();
  });

  it('after the migration, a claim with no holder is another hopper\'s (an older one): kept, releasable', async () => {
    const { gh, source } = setup({ migration: migrated });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    expect(await source.discover()).toEqual([]);
    expect(source.intake?.()[0]).toMatchObject({ reason: 'claimed by another hopper (no holder recorded)', action: 'release' });
  });

  it('a release that fails is shown, and tried again on the next sync', async () => {
    const { gh, source } = setup({ migration: migrated });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed', MINE] });
    gh.failNext('removeLabels', new GitHubApiError('GitHub is down', false, 502));
    expect(await source.discover()).toEqual([]);
    expect(source.intake?.()[0]?.reason).toBe('claimed with no job here (stale); releasing it failed: GitHub is down');
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
  });
});

describe('assign to me (issue #440)', () => {
  it('assigns the chosen issues to the connected account, with an event; they are taken on the next sync', async () => {
    const { gh, source, events } = setup({ migration: migrated });
    gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    await source.discover();
    expect(await source.intakeAction?.({ kind: 'assign', keys: [url(1), url(2), url(9)] }))
      .toEqual({ done: [url(1), url(2)], failed: { [url(9)]: 'not in this source\'s scope' } });
    expect(gh.issue(REPO, 1).assignees).toEqual(['owner']);
    expect(events).toEqual([{ type: 'source.issues_assigned', data: { source: 'github', keys: [url(1), url(2)], assignee: 'owner' } }]);
    expect((await source.discover()).map((i) => i.number)).toEqual([1, 2]);
  });
});

describe('the intake migration (issue #440)', () => {
  it('releases claims with no holder and no job anywhere in this hopper, lists every change once, and is a no-op the second time', async () => {
    const { gh, source, events, migration } = setup({ othersKnown: (k) => new Set(k.filter((x) => x === url(3))) });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed', THEIRS] });
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(gh.issue(REPO, 3).labels).toContain('hopper:claimed');
    expect(gh.issue(REPO, 4).labels).toContain('hopper:claimed');
    const changes = [
      { key: url(1), change: 'released a claim with no holder recorded and no job in this hopper' },
      { key: url(2), change: 'not assigned to you: assign it to you to take it' },
    ];
    expect(migration()).toEqual({ at: '2026-10-08T10:00:00.000Z', changes });
    expect(events).toEqual([
      { type: 'source.claim_released', data: { source: 'github', key: url(1), by: 'migration', reason: 'claimed before claims named their holder, with no job in this hopper' } },
      { type: 'source.intake_migrated', data: { source: 'github', changes } },
    ]);
    expect(reasons(source)[url(3)]).toBe('claimed by another user of this hopper');
    events.length = 0;
    await source.discover();
    expect(events).toEqual([]);
    expect(migration()?.changes).toEqual(changes);
    expect(source.describe().intakeMigration).toEqual(migration());
  });

  it('waits for a sync that lists every repo', async () => {
    const { gh, source, migration } = setup({ repos: [REPO, 'owner/other'] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    gh.failNext('listOpenIssues', new GitHubApiError('GitHub is down', false, 502));
    await source.discover();
    expect(migration()).toBeUndefined();
    expect(gh.issue(REPO, 1).labels).toContain('hopper:claimed');
    await source.discover();
    expect(migration()?.changes.map((c) => c.key)).toEqual([url(1)]);
  });
});

describe('repos outside the job repositories (issue #440)', () => {
  it('lists repos the account can reach with open labelled issues for the user, never adding them', async () => {
    const { gh, source } = setup({ migration: migrated });
    gh.createIssue({ repo: 'owner/elsewhere', labels: ['hopper'] });
    gh.createIssue({ repo: 'owner/elsewhere', labels: ['hopper', 'hopper:done'] });
    gh.createIssue({ repo: 'owner/unassigned', assignees: [], labels: ['hopper'] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await source.discover();
    expect(source.describe().outsideRepos).toEqual([{ repo: 'owner/elsewhere', items: [url(1, 'owner/elsewhere')] }]);
  });
});

describe('the intake migration on an unassigned issue with a stale claim (issue #440)', () => {
  it('releases the claim though the issue is not assigned; it keeps its reason, and is taken once assigned', async () => {
    const { gh, source, migration } = setup();
    gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper', 'hopper:claimed'] });
    expect(await source.discover()).toEqual([]);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(reasons(source)).toEqual({ [url(1)]: 'not assigned to you' });
    expect(migration()?.changes).toEqual([
      { key: url(1), change: 'released a claim with no holder recorded and no job in this hopper' },
      { key: url(1), change: 'not assigned to you: assign it to you to take it' },
    ]);
    gh.assign(REPO, 1, 'owner');
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
  });
});
