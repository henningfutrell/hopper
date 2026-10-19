// A job's push (issue #1806, design.md "A push kept as a saga") under the crash harness (issue #1954): a first hopper runs a
// job of issue #7, and the job's real git pushes a new branch through it; the hopper is killed at a kill point of the push
// — before the git broker sends it to GitHub, once GitHub answered it and before the broker records it, or at the
// boundaries of the `git-push` saga. A second hopper on the same database settles the saga. The fake GitHub serves git
// with git's own `git-http-backend` over a bare repository in the test process, so the branch it holds outlives the hopper.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import { createGitPushes, GIT_PUSH_SAGA, proxyKillPoint } from '../../src/github-proxy/index.ts';
import { killPointsOf } from '../../src/sagas/kill-points.ts';
import { tempDbPath } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { bareRepo, run } from '../support/git-proxy.ts';
import { TEST_ACCOUNT_TOKEN } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';
import { endLeases, killedAt, startHost, type CrashHost } from './harness.ts';
import { openSagas } from './mint-world.ts';

export const REPO = 'octo/tools';
export const BRANCH = 'issue-7-fix';
/** The most one scenario takes: two hoppers start, one is killed, the job's git pushes twice. */
export const SCENARIO_MS = 120_000;

/** Every kill point of a job's push: the git broker's around its call to GitHub, then the `git-push` saga's. */
export const PUSH_KILL_POINTS: string[] = [
  proxyKillPoint('git.push', 'before-send'), proxyKillPoint('git.push', 'after-send'),
  ...killPointsOf(createGitPushes({ user: () => undefined, begin: () => undefined }).saga),
];

export interface PushWorld {
  github: FakeForge;
  /** The database's URL. */
  url: string;
  /** A host; `job`: it pulls the job of #7 (the first host of a test). */
  host(o?: { killPoint?: string; job?: boolean }): Promise<CrashHost>;
  /** The job's git pushes its commit to a new branch through `h`; its exit code. */
  push(h: CrashHost, proxyToken: string): Promise<number>;
  /** The commit the job pushes. */
  commit: string;
  /** Where the branch is on the fake GitHub; undefined when it is not there. */
  branchOnGitHub(): Promise<string | undefined>;
  close(): Promise<void>;
}

/** A fresh database, and the fake GitHub with octo/tools, its issue #7, and the job's clone with one commit on the branch. */
export async function pushWorld(): Promise<PushWorld> {
  const gitRoot = mkdtempSync(join(tmpdir(), 'crash-git-forge-'));
  await bareRepo(gitRoot, REPO);
  const github = await createFakeGitHub({ clientId: 'gh-client-id', gitRoot });
  github.tokens.set(TEST_ACCOUNT_TOKEN, 'owner');
  github.issues.push({ repo: REPO, number: 7, title: 'Fix it', body: 'Please.', author: 'owner', labels: [] });
  const db = tempDbPath();
  const url = databaseUrlFor(db.dbPath);
  const work = mkdtempSync(join(tmpdir(), 'crash-git-job-'));
  const env = {
    PATH: process.env.PATH, HOME: work, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'job', GIT_AUTHOR_EMAIL: 'job@example.invalid', GIT_COMMITTER_NAME: 'job', GIT_COMMITTER_EMAIL: 'job@example.invalid',
  };
  const clone = join(work, 'tools');
  await run('git', ['clone', '--quiet', '--branch', 'dev', join(gitRoot, `${REPO}.git`), clone], { env });
  writeFileSync(join(clone, 'fix.txt'), 'the fix\n');
  await run('git', ['-C', clone, 'add', '.'], { env });
  await run('git', ['-C', clone, 'commit', '--quiet', '-m', 'Fix it'], { env });
  const commit = (await run('git', ['-C', clone, 'rev-parse', 'HEAD'], { env })).stdout.trim();
  return {
    github, commit, url,
    host: (h = {}) => startHost({
      dbPath: db.dbPath, databaseUrl: url, fakes: { github: github.url },
      ...(h.job ? { connectGitHub: [REPO], job: `${REPO}#7` } : {}), ...(h.killPoint ? { killPoint: h.killPoint } : {}),
    }),
    push: async (h, proxyToken) => {
      const remote = new URL(`/job/git/${REPO}.git`, h.url);
      remote.username = 'x';
      remote.password = proxyToken;
      return (await run('git', ['-C', clone, 'push', '--quiet', remote.toString(), `HEAD:refs/heads/${BRANCH}`], { env })).code;
    },
    branchOnGitHub: async () => {
      const r = await run('git', ['--git-dir', join(gitRoot, `${REPO}.git`), 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`], { env: { PATH: process.env.PATH } });
      return r.code === 0 ? r.stdout.trim() : undefined;
    },
    close: async () => {
      await github.close();
      db.cleanup();
      for (const dir of [gitRoot, work]) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The push events on the job's timeline, as the second host reads them. */
async function pushEvents(h: CrashHost): Promise<DomainEvent[]> {
  const read = async (type: string) => (await h.get<{ events: DomainEvent[] }>(`/api/events?types=${type}&limit=1000`)).events;
  return [...await read('github_proxy.done'), ...await read('github_proxy.failed')].filter((e) => e.data.op === 'git.push');
}

/**
 * The scenario: a first hopper killed at `point` while the job pushes; a second hopper settles the push's saga. Then the
 * push is recorded once — done when GitHub holds the branch, failed when it does not — and the job's git, sent again to
 * the second hopper, puts the branch on GitHub.
 */
export async function killedThenSettled(w: PushWorld, point: string): Promise<void> {
  const a = await w.host({ killPoint: point, job: true });
  const job = a.job!;
  const first = w.push(a, job.proxyToken);
  await killedAt(a, point);
  expect(await first).not.toBe(0);
  endLeases(w.url);
  const b = await w.host();
  const events = await waitFor(async () => {
    const e = await pushEvents(b);
    return e.length > 0 && openSagas(w.url).every((x) => x.kind !== GIT_PUSH_SAGA) ? e : undefined;
  }, { timeoutMs: 60_000, what: 'the second hopper to settle the push' });
  const held = await w.branchOnGitHub();
  expect(events.map((e) => e.type), JSON.stringify(events)).toEqual([held === w.commit ? 'github_proxy.done' : 'github_proxy.failed']);
  if (point === proxyKillPoint('git.push', 'before-send')) expect(held).toBeUndefined();
  if (point === proxyKillPoint('git.push', 'after-send')) expect(held).toBe(w.commit);
  expect(await w.push(b, job.proxyToken)).toBe(0);
  expect(await w.branchOnGitHub()).toBe(w.commit);
}
