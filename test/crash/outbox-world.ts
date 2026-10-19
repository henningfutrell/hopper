// The GitHub outbox (issue #1238) under the crash harness (issue #1959): a first hopper keeps a person's acts as outbox
// rows and is killed at a kill point of one call (src/sources/github/outbox.ts, `outboxKillPoint`); a second hopper on the
// same database sends what is left. The node:http fake GitHub lives in the test process, so it holds each effect whatever
// process made it, and it counts every request.
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { OutboxChange, OutboxInput } from '../../src/domain/github-outbox.ts';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import type { DomainEvent } from '../../src/domain/types.ts';
import { createFakeGitHubServer, type FakeGitHubServer } from '../../src/sources/github/http/index.ts';
import { outboxKillPoint } from '../../src/sources/github/outbox.ts';
import { openDb } from '../../src/store/db.ts';
import { openUserStore } from '../../src/store/user-store.ts';
import { tempDbPath } from '../support/app.ts';
import { databaseUrlFor, ownerSchemaUrlFor } from '../support/database.ts';
import { TEST_ACCOUNT_TOKEN } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';
import { startHost, type CrashHost } from './harness.ts';

export const REPO = 'owner/hopper-sandbox';
export const issueUrl = (n: number): string => `https://github.com/${REPO}/issues/${n}`;
/** The most one scenario takes: two hoppers start, one is killed. */
export const SCENARIO_MS = 120_000;

/** Every write kind the outbox sends, and the kill points of each: before its call, and once GitHub answered it. */
export const WRITE_KINDS = ['remove_labels', 'comment', 'close_not_planned', 'add_assignees', 'add_labels'] as const satisfies readonly OutboxChange['op'][];
export const OUTBOX_KILL_POINTS: string[] = WRITE_KINDS.flatMap((op) => [outboxKillPoint(op, 'before-send'), outboxKillPoint(op, 'after-send')]);

export interface OutboxWorld {
  dbPath: string;
  /** The admin's schema: the outbox's table. */
  userUrl: string;
  github: FakeGitHubServer;
  host(o?: { killPoint?: string; connect?: boolean }): Promise<CrashHost>;
  close(): Promise<void>;
}

/**
 * A fresh database and the fake GitHub: #1 a request card a stranger wrote (Decline closes it: its label off, one comment,
 * the close), #2 an issue with no assignee (Assign to me), #3 an issue whose end label the label mirror adds (a row kept
 * as the item reconciler keeps it).
 */
export async function outboxWorld(): Promise<OutboxWorld> {
  const github = await createFakeGitHubServer({
    login: 'owner', token: TEST_ACCOUNT_TOKEN,
    installations: [{ id: 7, account: 'owner', repos: [{ owner: 'owner', name: 'hopper-sandbox', labels: ['hopper'], issues: [
      { number: 1, title: 'Fix the typo', author: 'stranger', assignees: ['owner'], labels: ['hopper'], body: 'Fix the typo in the README.' },
      { number: 2, title: 'Rename the flag', author: 'stranger', assignees: [], labels: ['hopper'], body: 'Rename the flag.' },
      { number: 3, title: 'Drop the old path', author: 'stranger', assignees: ['owner'], labels: ['hopper'], body: 'Drop the old path.' },
    ] }] }],
  });
  const db = tempDbPath();
  const url = databaseUrlFor(db.dbPath);
  return {
    dbPath: db.dbPath, userUrl: ownerSchemaUrlFor(db.dbPath), github,
    host: (h = {}) => startHost({
      dbPath: db.dbPath, databaseUrl: url, fakes: { github: github.url },
      ...(h.connect ? { connectGitHub: [REPO] } : {}), ...(h.killPoint ? { killPoint: h.killPoint } : {}),
    }),
    close: async () => { await github.close(); db.cleanup(); },
  };
}

/** Keeps `rows` in the admin's outbox, as an act keeps them; the next send of a running hopper takes them. */
export function keepRows(w: OutboxWorld, rows: Omit<OutboxInput, 'source' | 'repo'>[]): void {
  const store = openUserStore({ url: w.userUrl, clock: { now: () => new Date() }, idGen: randomUUID });
  try { store.githubOutbox.add(rows.map((r) => ({ ...r, source: 'github', repo: REPO })), new Date().toISOString()); } finally { store.close(); }
}

/** Ends every outbox claim at once, as its time would (`OUTBOX_CLAIM_MS`): the rows a killed host left are due again. */
export function endClaims(w: Pick<OutboxWorld, 'userUrl'>): void {
  const db = openDb(w.userUrl);
  const past = '1970-01-01T00:00:00.000Z';
  try {
    db.run(`UPDATE github_outbox SET next_at = ?, body = jsonb_set(body::jsonb, '{nextAt}', to_jsonb(?::text))::text WHERE state = 'sending'`, past, past);
  } finally { db.close(); }
}

/** The outbox's rows not sent, by state. */
export function openRows(w: Pick<OutboxWorld, 'userUrl'>): { state: string; op: string }[] {
  const db = openDb(w.userUrl);
  try {
    return db.all("SELECT state, body FROM github_outbox WHERE state <> 'sent' ORDER BY id")
      .map((r) => ({ state: String(r.state), op: (JSON.parse(r.body as string) as { change: OutboxChange }).change.op }));
  } finally { db.close(); }
}

/** The person's acts on a hopper: Decline with Close on #1 (its card's hash read first), Assign to me on #2, the label row of #3. */
export async function act(w: OutboxWorld, h: CrashHost): Promise<void> {
  const sources = await h.get<{ sources: { name: string; detail: { intake?: IntakeOutcome[] } }[] }>('/api/sources');
  const intake = sources.sources.find((s) => s.name === 'github')?.detail.intake ?? [];
  const hash = intake.find((x) => x.key === issueUrl(1))?.request?.hash;
  expect(hash, JSON.stringify(intake)).toBeDefined();
  keepRows(w, [{ key: issueUrl(3), act: 'mirror', tag: 'blocked:', change: { op: 'add_labels', labels: ['hopper:rejected'] } }]);
  await h.ui('/ui/api/sources/github/intake', { kind: 'decline', keys: [issueUrl(1)], hash, choice: 'close' });
  await h.ui('/ui/api/sources/github/intake', { kind: 'assign', keys: [issueUrl(2)] });
}

const writes = (w: OutboxWorld, method: string, path: string) => w.github.state.requests.filter((r) => r.method === method && r.path === path).length;

/** The outbox of `h` sent every row; GitHub holds each intended effect once, and each act's event was recorded once. */
export async function writtenOnce(w: OutboxWorld, h: CrashHost): Promise<void> {
  await waitFor(() => (openRows(w).length === 0 ? true : undefined), { timeoutMs: 60_000, what: 'the outbox to send every row' });
  const issues = w.github.state.repos.get(REPO)!.issues;
  const one = issues.get(1)!, two = issues.get(2)!, three = issues.get(3)!;
  expect(one.state).toBe('closed');
  expect(one.stateReason).toBe('not_planned');
  expect(one.labels).not.toContain('hopper');
  expect(one.comments).toHaveLength(1);
  expect(one.comments[0]!.body).toMatch(/^<!-- job-hopper v1 kind=outbox id=[0-9a-f]{16} -->\n/);
  // A comment is not idempotent: it was posted once, whatever process sent its row.
  expect(writes(w, 'POST', `/repos/${REPO}/issues/1/comments`)).toBe(1);
  expect(two.assignees).toEqual(['owner']);
  expect(three.labels).toContain('hopper:rejected');
  const events = async (type: string) => (await h.get<{ events: DomainEvent[] }>(`/api/events?types=${type}`)).events;
  expect((await events('source.request_decline_written')).map((e) => e.data.key)).toEqual([issueUrl(1)]);
  expect((await events('source.issues_assigned')).map((e) => e.data.keys)).toEqual([[issueUrl(2)]]);
}
