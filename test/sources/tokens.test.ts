// The per-job token keeper: a repo-scoped installation token per job, in a 600 file inside a 700
// directory, refreshed before it runs out, and gone once the job is.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubApiError, createFakeGitHub, createGitHubSource, createJobTokenKeeper } from '../../src/sources/github/index.ts';
import { BOT, REPO, githubConfig, jobForIssue } from './fixtures/github-support.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jh-tokens-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function world() {
  let now = Date.parse('2026-10-03T10:00:00Z');
  const clock = { now: () => new Date(now), advance: (ms: number) => { now += ms; } };
  const gh = createFakeGitHub({ app: { botLogin: BOT, installedRepos: [REPO], now: clock.now } });
  const dir = join(root, 'job-tokens');
  const keeper = createJobTokenKeeper({ dir, api: gh, clock });
  return { gh, clock, dir, keeper };
}

const mode = (p: string) => statSync(p).mode & 0o777;
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
const mints = (gh: { calls: { method: string }[] }) => gh.calls.filter((c) => c.method === 'mintRepoToken').length;

describe('job token keeper', () => {
  it('ensure writes format v1, 600, inside a 700 directory, at a path derived from the issue url', async () => {
    const { gh, dir, keeper } = world();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const job = jobForIssue(1, {}, REPO, 'github-app');
    await keeper.ensure(job);
    const path = keeper.pathFor(job.source!.url!);
    expect(path).toMatch(new RegExp(`^${dir}/[0-9a-f]{16}\\.json$`));
    expect(keeper.pathFor(job.source!.url!)).toBe(path);
    expect(mode(dir)).toBe(0o700);
    expect(mode(path)).toBe(0o600);
    expect(read(path)).toEqual({ version: 1, token: expect.any(String), expiresAt: '2026-10-03T11:00:00.000Z', repo: REPO, issue: 1 });
    expect(gh.calls.find((c) => c.method === 'mintRepoToken')?.args).toEqual([REPO]);
    expect(readdirSync(dir)).toEqual([path.slice(dir.length + 1)]); // no temp file left behind
  });

  it('re-chmods an existing directory to 700', async () => {
    const { dir, keeper } = world();
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    await keeper.ensure(jobForIssue(1, {}, REPO, 'github-app'));
    expect(mode(dir)).toBe(0o700);
  });

  it('refresh mints when the file is missing or has under 15 minutes left, not before', async () => {
    const { gh, clock, keeper } = world();
    const job = jobForIssue(1, {}, REPO, 'github-app');
    const path = keeper.pathFor(job.source!.url!);
    await keeper.refresh([job]); // missing → minted (a failed claim-time mint self-heals)
    const first = read(path).token;
    expect(mints(gh)).toBe(1);
    clock.advance(44 * 60_000); // 16 min left
    await keeper.refresh([job]);
    expect(mints(gh)).toBe(1);
    clock.advance(2 * 60_000); // 14 min left
    await keeper.refresh([job]);
    expect(mints(gh)).toBe(2);
    expect(read(path).token).not.toBe(first);
    expect(read(path).expiresAt).toBe('2026-10-03T11:46:00.000Z');
  });

  it('refresh deletes orphan files (no active job)', async () => {
    const { dir, keeper } = world();
    const [a, b] = [jobForIssue(1, {}, REPO, 'github-app'), jobForIssue(2, {}, REPO, 'github-app')];
    await keeper.ensure(a);
    await keeper.ensure(b);
    writeFileSync(join(dir, 'stray.json'), '{}');
    await keeper.refresh([a]);
    expect(existsSync(keeper.pathFor(a.source!.url!))).toBe(true);
    expect(existsSync(keeper.pathFor(b.source!.url!))).toBe(false);
    expect(existsSync(join(dir, 'stray.json'))).toBe(false);
  });

  it('drop deletes the job file and tolerates a missing one', async () => {
    const { keeper } = world();
    const job = jobForIssue(1, {}, REPO, 'github-app');
    await keeper.ensure(job);
    keeper.drop(job);
    expect(existsSync(keeper.pathFor(job.source!.url!))).toBe(false);
    expect(() => keeper.drop(job)).not.toThrow();
  });

  it('a failed mint does not throw; it is reported and the next refresh retries', async () => {
    const { gh, keeper } = world();
    const job = jobForIssue(1, {}, REPO, 'github-app');
    gh.failNext('mintRepoToken', new GitHubApiError('HTTP 502', false, 502));
    await expect(keeper.ensure(job)).resolves.toBeUndefined();
    expect(keeper.errors()).toEqual({ [job.source!.url!]: 'HTTP 502' });
    await keeper.refresh([job]);
    expect(existsSync(keeper.pathFor(job.source!.url!))).toBe(true);
    expect(keeper.errors()).toEqual({});
  });
});

describe('the app source drives the keeper', () => {
  function appSource() {
    const w = world();
    const source = createGitHubSource({
      name: 'github-app', kind: 'github-app', mode: 'app', config: githubConfig({ repos: [] }), api: w.gh,
      clock: w.clock, tokens: w.keeper, appInfo: () => undefined,
    });
    w.gh.createIssue({ repo: REPO, labels: ['hopper'] });
    return { ...w, source, job: jobForIssue(1, {}, REPO, 'github-app') };
  }

  it('claimed mints the token; the final report deletes it', async () => {
    const { source, keeper, job } = appSource();
    const state = await source.report({ kind: 'claimed', job });
    expect(existsSync(keeper.pathFor(job.source!.url!))).toBe(true);
    await source.report({ kind: 'finished', job: { ...job, status: 'finished', sourceState: { source: state } } });
    expect(existsSync(keeper.pathFor(job.source!.url!))).toBe(false);
  });

  it('a failed mint never fails the claim report', async () => {
    const { gh, source, job } = appSource();
    gh.failNext('mintRepoToken', new GitHubApiError('HTTP 502', false, 502));
    const state = await source.report({ kind: 'claimed', job });
    expect(state.claimCommentId).toEqual(expect.any(Number));
  });

  it('check refreshes active jobs and sweeps the files of jobs no longer active', async () => {
    const { source, keeper, job } = appSource();
    const gone = jobForIssue(2, {}, REPO, 'github-app');
    await keeper.ensure(gone);
    await source.check([job]);
    expect(existsSync(keeper.pathFor(job.source!.url!))).toBe(true);
    expect(existsSync(keeper.pathFor(gone.source!.url!))).toBe(false);
  });
});
