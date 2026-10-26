// The label mirror (issue #1892, design.md "The item lifecycle") under the crash harness (issue #1954, "The crash
// harness"): a hopper killed with SIGKILL once the mirror queued a correction, as its outbox sends it, or once it recorded a
// label a person took off by hand; a second hopper on the same database ends what is left. #7 is in PR open, and its issue
// carries a stale `hopper:failed` with no `hopper:pr-ready`: the mirror corrects the labels once. #9 is in PR open too, and
// its issue carries `hopper:pr-ready`, which a person takes off by hand: the mirror records one Run again, the discover
// makes one new job of it, and no hopper puts the label back. (PR open, not failed: the failure assessor makes a failed
// item a hand-off at once, and a hand-off is not judged in its first moments.) The node:http fake GitHub
// lives in the test process, so it holds each effect whatever process made it.
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { OutboxRow } from '../../src/domain/github-outbox.ts';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { outboxKillPoint } from '../../src/sources/github/outbox.ts';
import { mirrorKillPoint } from '../../src/sources/github/label-mirror.ts';
import { createFakeGitHubServer, type FakeGitHubServer } from '../../src/sources/github/http/index.ts';
import { openDb } from '../../src/store/db.ts';
import { openUserStore } from '../../src/store/user-store.ts';
import { tempDbPath } from '../support/app.ts';
import { databaseUrlFor, ownerSchemaUrlFor } from '../support/database.ts';
import { TEST_ACCOUNT_TOKEN } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';
import { endLeases, startHost, type CrashHost } from './harness.ts';
import { endClaims } from './outbox-world.ts';

export const REPO = 'owner/hopper-sandbox';
export const issueUrl = (n: number): string => `https://github.com/${REPO}/issues/${n}`;
const pullUrl = (n: number): string => `https://github.com/${REPO}/pull/${n}`;
/** The most one scenario takes: two or three hoppers start, one is killed. */
export const SCENARIO_MS = 120_000;
/** How often a crash host syncs its source: each sync is a discover, and the mirror judges at each one. */
export const SYNC_MS = 500;

/** The kill points of the correction of #7: once the mirror queued it, and before its outbox sends each call of it. */
export const CORRECTION_KILL_POINTS = [
  mirrorKillPoint('correct', 'after-queue'), outboxKillPoint('remove_labels', 'before-send'), outboxKillPoint('add_labels', 'before-send'),
];
/** The kill point of the label edit of #9: once the mirror recorded it, before the discover judges Intake. */
export const EDIT_KILL_POINT = mirrorKillPoint('edit', 'after-record');

export interface LabelWorld {
  /** The test's database: the instance's schema (its sweep leases). */
  url: string;
  /** The admin's schema: the ledger, the jobs and the outbox. */
  userUrl: string;
  github: FakeGitHubServer;
  /** The seeded jobs, by issue number. */
  jobs: Record<number, string>;
  host(o?: { killPoint?: string; connect?: boolean }): Promise<CrashHost>;
  /** Keeps the jobs of #7 and #9 and their events in the admin's store, both in PR open: after the first host made its schema. */
  seed(): void;
  /** The labels of issue `n` on GitHub. */
  labels(n: number): string[];
  /** A person takes `label` off issue `n` on GitHub by hand. */
  takeOff(n: number, label: string): void;
  close(): Promise<void>;
}

export async function labelWorld(): Promise<LabelWorld> {
  const github = await createFakeGitHubServer({
    login: 'owner', token: TEST_ACCOUNT_TOKEN,
    installations: [{ id: 7, account: 'owner', repos: [{ owner: 'owner', name: 'hopper-sandbox', labels: ['hopper'], issues: [
      { number: 7, title: 'Fix the thing', body: 'Please fix the thing.', author: 'owner', labels: ['hopper', 'hopper:failed'], assignees: ['owner'] },
      { number: 9, title: 'Fix it again', body: 'Please fix it again.', author: 'owner', labels: ['hopper', 'hopper:pr-ready'], assignees: ['owner'] },
    ] }] }],
  });
  const db = tempDbPath();
  const url = databaseUrlFor(db.dbPath);
  const issue = (n: number) => github.state.repos.get(REPO)!.issues.get(n)!;
  const w: LabelWorld = {
    url, userUrl: ownerSchemaUrlFor(db.dbPath), github, jobs: {},
    host: (h = {}) => startHost({
      dbPath: db.dbPath, databaseUrl: url, fakes: { github: github.url }, syncMs: SYNC_MS,
      ...(h.connect ? { connectGitHub: [REPO] } : {}), ...(h.killPoint ? { killPoint: h.killPoint } : {}),
    }),
    seed: () => {
      const store = openUserStore({ url: w.userUrl, clock: { now: () => new Date() }, idGen: randomUUID });
      // Ten minutes ago: past the reconciler's grace, so the mirror judges the items at once, and well before PR open's deadline.
      const at = new Date(Date.now() - 10 * 60_000).toISOString();
      try {
        for (const n of [7, 9]) {
          w.jobs[n] = store.tx(() => {
            const spec = { executor: 'scripted', payload: {} };
            const job = store.jobs.create(spec, 50, {
              source: 'github', kind: 'github-account', key: issueUrl(n), url: issueUrl(n), title: `Issue ${n}`, repo: REPO, number: n, assignee: 'owner', origin: 'trusted',
            });
            store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority: 50 }, at });
            // Its job ended done and its report went out; it no longer follows its pull request, so no read of it is made.
            store.jobs.update(job.id, { status: 'finished', approved: true, attempts: 1, finishedAt: at, sourceState: { sync: { claimReported: true, finalReported: true }, source: { pullRequest: pullUrl(n + 1), follow: 'tended' } } });
            store.events.append({ type: 'job.finished', jobId: job.id, data: { result: 'pull request ready for review' }, at });
            store.events.append({ type: 'job.pull_request_followed', jobId: job.id, data: { pullRequest: pullUrl(n + 1), part: false }, at });
            return job.id;
          });
        }
      } finally { store.close(); }
    },
    labels: (n) => [...issue(n).labels],
    takeOff: (n, label) => {
      const i = issue(n);
      i.labels = i.labels.filter((l) => l !== label);
      i.updatedAt = new Date().toISOString();
    },
    close: async () => { await github.close(); db.cleanup(); },
  };
  return w;
}

/** Ends a killed host's leases, as their time would: its sagas, its sweeps and its outbox claims. */
export function endHeld(w: Pick<LabelWorld, 'url' | 'userUrl'>): void {
  endLeases(w.url);
  const db = openDb(w.url);
  try { db.run("UPDATE sweep_leases SET until = '1970-01-01T00:00:00.000Z'"); } finally { db.close(); }
  endClaims(w);
}

/** The ledger's row of issue `n`, read in the admin's store. */
export function itemOf(w: Pick<LabelWorld, 'userUrl'>, n: number): WorkItem | undefined {
  const store = openUserStore({ url: w.userUrl, clock: { now: () => new Date() }, idGen: randomUUID });
  try { return store.workItems.get(issueUrl(n)); } finally { store.close(); }
}

/** The label mirror's outbox rows of issue `n`, in any state. */
export function mirrorRows(w: Pick<LabelWorld, 'userUrl'>, n: number): { state: string; op: string }[] {
  const db = openDb(w.userUrl);
  try {
    return db.all('SELECT state, body FROM github_outbox ORDER BY id')
      .map((r) => ({ state: String(r.state), body: JSON.parse(r.body as string) as { act: string; key: string; change: { op: string } } }))
      .filter((r) => r.body.act === 'mirror' && r.body.key === issueUrl(n)).map((r) => ({ state: r.state, op: r.body.change.op }));
  } finally { db.close(); }
}

/**
 * Every outbox row of issue `n`, of any act, and every request on it to the fake GitHub, numbered in the order they came
 * (issue #2837): which send of the item went out twice, and after what.
 */
export function issueTrail(w: Pick<LabelWorld, 'userUrl' | 'github'>, n: number): string {
  const db = openDb(w.userUrl);
  try {
    const rows = db.all('SELECT id, state, body FROM github_outbox ORDER BY id')
      .map((r) => ({ ...(JSON.parse(r.body as string) as OutboxRow), id: Number(r.id), state: String(r.state) }))
      .filter((r) => r.key === issueUrl(n))
      .map((r) => ({ id: r.id, state: r.state, act: r.act, tag: r.tag, change: r.change, attempts: r.attempts, lastError: r.lastError, createdAt: r.createdAt, sentAt: r.sentAt }));
    const prefix = `/repos/${REPO}/issues/${n}/`;
    const calls = w.github.state.requests.map((r, i) => ({ i, method: r.method, path: decodeURIComponent(r.path) }))
      .filter((r) => r.path.startsWith(prefix) && r.method !== 'GET').map((r) => `${r.i} ${r.method} ${r.path}`);
    return `outbox rows of #${n}: ${JSON.stringify(rows)}\nwrites to #${n}: ${JSON.stringify(calls)}`;
  } finally { db.close(); }
}

export const requests = (w: Pick<LabelWorld, 'github'>, method: string, path: string): number =>
  w.github.state.requests.filter((r) => r.method === method && decodeURIComponent(r.path) === path).length;
/** The host's end at its kill point; a host not killed within `KILL_MS` fails the scenario with its output. */
export async function killed(h: CrashHost, point: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`not killed at ${point} in ${KILL_MS} ms:\n${h.output()}`)), KILL_MS); });
  try {
    const e = await Promise.race([h.exited, late]);
    expect(e.signal, h.output()).toBe('SIGKILL');
    expect(h.stderr()).toContain(`hopper: kill point ${point}`);
  } finally { clearTimeout(timer); }
}
/** The most a first host takes to reach its kill point: a few discovers, and an outbox send. */
const KILL_MS = 30_000;
export const events = async (h: CrashHost, type: string): Promise<DomainEvent[]> => (await h.get<{ events: DomainEvent[] }>(`/api/events?types=${type}&limit=1000`)).events;

/** A first hopper killed at `point` while the mirror corrects #7; a second sends what is left, each label change once. */
export async function killedThenMirrored(w: LabelWorld, point: string): Promise<void> {
  const a = await w.host({ killPoint: point, connect: true });
  w.seed();
  await killed(a, point);
  endHeld(w);
  const b = await w.host();
  await waitFor(() => (mirrorRows(w, 7).length > 0 && mirrorRows(w, 7).every((r) => r.state === 'sent') ? true : undefined), { timeoutMs: 60_000, what: 'the correction of #7 sent' })
    .catch((err: unknown) => { throw new Error(`${(err as Error).message}: ${JSON.stringify({ rows: mirrorRows(w, 7), labels: w.labels(7) })}\n${b.output()}`); });
  // A second hopper's discovers go on meanwhile: a second correction would show in them.
  await new Promise((r) => setTimeout(r, 4 * SYNC_MS));
  expect(w.labels(7)).toContain('hopper:pr-ready');
  expect(w.labels(7)).not.toContain('hopper:failed');
  expect(itemOf(w, 7)).toMatchObject({ state: 'pr_open' });
  // The correction was queued once, as one remove and one add, and each was sent once, whatever process sent it.
  expect(mirrorRows(w, 7).map((r) => r.op)).toEqual(['remove_labels', 'add_labels']);
  expect(requests(w, 'DELETE', `/repos/${REPO}/issues/7/labels/hopper:failed`)).toBe(1);
  expect(requests(w, 'POST', `/repos/${REPO}/issues/7/labels`)).toBe(1);
}

/** A first hopper sees #9's `hopper:pr-ready`, then is killed once its mirror recorded the label taken off; a second ends it. */
export async function editedThenKilled(w: LabelWorld): Promise<void> {
  const a = await w.host({ killPoint: EDIT_KILL_POINT, connect: true });
  w.seed();
  // The host's discovers saw `hopper:pr-ready` on #9 (at its start, and since); a person takes it off by hand.
  w.takeOff(9, 'hopper:pr-ready');
  await killed(a, EDIT_KILL_POINT);
  expect(itemOf(w, 9)).toMatchObject({ state: 'pr_open', runAgainAsked: 'hopper:pr-ready' });
  endHeld(w);
  const b = await w.host();
  const jobsOf9 = async (): Promise<Job[]> => (await b.get<{ jobs: Job[] }>('/api/jobs?limit=1000')).jobs.filter((j) => j.source?.key === issueUrl(9));
  await waitFor(async () => ((await jobsOf9()).length > 1 ? true : undefined), { timeoutMs: 60_000, what: 'the new job of #9' })
    .catch((err: unknown) => { throw new Error(`${(err as Error).message}: ${JSON.stringify(itemOf(w, 9))}\n${b.output()}`); });
  // A second hopper's discovers go on meanwhile: a second edit or a second job would show in them.
  await new Promise((r) => setTimeout(r, 4 * SYNC_MS));
  const edits = (await events(b, 'work_item.label_edited')).filter((ev) => ev.data.key === issueUrl(9));
  expect(edits.map((ev) => ({ from: ev.data.from, label: ev.data.label, means: ev.data.means }))).toEqual([{ from: 'pr_open', label: 'hopper:pr-ready', means: 'run_again' }]);
  expect((await jobsOf9()).map((j) => j.id).filter((id) => id !== w.jobs[9])).toHaveLength(1);
  expect(itemOf(w, 9)?.jobId).not.toBe(w.jobs[9]);
  // No hopper put the label back: the mirror queued nothing for #9.
  expect(mirrorRows(w, 9)).toEqual([]);
}
