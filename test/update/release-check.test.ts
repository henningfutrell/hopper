// The release check (issue #652, requirement 9): an update goes only to a commit that is the merge of a pull request
// whose checks passed. Asked of GitHub's REST API, here a fake on loopback; "no checks" is not passing, and a commit
// GitHub cannot be asked about is not offered. Issue #822: every ask carries a connected account's token, never none,
// and GitHub's rate limit holds the commit until GitHub's reset time, with that time in the reason. Issue #913: "not the
// merge of a pull request" is never settled (GitHub's commit-to-pull-request answer lags a merge, and can name a later
// pull request that holds the commit, as a promotion), and a "Merge pull request #N" commit is checked against pull N.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitHubLimiter } from '../../src/github-limiter/limiter.ts';
import { createReleaseCheck, releaseAccount } from '../../src/update/release-check.ts';
import type { ConnectedAccountTokens } from '../../src/domain/ports.ts';
import { send } from '../support/fake-http.ts';

const MERGE = 'm'.repeat(40);
const HEAD = 'h'.repeat(40);
const REPO = 'https://github.com/o/r.git';

interface Run { name: string; status: string; conclusion: string | null }

const TOKEN = 'account-token';

/**
 * A fake GitHub: the pull requests of each commit, the check runs of each commit; each request counted with the
 * authorization it carried. It refuses a request with no token, as github.com counts it against the asker's address.
 * `limited`: until that time (epoch seconds) it refuses every request for the rate, with GitHub's headers.
 */
function fakeGitHub(o: { pulls?: Record<string, unknown[]>; runs?: Record<string, Run[]>; commits?: Record<string, { message: string; parents: number }>; byNumber?: Record<number, unknown>; down?: boolean; tokens?: string[]; limited?: { until: number; now: () => number } }) {
  const asked: string[] = [];
  const auth: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    asked.push(path);
    auth.push(req.headers.authorization);
    if (o.down) return send(res, 503, { message: 'unavailable' });
    if (!(o.tokens ?? [TOKEN]).some((t) => req.headers.authorization === `token ${t}`)) return send(res, 401, { message: 'Bad credentials' });
    if (o.limited && o.limited.now() < o.limited.until * 1000) {
      res.writeHead(403, { 'content-type': 'application/json', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(o.limited.until), 'x-ratelimit-resource': 'core' });
      return res.end(JSON.stringify({ message: 'API rate limit exceeded for user.' }));
    }
    let m = /^\/repos\/o\/r\/commits\/([^/]+)\/pulls$/.exec(path);
    if (m) return send(res, 200, o.pulls?.[m[1]!] ?? []);
    m = /^\/repos\/o\/r\/commits\/([^/]+)\/check-runs$/.exec(path);
    if (m) { const runs = o.runs?.[m[1]!] ?? []; return send(res, 200, { total_count: runs.length, check_runs: runs }); }
    m = /^\/repos\/o\/r\/commits\/([^/]+)$/.exec(path);
    if (m) {
      const c = o.commits?.[m[1]!] ?? { message: 'a direct push', parents: 1 };
      return send(res, 200, { sha: m[1], commit: { message: c.message }, parents: Array.from({ length: c.parents }, (_, i) => ({ sha: String(i).repeat(40) })) });
    }
    m = /^\/repos\/o\/r\/pulls\/(\d+)$/.exec(path);
    if (m && o.byNumber?.[Number(m[1])]) return send(res, 200, o.byNumber[Number(m[1])]);
    send(res, 404, { message: 'Not Found' });
  });
  return { server, asked, auth };
}

const merged = (n: number) => ({ number: n, html_url: `https://github.com/o/r/pull/${n}`, merged_at: '2026-10-10T00:00:00Z', merge_commit_sha: MERGE, head: { sha: HEAD } });
const run = (name: string, conclusion: string | null, status = 'completed'): Run => ({ name, status, conclusion });

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(r)); });

type Account = { token(): Promise<string>; renew(refused: string): Promise<string> } | { problem: string };
const connected: Account = { token: async () => TOKEN, renew: async () => TOKEN };

async function check(gh: ReturnType<typeof fakeGitHub>, now = { t: 0 }, github: () => Account = () => connected) {
  servers.push(gh.server);
  await new Promise<void>((r) => gh.server.listen(0, '127.0.0.1', r));
  const { port } = gh.server.address() as AddressInfo;
  // Its own limiter on the test's clock: a rate-limit refusal holds the bucket until the fake's reset time.
  const limiter = createGitHubLimiter({ now: () => now.t, sleep: async (ms) => { now.t += ms; } });
  return createReleaseCheck({ apiUrl: `http://127.0.0.1:${port}`, clock: { now: () => new Date(now.t) }, retryMs: 60_000, github, limiter });
}

describe('the release check (issue #652)', () => {
  it('passes a commit that is the merge of a pull request whose checks passed, and names the pull request', async () => {
    const c = await check(fakeGitHub({ pulls: { [MERGE]: [merged(7)] }, runs: { [HEAD]: [run('pr / test', 'success'), run('lint', 'skipped')] } }));
    expect(await c.verify(REPO, MERGE)).toEqual({ passed: true, pullRequest: { number: 7, url: 'https://github.com/o/r/pull/7' } });
    expect(await c.verify('git@github.com:o/r.git', MERGE)).toMatchObject({ passed: true });
  });

  it('holds a commit that is not the merge of a pull request: a direct push, or the head of one', async () => {
    const c = await check(fakeGitHub({ pulls: { [MERGE]: [{ ...merged(7), merge_commit_sha: HEAD }], [HEAD]: [] } }));
    expect(await c.verify(REPO, MERGE)).toEqual({ passed: false, reason: 'mmmmmmm is not the merge of a pull request' });
    expect(await c.verify(REPO, HEAD)).toEqual({ passed: false, reason: 'hhhhhhh is not the merge of a pull request' });
  });

  it('asks again about a commit GitHub does not yet name as a merge: the answer lags a merge (issue #913)', async () => {
    const now = { t: 0 };
    const world: { pulls: Record<string, unknown[]> } = { pulls: { [MERGE]: [] } };
    const c = await check(fakeGitHub({ ...world, runs: { [HEAD]: [run('pr / test', 'success')] } }), now);
    expect(await c.verify(REPO, MERGE)).toEqual({ passed: false, reason: 'mmmmmmm is not the merge of a pull request' });
    world.pulls[MERGE] = [merged(7)];
    now.t = 60_000;
    expect(await c.verify(REPO, MERGE)).toEqual({ passed: true, pullRequest: { number: 7, url: 'https://github.com/o/r/pull/7' } });
  });

  it('finds the pull request a "Merge pull request #N" commit names when GitHub names another (issue #913)', async () => {
    const promotion = { ...merged(852), merge_commit_sha: 'p'.repeat(40) };
    const gh = fakeGitHub({
      pulls: { [MERGE]: [promotion] },
      commits: { [MERGE]: { message: 'Merge pull request #815 from o/issue-815\n\nA change', parents: 2 } },
      byNumber: { 815: merged(815) },
      runs: { [HEAD]: [run('pr / test', 'success')] },
    });
    const c = await check(gh);
    expect(await c.verify(REPO, MERGE)).toEqual({ passed: true, pullRequest: { number: 815, url: 'https://github.com/o/r/pull/815' } });
  });

  it('holds a "Merge pull request #N" commit that is not pull N\'s merge, or has one parent (issue #913)', async () => {
    const other = await check(fakeGitHub({
      commits: { [MERGE]: { message: 'Merge pull request #815 from o/x', parents: 2 } },
      byNumber: { 815: { ...merged(815), merge_commit_sha: HEAD } },
      runs: { [HEAD]: [run('pr / test', 'success')] },
    }));
    expect(await other.verify(REPO, MERGE)).toEqual({ passed: false, reason: 'mmmmmmm is not the merge of a pull request' });
    const single = await check(fakeGitHub({
      commits: { [MERGE]: { message: 'Merge pull request #815 from o/x', parents: 1 } },
      byNumber: { 815: merged(815) },
      runs: { [HEAD]: [run('pr / test', 'success')] },
    }));
    expect(await single.verify(REPO, MERGE)).toEqual({ passed: false, reason: 'mmmmmmm is not the merge of a pull request' });
  });

  it('holds a pull request with no checks: no checks is not passing', async () => {
    const c = await check(fakeGitHub({ pulls: { [MERGE]: [merged(7)] } }));
    expect(await c.verify(REPO, MERGE)).toEqual({ passed: false, reason: 'pull request #7 has no checks: no checks is not passing' });
  });

  it('holds a pull request whose checks failed or have not finished', async () => {
    const failing = await check(fakeGitHub({ pulls: { [MERGE]: [merged(7)] }, runs: { [HEAD]: [run('pr / test', 'failure'), run('lint', 'success')] } }));
    expect(await failing.verify(REPO, MERGE)).toEqual({ passed: false, reason: 'a check of pull request #7 did not pass: pr / test (failure)' });
    const pending = await check(fakeGitHub({ pulls: { [MERGE]: [merged(7)] }, runs: { [HEAD]: [run('pr / test', null, 'in_progress')] } }));
    expect(await pending.verify(REPO, MERGE)).toEqual({ passed: false, reason: 'the checks of pull request #7 have not finished: pr / test' });
  });

  it('holds what it cannot ask: a repository not on GitHub, or GitHub not answering', async () => {
    const gh = fakeGitHub({ down: true });
    const c = await check(gh);
    expect(await c.verify('/srv/git/hopper.git', MERGE)).toEqual({ passed: false, reason: 'the update repository is not on GitHub: the hopper cannot see that mmmmmmm is a merged pull request with passing checks' });
    expect(gh.asked).toEqual([]);
    const down = await c.verify(REPO, MERGE);
    expect(down.passed).toBe(false);
    expect(!down.passed && down.reason).toMatch(/^GitHub could not be asked about mmmmmmm: /);
  });

  it('asks again about a commit only when its answer can still change, and not before the retry time', async () => {
    const now = { t: 0 };
    const world = { pulls: { [MERGE]: [merged(7)] }, runs: { [HEAD]: [run('pr / test', null, 'queued')] } };
    const gh = fakeGitHub(world);
    const c = await check(gh, now);
    expect(await c.verify(REPO, MERGE)).toMatchObject({ passed: false });
    world.runs[HEAD] = [run('pr / test', 'success')];
    expect(await c.verify(REPO, MERGE)).toMatchObject({ passed: false });
    expect(gh.asked).toHaveLength(2);
    // After the retry time the finished checks are read; a passed commit is never asked about again.
    now.t = 60_000;
    expect(await c.verify(REPO, MERGE)).toMatchObject({ passed: true });
    now.t = 10 * 60_000;
    await c.verify(REPO, MERGE);
    expect(gh.asked).toHaveLength(4);
  });

  it('asks every time with the connected account\'s token, never with none (issue #822)', async () => {
    const gh = fakeGitHub({ pulls: { [MERGE]: [merged(7)] }, runs: { [HEAD]: [run('pr / test', 'success')] } });
    const c = await check(gh);
    expect(await c.verify(REPO, MERGE)).toMatchObject({ passed: true });
    expect(gh.auth).toEqual([`token ${TOKEN}`, `token ${TOKEN}`]);
  });

  it('holds the commit and asks nothing while no GitHub account is connected (issue #822)', async () => {
    const gh = fakeGitHub({ pulls: { [MERGE]: [merged(7)] } });
    const c = await check(gh, { t: 0 }, () => ({ problem: 'no user has connected GitHub' }));
    expect(await c.verify(REPO, MERGE)).toEqual({ passed: false, reason: 'GitHub could not be asked about mmmmmmm: no user has connected GitHub' });
    expect(gh.asked).toEqual([]);
  });

  it('renews a token GitHub refuses, once, and asks again (issue #822)', async () => {
    const gh = fakeGitHub({ pulls: { [MERGE]: [merged(7)] }, runs: { [HEAD]: [run('pr / test', 'success')] }, tokens: ['renewed'] });
    const renewed: string[] = [];
    const c = await check(gh, { t: 0 }, () => ({ token: async () => 'old', renew: async (refused) => { renewed.push(refused); return 'renewed'; } }));
    expect(await c.verify(REPO, MERGE)).toMatchObject({ passed: true });
    expect(renewed).toEqual(['old']);
    expect(gh.auth).toEqual(['token old', 'token renewed', 'token renewed']);
  });

  it('holds a rate-limited commit until GitHub\'s reset time, and says when it asks again (issue #822)', async () => {
    const now = { t: Date.UTC(2026, 9, 11, 14, 0) };
    const reset = Date.UTC(2026, 9, 11, 14, 37) / 1000;
    const gh = fakeGitHub({ pulls: { [MERGE]: [merged(7)] }, runs: { [HEAD]: [run('pr / test', 'success')] }, limited: { until: reset, now: () => now.t } });
    const c = await check(gh, now);
    expect(await c.verify(REPO, MERGE)).toEqual({ passed: false, reason: 'GitHub rate-limited the hopper: it asks about mmmmmmm again at 14:37 UTC' });
    // The retry time passes, but not the reset: GitHub is not asked again.
    now.t += 5 * 60_000;
    expect(await c.verify(REPO, MERGE)).toMatchObject({ passed: false });
    expect(gh.asked).toHaveLength(1);
    now.t = reset * 1000;
    expect(await c.verify(REPO, MERGE)).toMatchObject({ passed: true });
  });
});

describe('the account the release check asks with (issue #822)', () => {
  const account = (login: string | undefined, apiUrl: string, token: string) => ({
    account: () => login, endpoints: () => ({ url: '', apiUrl }), token: async () => token, renew: async () => `${token}-renewed`,
  }) as unknown as ConnectedAccountTokens;

  it('is the oldest user\'s live connection on github.com: not one not connected, not a GitHub Enterprise one', async () => {
    const picked = releaseAccount([
      account(undefined, 'https://api.github.com', 'none'),
      account('ent', 'https://ghe.example/api/v3', 'enterprise'),
      account('first', 'https://api.github.com', 'first'),
      account('second', 'https://api.github.com', 'second'),
    ]);
    expect('problem' in picked).toBe(false);
    if ('problem' in picked) return;
    expect(await picked.token()).toBe('first');
    expect(await picked.renew('first')).toBe('first-renewed');
  });

  it('is none, with why, when no user has a GitHub connection on github.com', () => {
    expect(releaseAccount([account('ent', 'https://ghe.example/api/v3', 'enterprise')])).toEqual({
      problem: 'no user has a GitHub connection on https://api.github.com: an admin connects one in Sources → Connect GitHub',
    });
  });
});
