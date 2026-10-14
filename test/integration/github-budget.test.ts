// The GitHub budget (issue #985 part 4, design.md "The in-motion cycle"): at 60 job repositories, intake, reconciling and
// the in-motion cycle make fewer than 50 calls to GitHub in one hour at the default settings. The real app source over the
// App adapter, the real sync loop on fake timers, against the node:http fake GitHub, whose own request log is the count.
// Ten jobs follow pull requests: two with checks that run, then pass; one ready while yolo mode merges it; one a person
// merges on GitHub and one a person closes; five idle.
//
// Feature: a handful of batched calls an hour
//   Scenario: one hour at 60 repositories and ten followed pull requests
//     Then intake, reconcile and the in-motion cycle make fewer than 50 calls
//     And a merged or closed pull request is read no more after the round that saw it end
//     And an idle pull request is read only inside the batched reads
//     And the hopper's own count by kind is what the fake GitHub saw
//     And each repository's change read (issue #1125) is charged only when its answer changed: once for each token, else a 304
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import type { ConnectedAccountTokens } from '../../src/domain/ports.ts';
import { DEFAULT_RATE_LIMITER } from '../../src/domain/github-rate-limit.ts';
import { githubTraffic } from '../../src/github-limiter/traffic.ts';
import githubApp from '../../src/plugins/job-source/github-app/index.ts';
import { parseOptions } from '../../src/plugins/options.ts';
import { createAppSource } from '../../src/sources/compose.ts';
import type { GitHubAppOptions } from '../../src/sources/config.ts';
import { createFakeGitHubServer, endPull, type FakeGitHubServer } from '../../src/sources/github/app/index.ts';
import type { FakeIssueInput, FakeRequestRecord } from '../../src/sources/github/app/fake-state.ts';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createWorld } from '../sources/sync-support.ts';
import { testTrust } from '../sources/fixtures/github-support.ts';
import { APP_ID, KEYS, SLUG } from '../support/github-app.ts';

const MIN = 60_000;
const START = Date.parse('2026-10-13T10:00:00.000Z');
const OWNER = 'owner';
const REPOS = Array.from({ length: 60 }, (_, i) => `repo-${String(i).padStart(2, '0')}`);
const KEY_ENV = 'GITHUB_APP_PRIVATE_KEY';

type Role = 'checks' | 'yolo' | 'merged' | 'closed' | 'idle';
const ROLES: Role[] = ['checks', 'checks', 'yolo', 'merged', 'closed', 'idle', 'idle', 'idle', 'idle', 'idle'];

let fake: FakeGitHubServer | undefined;
let sync: ReturnType<typeof createSourceSync> | undefined;
afterEach(async () => {
  await sync?.stop();
  vi.useRealTimers();
  await fake?.close();
  fake = sync = undefined;
});

const pullUrl = (repo: string, n: number) => `https://github.com/${OWNER}/${repo}/pull/${n}`;
const issueUrl = (repo: string, n: number) => `https://github.com/${OWNER}/${repo}/issues/${n}`;

/** Job repository `repo` with issue 1 (the job's, labelled, assigned) and its pull request 2 ("Closes #1"); another issue unlabelled. */
function jobRepo(repo: string, role: Role): FakeIssueInput[] {
  const opened = new Date(START - 60 * MIN).toISOString();
  const pr = { url: pullUrl(repo, 2), createdAt: opened, isDraft: false, mergeable: 'MERGEABLE', headCommittedAt: opened };
  return [
    { number: 1, title: 'Do the thing', body: 'Please do the thing.', labels: ['hopper', 'hopper:pr-ready'], assignees: [OWNER], openPullRequests: [pr], mentionedBy: [{ ...pr, state: 'OPEN', body: 'Closes #1', repo: `${OWNER}/${repo}` }] },
    { number: 2, title: 'Do the thing', body: 'Closes #1', pullRequest: true, labels: [], assignees: [], pull: { headRef: 'issue-1', headOid: 'aaa', base: 'dev', mergeable: 'MERGEABLE', checks: role === 'checks' ? 'PENDING' : 'SUCCESS', createdAt: opened, committedAt: opened } },
    { number: 3, title: 'Not for the hopper', body: 'Later.', labels: [], assignees: [] },
  ];
}

/** A finished job whose end was reported, following pull request 2 of `repo`. */
function followingJob(id: string, repo: string): Job {
  const at = new Date(START - 30 * MIN).toISOString();
  return {
    id, spec: { executor: 'test', payload: {} }, priority: 50, approved: true, attempts: 1, status: 'finished', createdAt: at, updatedAt: at, finishedAt: at,
    source: { source: 'github-app', kind: 'github-app', key: issueUrl(repo, 1), url: issueUrl(repo, 1), title: 'Do the thing', repo: `${OWNER}/${repo}`, number: 1, assignee: OWNER, origin: 'trusted' },
    sourceState: { sync: { claimReported: true, finalReported: true }, source: { pullRequest: pullUrl(repo, 2), follow: 'open', mergeChecked: true } },
  } as unknown as Job;
}

/**
 * What a request of the fake asked: the in-motion cycle's or reconcile's batch, a listing, the installed repositories, or
 * else. The installation token is minted by the read that first needs it, here the first sync's installed repositories:
 * intake.
 */
function kindOf(r: FakeRequestRecord): 'intake' | 'reconcile' | 'pr_cycle' | 'other' {
  if (isChangeRead(r)) return 'intake';
  const query = String((r.body as { query?: string } | undefined)?.query ?? '');
  if (r.path === '/graphql' && /r0: repository\(owner/.test(query)) return 'intake';
  if (r.path === '/graphql' && /u0: repository\(owner/.test(query)) return 'reconcile';
  if (r.path === '/graphql' && /p0: repository\(owner/.test(query)) return 'pr_cycle';
  if (r.path === '/installation/repositories' || r.path === '/app/installations' || r.path === '/issues' || /^\/app\/installations\/\d+\/access_tokens$/.test(r.path)) return 'intake';
  return 'other';
}

/** A repository's change read (issue #1125): its issue list since a time, a conditional request. */
const isChangeRead = (r: FakeRequestRecord): boolean => /^\/repos\/[^/]+\/[^/]+\/issues$/.test(r.path) && r.query.state === 'all';

/** The repository a request reads one item of; undefined for a batched read, a listing or none. */
function itemRepoOf(r: FakeRequestRecord): string | undefined {
  if (kindOf(r) !== 'other') return undefined;
  const rest = /^\/repos\/[^/]+\/([^/]+)\//.exec(r.path)?.[1];
  if (rest) return rest;
  const v = (r.body as { variables?: Record<string, unknown> } | undefined)?.variables ?? {};
  return typeof v.name === 'string' ? v.name : Object.entries(v).find(([k]) => /^n\d+$/.test(k))?.[1] as string | undefined;
}

describe('the GitHub budget at 60 repositories (issue #985)', () => {
  it('one hour: intake, reconcile and the in-motion cycle make fewer than 50 calls; ended and idle pull requests are not read one by one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(START);
    const jobRepos = new Map(ROLES.map((role, i) => [REPOS[i]!, role]));
    fake = await createFakeGitHubServer({
      appId: APP_ID, publicKeyPem: KEYS.publicKey, slug: SLUG,
      installations: [{ id: 7, account: OWNER, repos: REPOS.map((name) => ({ owner: OWNER, name, labels: ['hopper'], issues: jobRepos.has(name) ? jobRepo(name, jobRepos.get(name)!) : [] })) }],
    });
    const world = createWorld();
    const clock = { now: () => new Date() };
    ROLES.forEach((_, i) => world.jobs.set(`job-${i}`, followingJob(`job-${i}`, REPOS[i]!)));
    const parsed = parseOptions(githubApp, { appId: APP_ID, slug: SLUG, privateKeyEnv: KEY_ENV, apiUrl: fake.url, executor: 'test' });
    if (!parsed.ok) throw new Error(parsed.error);
    const keys = new Set([...world.jobs.values()].map((j) => j.source!.key));
    const source = createAppSource({
      name: 'github-app', clock, env: (name) => (name === KEY_ENV ? KEYS.privateKey : undefined), trust: testTrust(),
      knownKeys: (ks) => new Set(ks.filter((k) => keys.has(k))), rerunnable: () => new Set(),
      accounts: { account: () => OWNER } as unknown as ConnectedAccountTokens,
      yoloMode: (repo) => repo === `${OWNER}/${REPOS[2]}`,
    }, parsed.options as unknown as GitHubAppOptions);
    const s = DEFAULT_RATE_LIMITER;
    sync = createSourceSync({ sources: [source], host: world.host, clock, pollMs: () => MIN, followEvery: () => ({ cycleMs: s.prCycleMinutes * MIN, allMs: s.intakeSyncMinutes * MIN }) });

    /** Until the sync is idle: no sync runs and the fake saw no request for a while. */
    const idle = async () => {
      let quiet = 0;
      let seen = fake!.state.requests.length;
      while (quiet < 40) {
        await new Promise((r) => setImmediate(r));
        const now = fake!.state.requests.length;
        quiet = now === seen && !sync!.statuses()[0]?.syncing ? quiet + 1 : 0;
        seen = now;
      }
    };
    const minute = async () => { vi.advanceTimersByTime(MIN); await idle(); vi.advanceTimersByTime(0); await idle(); };
    const hourBefore = githubTraffic.hourly();
    const repoOf = (role: Role) => fake!.state.repos.get(`${OWNER}/${REPOS[ROLES.indexOf(role)]}`)!;

    sync.start();
    await idle();
    expect(sync.statuses()[0]).toMatchObject({ state: 'ok' });
    const ended: Record<string, number> = {};
    for (let m = 1; m < 60; m++) {
      if (m === 5) {
        endPull(repoOf('merged'), 2, 'MERGED', new Date().toISOString());
        endPull(repoOf('closed'), 2, 'CLOSED', new Date().toISOString());
      }
      // The checks pass.
      if (m === 8) for (const [i, role] of ROLES.entries()) if (role === 'checks') fake.state.repos.get(`${OWNER}/${REPOS[i]}`)!.issues.get(2)!.pull!.checks = 'SUCCESS';
      await minute();
      for (const role of ['merged', 'closed', 'yolo'] as const) {
        const job = world.jobs.get(`job-${ROLES.indexOf(role)}`)!;
        if (ended[role] === undefined && (job.sourceState?.source as { follow?: string }).follow !== 'open') ended[role] = fake.state.requests.length;
      }
    }

    // What GitHub charges: every request but a 304 (issue #1125).
    const requests = fake.state.requests.filter((r) => !r.notModified);
    const sync_ = requests.filter((r) => kindOf(r) !== 'other' && !isChangeRead(r));
    // Each pull request ended, and was seen to end.
    expect(Object.keys(ended).sort()).toEqual(['closed', 'merged', 'yolo']);
    expect(repoOf('yolo').issues.get(2)!.pull!.state).toBe('MERGED');
    // Intake, reconcile and the in-motion cycle: fewer than 50 calls in the hour. The cycle ran while checks ran: more
    // batched reads than the four rounds of every pull request.
    expect(sync_.length).toBeLessThan(50);
    expect(sync_.filter((r) => kindOf(r) === 'pr_cycle').length).toBeGreaterThan(4);
    // An ended pull request: no read of its own after the round that saw it end.
    for (const role of ['merged', 'closed', 'yolo'] as const) {
      const repo = REPOS[ROLES.indexOf(role)];
      expect(requests.slice(ended[role]).filter((r) => itemRepoOf(r) === repo), role).toEqual([]);
    }
    // An idle pull request: no read of its own after the first round, only the batched reads.
    const firstRound = requests.findIndex((r, i) => i > 0 && kindOf(r) === 'pr_cycle' && requests.slice(0, i).some((x) => kindOf(x) === 'pr_cycle'));
    for (const [i, role] of ROLES.entries()) {
      if (role !== 'idle') continue;
      expect(requests.slice(firstRound).filter((r) => itemRepoOf(r) === REPOS[i]), REPOS[i]).toEqual([]);
    }
    // The hopper's own count: every call the fake saw (it answers no 304), each of the sync's under its kind.
    const hour = githubTraffic.hourly();
    const counted = (k: keyof typeof hour) => hour[k].calls - hourBefore[k].calls;
    expect(Object.keys(hour).reduce((n, k) => n + counted(k as keyof typeof hour), 0)).toBe(requests.length);
    const changeReads = requests.filter(isChangeRead);
    expect(counted('intake') + counted('reconcile') + counted('pr_cycle')).toBe(sync_.length + changeReads.length);
    // Each repository's change read: one a minute, all a 304 but the first, as nothing on GitHub changed an issue.
    const made = fake.state.requests.filter(isChangeRead);
    expect(made.length).toBeGreaterThan(50 * REPOS.length);
    // Charged once for each installation token (the ETag cache is per credential, a token lasts an hour), and again only
    // where an issue changed: the merged and the closed pull requests' repositories.
    const tokens = fake.state.requests.filter((r) => /^\/app\/installations\/\d+\/access_tokens$/.test(r.path)).length;
    const changedRepos = new Set(['merged', 'closed'].map((role) => `/repos/${OWNER}/${REPOS[ROLES.indexOf(role as Role)]}/issues`));
    expect(changeReads.filter((r) => !changedRepos.has(r.path))).toHaveLength((REPOS.length - changedRepos.size) * tokens);
    expect(changeReads.length).toBeLessThan(REPOS.length * tokens + 10);
  });
});
