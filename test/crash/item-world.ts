// The item lifecycle (issue #1891) under the crash harness (issue #1954, design.md "The crash harness"): a first hopper's
// item reconciler corrects two work items and is killed at a kill point of a correction (src/work-items/reconcile.ts,
// `itemKillPoint`); a second hopper on the same database ends what is left. #1 is in PR open past its deadline: the
// reconciler blocks it as stale, with its label change as outbox rows in the block's transaction. #3 is blocked because
// its pull request was closed without a merge, the first time: the reconciler runs it again once. #5 was blocked as stale
// long ago and no one was asked yet: the reconciler asks a person once. (A block's own notice comes two minutes after it,
// `RECONCILE_GRACE_MS`, longer than a scenario: so #5 is blocked already.) The node:http fake GitHub lives in the test process, so it holds each effect whatever process made it.
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { createFakeGitHubServer, type FakeGitHubServer } from '../../src/sources/github/http/index.ts';
import { openDb } from '../../src/store/db.ts';
import { openUserStore } from '../../src/store/user-store.ts';
import { itemKillPoint } from '../../src/work-items/reconcile.ts';
import { tempDbPath } from '../support/app.ts';
import { databaseUrlFor, ownerSchemaUrlFor } from '../support/database.ts';
import { TEST_ACCOUNT_TOKEN } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';
import { endLeases, startHost, type CrashHost } from './harness.ts';
import { endClaims, openRows } from './outbox-world.ts';

export const REPO = 'owner/hopper-sandbox';
export const issueUrl = (n: number): string => `https://github.com/${REPO}/issues/${n}`;
const pullUrl = (n: number): string => `https://github.com/${REPO}/pull/${n}`;
/** The most one scenario takes: two hoppers start, one is killed. */
export const SCENARIO_MS = 120_000;
/** How often a crash host's item reconciler checks. */
const RECONCILE_MS = 300;

/** The kill point of a run again between the source's give-back and the new job (src/sources/rerun.ts). */
const GIVEN = 'give-back:rerun-by-reconciler:after-give';
/** Every kill point of the three corrections: the block of #1, the run again of #3, the notice of #5. */
export const ITEM_KILL_POINTS = [
  itemKillPoint('block', 'inside-tx'), itemKillPoint('block', 'after-record'), itemKillPoint('ask', 'after-record'),
  itemKillPoint('run_again', 'before-call'), GIVEN, itemKillPoint('run_again', 'after-call'),
];

/** Which items a world seeds: `stale` (#1, blocked once), `closed` (#3, run again once) and `blocked` (#5, asked about once). */
export type ItemCase = 'stale' | 'closed' | 'blocked';

export interface ItemWorld {
  dbPath: string;
  /** The test's database: the instance's schema (its sweep leases). */
  url: string;
  /** The admin's schema: the ledger, the jobs and the outbox. */
  userUrl: string;
  github: FakeGitHubServer;
  /** The seeded jobs, by case. */
  jobs: Partial<Record<ItemCase, string>>;
  host(o?: { killPoint?: string; connect?: boolean; databaseUrl?: string }): Promise<CrashHost>;
  /** Keeps the cases' jobs and their events in the admin's store: after the first host made its schema. */
  seed(cases?: readonly ItemCase[]): void;
  /** Makes every item's next check due now, again and again until the returned stop: a check is 5 minutes apart. */
  due(): () => void;
  close(): Promise<void>;
}

export async function itemWorld(): Promise<ItemWorld> {
  const github = await createFakeGitHubServer({
    login: 'owner', token: TEST_ACCOUNT_TOKEN,
    installations: [{ id: 7, account: 'owner', repos: [{ owner: 'owner', name: 'hopper-sandbox', labels: ['hopper'], issues: [
      { number: 1, title: 'Do the thing', body: 'Please do the thing.', author: 'owner', labels: ['hopper', 'hopper:pr-ready'], assignees: ['owner'] },
      { number: 3, title: 'Do it again', body: 'Please do it again.', author: 'owner', labels: ['hopper', 'hopper:pr-closed'], assignees: ['owner'] },
      { number: 5, title: 'Do the last thing', body: 'Please do the last thing.', author: 'owner', labels: ['hopper', 'hopper:blocked'], assignees: ['owner'] },
    ] }] }],
  });
  const db = tempDbPath();
  const url = databaseUrlFor(db.dbPath);
  const w: ItemWorld = {
    dbPath: db.dbPath, url, userUrl: ownerSchemaUrlFor(db.dbPath), github, jobs: {},
    host: (h = {}) => startHost({
      dbPath: db.dbPath, databaseUrl: h.databaseUrl ?? url, fakes: { github: github.url }, reconcileMs: RECONCILE_MS,
      ...(h.connect ? { connectGitHub: [REPO] } : {}), ...(h.killPoint ? { killPoint: h.killPoint } : {}),
    }),
    seed: (cases = ['stale', 'closed', 'blocked']) => {
      const store = openUserStore({ url: w.userUrl, clock: { now: () => new Date() }, idGen: randomUUID });
      try {
        const make = (n: number, at: string, source: Record<string, unknown>, events: (jobId: string) => void): string => store.tx(() => {
          const spec = { executor: 'scripted', payload: {} };
          const job = store.jobs.create(spec, 50, {
            source: 'github', kind: 'github-account', key: issueUrl(n), url: issueUrl(n), title: `Issue ${n}`, repo: REPO, number: n, assignee: 'owner', origin: 'trusted',
          });
          store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority: 50 }, at });
          store.jobs.update(job.id, { status: 'finished', approved: true, attempts: 1, finishedAt: at, sourceState: { sync: { claimReported: true, finalReported: true }, source } });
          store.events.append({ type: 'job.finished', jobId: job.id, data: { result: 'pull request ready for review' }, at });
          events(job.id);
          return job.id;
        });
        // #1: in PR open for two hours, its job no longer follows its pull request: past its deadline.
        const twoHours = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
        if (cases.includes('stale')) {
          w.jobs.stale = make(1, twoHours, { pullRequest: pullUrl(2), follow: 'tended' }, (jobId) => {
            store.events.append({ type: 'job.pull_request_followed', jobId, data: { pullRequest: pullUrl(2), part: false }, at: twoHours });
          });
        }
        // #5: blocked as stale an hour ago (an hour past its deadline), no one asked yet.
        if (cases.includes('blocked')) {
          w.jobs.blocked = make(5, twoHours, { pullRequest: pullUrl(6), follow: 'tended' }, (jobId) => {
            store.events.append({ type: 'job.pull_request_followed', jobId, data: { pullRequest: pullUrl(6), part: false }, at: twoHours });
            store.events.append({ type: 'work_item.reconciled', data: { key: issueUrl(5), from: 'pr_open', cause: 'stale' }, at: new Date(Date.now() - 60 * 60_000).toISOString() });
          });
        }
        // #3: its pull request closed on GitHub without a merge half an hour ago, the first time in a row.
        const halfHour = new Date(Date.now() - 30 * 60_000).toISOString();
        if (cases.includes('closed')) {
          w.jobs.closed = make(3, halfHour, { pullRequest: pullUrl(4), follow: 'closed' }, (jobId) => {
            store.events.append({ type: 'job.pull_request_closed', jobId, data: { pullRequest: pullUrl(4), part: false }, at: halfHour });
          });
        }
      } finally { store.close(); }
    },
    due: () => {
      const timer = setInterval(() => { dueNow(w); }, RECONCILE_MS);
      return () => clearInterval(timer);
    },
    close: async () => { await github.close(); db.cleanup(); },
  };
  return w;
}

/** Every item's next check due now, as its time would make it. */
function dueNow(w: Pick<ItemWorld, 'userUrl'>): void {
  const db = openDb(w.userUrl);
  try { db.run("UPDATE work_items SET next_check_at = '1970-01-01T00:00:00.000Z'"); } finally { db.close(); }
}

/** Ends a killed host's leases, as their time would: its sagas, its sweeps (the item reconciler's) and its outbox claims. */
export function endHeld(w: Pick<ItemWorld, 'url' | 'userUrl'>): void {
  endLeases(w.url);
  const db = openDb(w.url);
  try { db.run("UPDATE sweep_leases SET until = '1970-01-01T00:00:00.000Z'"); } finally { db.close(); }
  endClaims(w);
}

/** The ledger's row of issue `n`, read in the admin's store. */
export function itemOf(w: Pick<ItemWorld, 'userUrl'>, n: number): WorkItem | undefined {
  const store = openUserStore({ url: w.userUrl, clock: { now: () => new Date() }, idGen: randomUUID });
  try { return store.workItems.get(issueUrl(n)); } finally { store.close(); }
}

const requests = (w: ItemWorld, method: string, path: string): number =>
  w.github.state.requests.filter((r) => r.method === method && decodeURIComponent(r.path) === path).length;
const events = async (h: CrashHost, type: string): Promise<DomainEvent[]> => (await h.get<{ events: DomainEvent[] }>(`/api/events?types=${type}&limit=1000`)).events;
const labels = (w: ItemWorld, n: number): string[] => w.github.state.repos.get(REPO)!.issues.get(n)!.labels;

/** #1 blocked once, its labels changed on GitHub once; nothing of the outbox left. */
export async function blockedOnce(w: ItemWorld, h: CrashHost): Promise<void> {
  const key = issueUrl(1);
  await waitFor(() => (openRows(w).length === 0 && labels(w, 1).includes('hopper:blocked') ? true : undefined), { timeoutMs: 60_000, what: 'the block of #1 and its labels on GitHub' })
    .catch((e: unknown) => { throw new Error(`${(e as Error).message}: ${JSON.stringify({ item: itemOf(w, 1), rows: openRows(w), labels: labels(w, 1) })}\n${h.output()}`); });
  expect(itemOf(w, 1)).toMatchObject({ state: 'blocked', blockedCause: 'stale' });
  expect((await events(h, 'work_item.reconciled')).filter((e) => e.data.key === key).map((e) => e.data)).toEqual([{ key, from: 'pr_open', cause: 'stale' }]);
  expect(labels(w, 1)).not.toContain('hopper:pr-ready');
  // The block's label change was sent once, whatever process sent it.
  expect(requests(w, 'POST', `/repos/${REPO}/issues/1/labels`)).toBe(1);
  expect(requests(w, 'DELETE', `/repos/${REPO}/issues/1/labels/hopper:pr-ready`)).toBe(1);
}

/** #5 asked about once. */
export async function askedOnce(w: ItemWorld, h: CrashHost): Promise<void> {
  const key = issueUrl(5);
  const asked = async (): Promise<DomainEvent[]> => (await events(h, 'work_item.person_asked')).filter((e) => e.data.key === key);
  await waitFor(async () => ((await asked()).length > 0 ? true : undefined), { timeoutMs: 60_000, what: 'the person asked about #5' })
    .catch((e: unknown) => { throw new Error(`${(e as Error).message}: ${JSON.stringify(itemOf(w, 5))}\n${h.output()}`); });
  expect(itemOf(w, 5)).toMatchObject({ state: 'blocked', blockedCause: 'stale', personAsked: true });
  expect((await asked()).map((e) => e.data)).toEqual([{ key, cause: 'stale', jobId: w.jobs.blocked, pullRequest: pullUrl(6) }]);
}

/** #3 ran again once: one new job of its item, by the reconciler, and its end label off on GitHub. */
export async function ranAgainOnce(w: ItemWorld, h: CrashHost, point: string): Promise<void> {
  const jobId = w.jobs.closed!;
  const reruns = async (): Promise<Job[]> => (await h.get<{ jobs: Job[] }>('/api/jobs?limit=1000')).jobs.filter((j) => j.rerunOf === jobId);
  await waitFor(async () => ((await reruns()).length > 0 ? true : undefined), { timeoutMs: 60_000, what: 'the new job of #3' })
    .catch((e: unknown) => { throw new Error(`${(e as Error).message}: ${JSON.stringify(itemOf(w, 3))}\n${h.output()}`); });
  // A second host's passes go on meanwhile: a second run again would show in them.
  await new Promise((r) => setTimeout(r, 3 * RECONCILE_MS));
  expect((await reruns()).map((j) => j.source?.key)).toEqual([issueUrl(3)]);
  // A kill between the give-back and the new job leaves the item labelled for the source again: the next sync takes it as
  // a Run again from GitHub, which records no `job.rerun`. Else the reconciler's own Run again made it.
  expect((await events(h, 'job.rerun')).filter((e) => e.jobId === jobId).map((e) => e.data.by)).toEqual(point === GIVEN ? [] : ['reconciler']);
  expect(labels(w, 3), h.output()).not.toContain('hopper:pr-closed');
}

/** The scenario: a first hopper killed at `point` while it corrects the items; a second ends what is left, each effect once. */
export async function killedThenCorrected(w: ItemWorld, point: string): Promise<void> {
  const a = await w.host({ killPoint: point, connect: true });
  w.seed();
  const stop = w.due();
  try {
    const e = await a.exited;
    expect(e.signal, a.output()).toBe('SIGKILL');
    expect(a.stderr()).toContain(`hopper: kill point ${point}`);
    endHeld(w);
    const b = await w.host();
    await blockedOnce(w, b);
    await askedOnce(w, b);
    await ranAgainOnce(w, b, point);
  } finally { stop(); }
}
