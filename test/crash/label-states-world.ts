// The label mirror's correction in more states (issue #1892 parts 25, 26, 36, design.md "The item lifecycle") under the crash
// harness (issue #1954): a hopper killed with SIGKILL while its mirror corrects the labels of items in states that
// label-world.ts does not seed. #12 was dropped by a person's Close PR, and its issue carries a stale `hopper:pr-ready`: it gets
// `hopper:pr-closed`. #13 was dropped by a person's Won't do on its block, and its issue carries a stale `hopper:pr-closed`: it
// gets `hopper:rejected`. #14 is blocked: its job ended done with no pull request, and its issue carries a stale
// `hopper:pr-ready`: it gets `hopper:blocked`. #15 is a hand-off whose job's failure was reported as failed, and its issue
// carries a stale `hopper:pr-ready`: it gets `hopper:failed`. #16 failed, its failure reported and held on an open problem
// (part 36), and its issue carries a stale `hopper:pr-ready`: it gets `hopper:failed`. #17 is partly done, one part merged and
// parts left (part 36), and its issue carries a stale `hopper:partly-done`: Intake takes the issue again, so the mirror leaves it
// be (it is given back) and one new job runs its next part, its labels that job's. A second hopper on the same database ends
// what is left: each label change on GitHub once, each item stays in its state, and #17 gets one new job, never two. (Not a done
// item: one whose issue is listed open is a reopened card, issue #1126, not a drift.)
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { EventType } from '../../src/domain/event-types.ts';
import { HANDOFF_WAIT, type WorkItemState } from '../../src/domain/work-items.ts';
import type { UserStore } from '../../src/domain/ports.ts';
import { createFakeGitHubServer } from '../../src/sources/github/http/index.ts';
import { openUserStore } from '../../src/store/user-store.ts';
import { tempDbPath } from '../support/app.ts';
import { databaseUrlFor, ownerSchemaUrlFor } from '../support/database.ts';
import { TEST_ACCOUNT_TOKEN } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';
import { startHost } from './harness.ts';
import { endHeld, issueUrl, itemOf, killed, mirrorRows, REPO, requests, SYNC_MS, type LabelWorld } from './label-world.ts';

const pullUrl = (n: number): string => `https://github.com/${REPO}/pull/${n}`;

/**
 * One seeded item: its stale end label, the label its state wants, and the state and mark its events give it. `next`: Intake
 * takes the issue again, so the mirror does not judge it, a new job of the item runs, and the item leaves that state.
 */
interface StateCase { n: number; stale: string; wanted?: string; state: WorkItemState; mark: Record<string, unknown>; next?: true }

export const STATE_CASES: readonly StateCase[] = [
  { n: 12, stale: 'hopper:pr-ready', wanted: 'hopper:pr-closed', state: 'dropped', mark: { closedByPerson: true } },
  { n: 13, stale: 'hopper:pr-closed', wanted: 'hopper:rejected', state: 'dropped', mark: { wontDo: true } },
  { n: 14, stale: 'hopper:pr-ready', wanted: 'hopper:blocked', state: 'blocked', mark: { blockedCause: 'no_pr' } },
  { n: 15, stale: 'hopper:pr-ready', wanted: 'hopper:failed', state: 'needs_you', mark: { waitingOn: HANDOFF_WAIT } },
  { n: 16, stale: 'hopper:pr-ready', wanted: 'hopper:failed', state: 'failed', mark: {} },
  { n: 17, stale: 'hopper:partly-done', state: 'partly_done', mark: { pullRequestState: 'merged' }, next: true },
];

type Append = (type: EventType, data: Record<string, unknown>, jobId?: string) => void;

/** #15's job failed, its failure reported, assessed and handed off to a person: the assessor and the hand-offs leave it be. */
function seedHandoff(store: UserStore, jobId: string, at: string, append: Append): void {
  const error = 'tests failed';
  store.jobs.update(jobId, { status: 'failed', approved: true, attempts: 1, finishedAt: at, error, sourceState: { sync: { claimReported: true, finalReported: true } } });
  append('job.failed', { error });
  const record = store.failures.create({
    jobId, at, signature: 'seeded', normalised: error, cls: 'job', decision: 'person', reasons: ['seeded'], summary: 'Needs a person.', auto: false,
    evidence: { error, executor: 'scripted', attempt: 1, sameSignature: 1 }, outcome: 'surfaced', outcomeAt: at,
  });
  const h = store.handoffs.create({ jobId, recordId: record.id, status: 'open', reason: 'person', openedAt: at, decision: 'person', class: 'job', summary: record.summary, reasons: record.reasons, error });
  store.failures.update(record.id, { handoffId: h.id });
  store.jobs.update(jobId, { assessment: { recordId: record.id, at, class: 'job', decision: 'person', summary: record.summary, reasons: record.reasons } });
  append('handoff.opened', { handoffId: h.id, reason: 'person', summary: h.summary, notify: false, recordId: record.id, decision: 'person', class: 'job' });
}

/** #16's job failed, its failure reported, and assessed as held on an open problem with no check: it waits on the problem. */
function seedHeld(store: UserStore, jobId: string, at: string, append: Append): void {
  const error = 'tests failed';
  store.jobs.update(jobId, { status: 'failed', approved: true, attempts: 1, finishedAt: at, error, sourceState: { sync: { claimReported: true, finalReported: true } } });
  append('job.failed', { error });
  const problem = store.problems.create({ signature: 'seeded', title: 'Seeded problem', decision: 'hold', scope: {}, status: 'open', openedAt: at, updatedAt: at, general: false, jobIds: [jobId] });
  const record = store.failures.create({
    jobId, at, signature: 'seeded', normalised: error, cls: 'shared', decision: 'hold', reasons: ['seeded'], summary: 'Held.', auto: true, problemId: problem.id,
    evidence: { error, executor: 'scripted', attempt: 1, sameSignature: 1 }, outcome: 'held', outcomeAt: at,
  });
  store.jobs.update(jobId, { assessment: { recordId: record.id, at, class: 'shared', decision: 'hold', summary: record.summary, reasons: record.reasons, problemId: problem.id, problemTitle: problem.title } });
  append('job.assessed', { recordId: record.id, signature: 'seeded', class: 'shared', decision: 'hold', reasons: record.reasons, summary: record.summary, attempt: 1, auto: true, problemId: problem.id });
}

export type StatesWorld = Pick<LabelWorld, 'url' | 'userUrl' | 'github' | 'jobs' | 'host' | 'seed' | 'labels' | 'close'> & {
  /** How many jobs issue `n`'s item has. */
  jobsOf: (n: number) => number;
};

export async function statesWorld(): Promise<StatesWorld> {
  const github = await createFakeGitHubServer({
    login: 'owner', token: TEST_ACCOUNT_TOKEN,
    installations: [{ id: 7, account: 'owner', repos: [{ owner: 'owner', name: 'hopper-sandbox', labels: ['hopper'], issues: STATE_CASES.map((c) => ({
      number: c.n, title: `Issue ${c.n}`, body: `Please do issue ${c.n}.`, author: 'owner', labels: ['hopper', c.stale], assignees: ['owner'],
    })) }] }],
  });
  const db = tempDbPath();
  const url = databaseUrlFor(db.dbPath);
  const w: StatesWorld = {
    url, userUrl: ownerSchemaUrlFor(db.dbPath), github, jobs: {},
    host: (h = {}) => startHost({
      dbPath: db.dbPath, databaseUrl: url, fakes: { github: github.url }, syncMs: SYNC_MS,
      ...(h.connect ? { connectGitHub: [REPO] } : {}), ...(h.killPoint ? { killPoint: h.killPoint } : {}),
    }),
    seed: () => {
      const store = openUserStore({ url: w.userUrl, clock: { now: () => new Date() }, idGen: randomUUID });
      // Ten minutes ago: past the reconciler's grace, so the mirror judges the items at once.
      const at = new Date(Date.now() - 10 * 60_000).toISOString();
      try {
        for (const c of STATE_CASES) {
          w.jobs[c.n] = store.tx(() => {
            const spec = { executor: 'scripted', payload: {} };
            const key = issueUrl(c.n);
            const pullRequest = pullUrl(c.n + 100);
            const job = store.jobs.create(spec, 50, {
              source: 'github', kind: 'github-account', key, url: key, title: `Issue ${c.n}`, repo: REPO, number: c.n, assignee: 'owner', origin: 'trusted',
            });
            const append: Append = (type, data, jobId = job.id) => { store.events.append({ type, ...(jobId ? { jobId } : {}), data, at }); };
            append('job.queued', { spec, priority: 50 });
            if (c.n === 15) { seedHandoff(store, job.id, at, append); return job.id; }
            if (c.n === 16) { seedHeld(store, job.id, at, append); return job.id; }
            if (c.n === 17) {
              // Its job's part merged with parts left, and its report went out; the follow recorded the merge.
              const parts = { done: 1, total: 3 };
              store.jobs.update(job.id, { status: 'finished', approved: true, attempts: 1, finishedAt: at, sourceState: { sync: { claimReported: true, finalReported: true }, source: { pullRequest, follow: 'merged', part: true, parts } } });
              append('job.finished', { result: 'pull request ready for review', partlyDone: pullRequest });
              append('job.pull_request_merged', { pullRequest, part: true });
              return job.id;
            }
            if (c.n === 14) {
              // Its job ended done with no pull request, and its report went out: blocked, a person is asked.
              store.jobs.update(job.id, { status: 'finished', approved: true, attempts: 1, finishedAt: at, sourceState: { sync: { claimReported: true, finalReported: true } } });
              append('job.finished', { result: 'nothing to change' });
              return job.id;
            }
            // Its job ended done and its report went out; it no longer follows its pull request, so no read of it is made.
            store.jobs.update(job.id, { status: 'finished', approved: true, attempts: 1, finishedAt: at, sourceState: { sync: { claimReported: true, finalReported: true }, source: { pullRequest, follow: 'tended' } } });
            append('job.finished', { result: 'pull request ready for review' });
            append('job.pull_request_followed', { pullRequest, part: false });
            if (c.n === 12) append('job.pull_request_closed', { pullRequest, part: false, person: 'owner', via: 'ui' });
            if (c.n === 13) {
              // Closed without a merge on GitHub: blocked; then a person's Won't do on the block drops it.
              append('job.pull_request_closed', { pullRequest, part: false });
              append('work_item.dropped', { source: 'github', key, jobId: job.id, cause: 'pr_closed', by: { person: 'owner', via: 'ui' } }, undefined);
            }
            return job.id;
          });
        }
      } finally { store.close(); }
    },
    labels: (n) => [...github.state.repos.get(REPO)!.issues.get(n)!.labels],
    jobsOf: (n) => {
      const store = openUserStore({ url: w.userUrl, clock: { now: () => new Date() }, idGen: randomUUID });
      try { return store.jobs.idsOfItem(issueUrl(n)).length; } finally { store.close(); }
    },
    close: async () => { await github.close(); db.cleanup(); },
  };
  return w;
}

/** A first hopper killed at `point` while the mirror corrects the items; a second sends what is left, each label change once. */
export async function statesKilledThenMirrored(w: StatesWorld, point: string): Promise<void> {
  const a = await w.host({ killPoint: point, connect: true });
  w.seed();
  for (const c of STATE_CASES) expect(itemOf(w, c.n), `#${c.n} as seeded`).toMatchObject({ state: c.state, ...c.mark });
  await killed(a, point);
  endHeld(w);
  const b = await w.host();
  const sent = () => STATE_CASES.every((c) => (c.next ? w.jobsOf(c.n) > 1 : mirrorRows(w, c.n).length > 0 && mirrorRows(w, c.n).every((r) => r.state === 'sent')));
  await waitFor(() => (sent() ? true : undefined), { timeoutMs: 60_000, what: 'the corrections sent' })
    .catch((err: unknown) => { throw new Error(`${(err as Error).message}: ${JSON.stringify(STATE_CASES.map((c) => ({ n: c.n, rows: mirrorRows(w, c.n), labels: w.labels(c.n) })))}\n${b.output()}`); });
  // A second hopper's discovers go on meanwhile: a second correction would show in them.
  await new Promise((r) => setTimeout(r, 4 * SYNC_MS));
  for (const c of STATE_CASES) {
    // Its next part: one new job, whichever hopper's Intake made it, and no mirror row.
    if (c.next) {
      expect(w.jobsOf(c.n), `#${c.n}`).toBe(2);
      expect(mirrorRows(w, c.n), `#${c.n}`).toEqual([]);
      continue;
    }
    expect(w.labels(c.n), `#${c.n}`).toContain(c.wanted);
    expect(w.labels(c.n), `#${c.n}`).not.toContain(c.stale);
    expect(itemOf(w, c.n), `#${c.n}`).toMatchObject({ state: c.state, ...c.mark });
    // Queued once, as one remove and one add, and each sent once, whatever process sent it.
    expect(mirrorRows(w, c.n).map((r) => r.op), `#${c.n}`).toEqual(['remove_labels', 'add_labels']);
    expect(requests(w, 'DELETE', `/repos/${REPO}/issues/${c.n}/labels/${c.stale}`), `#${c.n}`).toBe(1);
    expect(requests(w, 'POST', `/repos/${REPO}/issues/${c.n}/labels`), `#${c.n}`).toBe(1);
  }
}
