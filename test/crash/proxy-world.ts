// The GitHub proxy (issue #563) under the crash harness (issue #1959, part 2): a first hopper runs a job of issue #7 and is
// killed at a kill point of one of the job's writes (`proxyKillPoint`, src/github-proxy/broker.ts); the job sends the same
// request again, with the same resend key, to a second hopper on the same database. The fake GitHub lives in the test
// process (test/support/fake-forges.ts), so it holds each effect whatever process made it, and it counts every request.
import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import { proxyKillPoint } from '../../src/github-proxy/index.ts';
import { tempDbPath } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeGitHub, type FakeForge, type FakePull } from '../support/fake-forges.ts';
import { TEST_ACCOUNT_TOKEN } from '../support/github-account.ts';
import { startHost, type CrashHost } from './harness.ts';

export const REPO = 'octo/tools';
/** The most one scenario takes: two hoppers start, one is killed. */
export const SCENARIO_MS = 120_000;

/** A job's write through the proxy, as hopper-gh sends it; `pull`: it acts on the pull request the job opened first. */
export interface ProxyWrite { name: string; op: string; pull?: boolean; fields(pull: number): Record<string, string> }

/** A resend key as hopper-gh makes one: 24 hex characters, the same each time the request is sent again. */
const resendKey = (): string => randomBytes(12).toString('hex');

/** Every write kind a job asks the proxy for, with a key where hopper-gh sends one (an issue create or comment). */
export const PROXY_WRITES: ProxyWrite[] = [
  { name: 'a follow-up issue', op: 'issue.create', fields: () => ({ op: 'issue.create', repo: REPO, title: 'Tidy the docs', body: 'Later.', key: resendKey() }) },
  { name: 'a required child', op: 'issue.create', fields: () => ({ op: 'issue.create', repo: REPO, title: 'Fix first', body: 'Needed.', required: 'true', key: resendKey() }) },
  { name: 'a comment', op: 'issue.comment', fields: () => ({ op: 'issue.comment', repo: REPO, number: '7', body: 'Found the cause.', key: resendKey() }) },
  { name: 'a pull request edit', op: 'pr.edit', pull: true, fields: (n) => ({ op: 'pr.edit', repo: REPO, number: String(n), body: 'Closes #7. Now with tests.' }) },
  { name: 'a pull request close', op: 'pr.close', pull: true, fields: (n) => ({ op: 'pr.close', repo: REPO, number: String(n) }) },
  { name: 'a draft marked ready', op: 'pr.ready', pull: true, fields: (n) => ({ op: 'pr.ready', repo: REPO, number: String(n) }) },
];

/** The kill points of a write: before its call, once GitHub answered it; a required child's also between the issue and its link. */
export const killPointsOf = (w: ProxyWrite): string[] => [
  proxyKillPoint(w.op, 'before-send'), proxyKillPoint(w.op, 'after-send'),
  ...(w.name === 'a required child' ? [proxyKillPoint(w.op, 'before-link')] : []),
];

export interface ProxyWorld {
  github: FakeForge;
  pulls: FakePull[];
  /** A host; `job`: it pulls the job of #7 (the first host of a test). */
  host(o?: { killPoint?: string; job?: boolean }): Promise<CrashHost>;
  close(): Promise<void>;
}

/** A fresh database and the fake GitHub, with issue #7 of octo/tools that the job works on. */
export async function proxyWorld(): Promise<ProxyWorld> {
  const pulls: FakePull[] = [];
  const github = await createFakeGitHub({ clientId: 'gh-client-id', pulls });
  github.tokens.set(TEST_ACCOUNT_TOKEN, 'owner');
  github.issues.push({ repo: REPO, number: 7, title: 'Ship it in parts', body: 'Please.', author: 'owner', labels: [] });
  const db = tempDbPath();
  const url = databaseUrlFor(db.dbPath);
  return {
    github, pulls,
    host: (h = {}) => startHost({
      dbPath: db.dbPath, databaseUrl: url, fakes: { github: github.url },
      ...(h.job ? { connectGitHub: [REPO], job: `${REPO}#7` } : {}), ...(h.killPoint ? { killPoint: h.killPoint } : {}),
    }),
    close: async () => { await github.close(); db.cleanup(); },
  };
}

/** The job opens a draft pull request through the proxy: what an edit, a close or a ready acts on. */
export async function openPull(w: ProxyWorld, h: CrashHost): Promise<number> {
  const r = await h.proxy({ op: 'pr.create', repo: REPO, head: 'issue-7-parts', base: 'main', title: 'Ship it in parts', body: 'Closes #7.' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const n = Number(r.body!.number);
  w.pulls.find((p) => p.number === n)!.draft = true;
  return n;
}

const posts = (w: ProxyWorld, path: string): number => w.github.requests.filter((r) => r.method === 'POST' && r.path === `/api/v3${path}`).length;
const created = (w: ProxyWorld) => w.github.issues.filter((i) => i.repo === REPO && i.number !== 7);

/** GitHub holds the write's effect once, and the job's timeline records it done once (and its child filed once). */
export async function writtenOnce(w: ProxyWorld, h: CrashHost, write: ProxyWrite, sent: Record<string, string>, pull: number): Promise<void> {
  const events = async (type: string) => (await h.get<{ events: DomainEvent[] }>(`/api/events?types=${type}&limit=1000`)).events;
  const done = (await events('github_proxy.done')).filter((e) => e.data.op === write.op && e.data.replayed !== true);
  expect(done, JSON.stringify(done)).toHaveLength(1);
  const pr = w.pulls.find((p) => p.number === pull);
  if (write.op === 'issue.create') {
    expect(created(w).map((i) => i.title)).toEqual([sent.title]);
    // Not idempotent: GitHub made it once, whatever process asked.
    expect(posts(w, `/repos/${REPO}/issues`)).toBe(1);
    expect(created(w)[0]!.body).toMatch(/\n<!-- hopper post proxy-[0-9a-f]{24} -->$/);
    expect(await events('job.child_issue_filed')).toHaveLength(1);
    if (sent.required) {
      const child = created(w)[0]!;
      expect(w.github.issues.find((i) => i.number === 7)!.subIssues).toEqual([`${REPO}#${child.number}`]);
      expect(child.assignees).toEqual(['owner']);
      expect(child.labels).toContain('hopper');
    }
  } else if (write.op === 'issue.comment') {
    expect(w.github.issues.find((i) => i.number === 7)!.comments).toHaveLength(1);
    expect(posts(w, `/repos/${REPO}/issues/7/comments`)).toBe(1);
  } else if (write.op === 'pr.edit') {
    expect(pr!.body).toBe(sent.body);
  } else if (write.op === 'pr.close') {
    expect(pr!.state).toBe('closed');
  } else {
    expect(pr!.draft).toBe(false);
  }
}
