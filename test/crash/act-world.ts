// A person's acts on a job (Merge now, Close PR, Run again) under the crash harness (issue #1959 part 3): rows of the
// GitHub outbox that the sync loop's own act sends (src/sources/pull-request-acts.ts, src/sources/rerun.ts). A first
// hopper keeps the act as a row and is killed at a kill point of its send; a second hopper on the same database sends
// what is left. The node:http fake GitHub lives in the test process, so it holds each effect whatever process made it,
// and it counts every request. The jobs are kept straight in the admin's store, as a finished job whose end was reported.
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import { outboxKillPoint } from '../../src/sources/github/outbox.ts';
import { closedAfterMergeComment } from '../../src/sources/github/own-merge.ts';
import { createFakeGitHubServer, type FakeGitHubServer } from '../../src/sources/github/http/index.ts';
import type { FakeIssueInput } from '../../src/sources/github/http/fake-state.ts';
import { openUserStore } from '../../src/store/user-store.ts';
import { tempDbPath } from '../support/app.ts';
import { databaseUrlFor, ownerSchemaUrlFor } from '../support/database.ts';
import { TEST_ACCOUNT_TOKEN } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';
import { killedAt, startHost, type CrashHost } from './harness.ts';
import { endClaims, openRows } from './outbox-world.ts';

export const REPO = 'owner/hopper-sandbox';
const issueUrl = (n: number): string => `https://github.com/${REPO}/issues/${n}`;
const pullUrl = (n: number): string => `https://github.com/${REPO}/pull/${n}`;
/** The most one scenario takes: two hoppers start, one is killed. */
export const SCENARIO_MS = 120_000;

/**
 * A person's act on a job: the outbox op of its row, the job it acts on, and the kill points inside its send — Merge now's
 * after GitHub merged and after the hopper closed the issue, Run again's after the source gave the item back.
 */
export interface JobAct { name: string; op: 'pull_request' | 'give_back'; job: 'merge' | 'close' | 'rerun'; inside: string[] }

export const JOB_ACTS: JobAct[] = [
  { name: 'Merge now', op: 'pull_request', job: 'merge', inside: ['follow:merge:after-call', 'follow:merge:after-issue-close'] },
  { name: 'Close PR', op: 'pull_request', job: 'close', inside: [] },
  { name: 'Run again', op: 'give_back', job: 'rerun', inside: ['give-back:rerun:after-give'] },
];

/** Every kill point of an act's send: before the outbox's call, inside it, and once it answered, before its row is `sent`. */
export const killPointsOf = (act: JobAct): string[] => [outboxKillPoint(act.op, 'before-send'), ...act.inside, outboxKillPoint(act.op, 'after-send')];

/**
 * The jobs' issues and pull requests. #1, its pull request #2 only mentions it ("Works on #1"): Merge now merges #2, then
 * the hopper closes #1 as completed with one comment. #3, its pull request #4: Close PR closes #4 with no merge. #5, with
 * `hopper:failed`, its job failed: Run again takes its end label off and makes a new job.
 */
function issues(opened: string): FakeIssueInput[] {
  const mention = (n: number, of: number) => ({ url: pullUrl(n), createdAt: opened, isDraft: false, mergeable: 'MERGEABLE', headCommittedAt: opened, state: 'OPEN' as const, body: `Works on #${of}.`, repo: REPO });
  const pull = (n: number, of: number): FakeIssueInput => ({
    number: n, title: `Work on #${of}`, body: `Works on #${of}.`, pullRequest: true, labels: [], assignees: [],
    pull: { headRef: `issue-${of}`, headOid: `head-${n}`, base: 'main', mergeable: 'MERGEABLE', checks: 'SUCCESS', createdAt: opened, committedAt: opened },
  });
  return [
    { number: 1, title: 'Do the thing', body: 'Please do the thing.', author: 'owner', labels: ['hopper', 'hopper:pr-ready'], assignees: ['owner'], mentionedBy: [mention(2, 1)] },
    pull(2, 1),
    { number: 3, title: 'Do the other thing', body: 'Please.', author: 'owner', labels: ['hopper', 'hopper:pr-ready'], assignees: ['owner'], mentionedBy: [mention(4, 3)] },
    pull(4, 3),
    { number: 5, title: 'Try again', body: 'Please try.', author: 'owner', labels: ['hopper', 'hopper:failed'], assignees: ['owner'] },
  ];
}

export interface ActWorld {
  dbPath: string;
  userUrl: string;
  github: FakeGitHubServer;
  /** The seeded jobs, by the act that acts on them. */
  jobs: Record<JobAct['job'], string>;
  host(o?: { killPoint?: string; connect?: boolean }): Promise<CrashHost>;
  /** Keeps the three jobs in the admin's store: after the first host made its schema. */
  seed(): void;
  close(): Promise<void>;
}

export async function actWorld(): Promise<ActWorld> {
  const opened = new Date(Date.now() - 60 * 60_000).toISOString();
  const github = await createFakeGitHubServer({
    login: 'owner', token: TEST_ACCOUNT_TOKEN,
    installations: [{ id: 7, account: 'owner', repos: [{ owner: 'owner', name: 'hopper-sandbox', labels: ['hopper'], issues: issues(opened) }] }],
  });
  const db = tempDbPath();
  const url = databaseUrlFor(db.dbPath);
  const w: ActWorld = {
    dbPath: db.dbPath, userUrl: ownerSchemaUrlFor(db.dbPath), github, jobs: { merge: '', close: '', rerun: '' },
    host: (h = {}) => startHost({
      dbPath: db.dbPath, databaseUrl: url, fakes: { github: github.url },
      ...(h.connect ? { connectGitHub: [REPO] } : {}), ...(h.killPoint ? { killPoint: h.killPoint } : {}),
    }),
    seed: () => {
      const store = openUserStore({ url: w.userUrl, clock: { now: () => new Date() }, idGen: randomUUID });
      try {
        const at = new Date(Date.now() - 30 * 60_000).toISOString();
        const make = (n: number, status: Job['status'], source: Record<string, unknown>): string => store.tx(() => {
          const job = store.jobs.create({ executor: 'scripted', payload: {} }, 50, {
            source: 'github', kind: 'github-account', key: issueUrl(n), url: issueUrl(n), title: `Issue ${n}`, repo: REPO, number: n, assignee: 'owner', origin: 'trusted',
          });
          store.jobs.update(job.id, { status, approved: true, attempts: 1, finishedAt: at, sourceState: { sync: { claimReported: true, finalReported: true }, source } });
          return job.id;
        });
        w.jobs.merge = make(1, 'finished', { pullRequest: pullUrl(2), follow: 'open', mention: true });
        w.jobs.close = make(3, 'finished', { pullRequest: pullUrl(4), follow: 'open', mention: true });
        w.jobs.rerun = make(5, 'failed', {});
      } finally { store.close(); }
    },
    close: async () => { await github.close(); db.cleanup(); },
  };
  return w;
}

/** The person presses the act on its job: answered at once (202), the row kept. A host killed meanwhile answers 0. */
export async function press(w: ActWorld, h: CrashHost, act: JobAct): Promise<number> {
  const jobId = w.jobs[act.job];
  return (await (act.job === 'rerun' ? h.ui(`/ui/api/jobs/${jobId}/rerun`, {}) : h.ui(`/ui/api/pull-requests/${act.job}`, { jobId }))).status;
}

const requests = (w: ActWorld, method: string, path: string): number =>
  w.github.state.requests.filter((r) => r.method === method && decodeURIComponent(r.path) === path).length;
const events = async (h: CrashHost, type: string): Promise<DomainEvent[]> => (await h.get<{ events: DomainEvent[] }>(`/api/events?types=${type}&limit=1000`)).events;

/** The act's row was sent by `h`; GitHub holds its effect once, and its event was recorded once. */
export async function actedOnce(w: ActWorld, h: CrashHost, act: JobAct): Promise<void> {
  await waitFor(() => (openRows(w).length === 0 ? true : undefined), { timeoutMs: 60_000, what: 'the outbox to send the act' })
    .catch((e: unknown) => { throw new Error(`${(e as Error).message}: ${JSON.stringify(openRows(w))}\n${h.stderr()}`); });
  const repo = w.github.state.repos.get(REPO)!;
  const jobId = w.jobs[act.job];
  if (act.job === 'merge') {
    expect(repo.issues.get(2)!.pull!.state).toBe('MERGED');
    const one = repo.issues.get(1)!;
    expect(one).toMatchObject({ state: 'closed', stateReason: 'completed' });
    // A comment is not idempotent: posted once, whatever process sent the row.
    expect(one.comments.map((c) => c.body)).toEqual([closedAfterMergeComment(pullUrl(2))]);
    expect(requests(w, 'POST', `/repos/${REPO}/issues/1/comments`)).toBe(1);
    const merged = (await events(h, 'job.pull_request_merged')).filter((e) => e.jobId === jobId);
    expect(merged.map((e) => e.data)).toEqual([{ pullRequest: pullUrl(2), part: false, person: expect.any(String), via: 'ui' }]);
  } else if (act.job === 'close') {
    expect(repo.issues.get(4)!.pull!.state).toBe('CLOSED');
    expect(repo.issues.get(3)!.state).toBe('open');
    expect((await events(h, 'job.pull_request_closed')).filter((e) => e.jobId === jobId)).toHaveLength(1);
  } else {
    // The end label came off (its removal is idempotent); the new job may have run and ended since.
    expect(requests(w, 'DELETE', `/repos/${REPO}/issues/5/labels/hopper:failed`)).toBeGreaterThan(0);
    // Not idempotent: one new job of the item, whatever process sent the row.
    const all = (await h.get<{ jobs: Job[] }>('/api/jobs?limit=1000')).jobs;
    const jobs = all.filter((j) => j.source?.key === issueUrl(5));
    expect(jobs.filter((j) => j.id !== jobId).map((j) => j.rerunOf)).toEqual([jobId]);
    expect((await events(h, 'job.rerun')).map((e) => e.jobId)).toEqual([jobId]);
  }
  expect((await events(h, 'job.pull_request_act_failed')).concat(await events(h, 'job.give_back_failed'))).toEqual([]);
}

/** The scenario: a first hopper killed at `point` while it sends the person's act; a second sends what is left, each effect once. */
export async function killedThenActed(w: ActWorld, act: JobAct, point: string): Promise<void> {
  const a = await w.host({ killPoint: point, connect: true });
  w.seed();
  // Answered at once; a kill as the answer goes out answers nothing.
  expect([202, 0]).toContain(await press(w, a, act));
  await killedAt(a, point);
  endClaims(w);
  await actedOnce(w, await w.host(), act);
}
