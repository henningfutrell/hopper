// The release check (issue #652, requirement 9): an update goes only to a commit that is the merge of a pull request
// whose checks passed. Asked of GitHub's public REST API, here a fake on loopback; "no checks" is not passing, and a
// commit GitHub cannot be asked about is not offered.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createReleaseCheck } from '../../src/update/release-check.ts';
import { send } from '../support/fake-http.ts';

const MERGE = 'm'.repeat(40);
const HEAD = 'h'.repeat(40);
const REPO = 'https://github.com/o/r.git';

interface Run { name: string; status: string; conclusion: string | null }

/** A fake GitHub: the pull requests of each commit, the check runs of each commit; each request counted. */
function fakeGitHub(o: { pulls?: Record<string, unknown[]>; runs?: Record<string, Run[]>; down?: boolean }) {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    asked.push(path);
    if (o.down) return send(res, 503, { message: 'unavailable' });
    let m = /^\/repos\/o\/r\/commits\/([^/]+)\/pulls$/.exec(path);
    if (m) return send(res, 200, o.pulls?.[m[1]!] ?? []);
    m = /^\/repos\/o\/r\/commits\/([^/]+)\/check-runs$/.exec(path);
    if (m) { const runs = o.runs?.[m[1]!] ?? []; return send(res, 200, { total_count: runs.length, check_runs: runs }); }
    send(res, 404, { message: 'Not Found' });
  });
  return { server, asked };
}

const merged = (n: number) => ({ number: n, html_url: `https://github.com/o/r/pull/${n}`, merged_at: '2026-10-10T00:00:00Z', merge_commit_sha: MERGE, head: { sha: HEAD } });
const run = (name: string, conclusion: string | null, status = 'completed'): Run => ({ name, status, conclusion });

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(r)); });

async function check(gh: ReturnType<typeof fakeGitHub>, now = { t: 0 }) {
  servers.push(gh.server);
  await new Promise<void>((r) => gh.server.listen(0, '127.0.0.1', r));
  const { port } = gh.server.address() as AddressInfo;
  return createReleaseCheck({ apiUrl: `http://127.0.0.1:${port}`, clock: { now: () => new Date(now.t) }, retryMs: 60_000 });
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
});
