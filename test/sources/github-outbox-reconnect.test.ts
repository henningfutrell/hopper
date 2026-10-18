// Issue #1891 (item 6): a reconnect needed holds the GitHub outbox's writes. A write that fails because the connected
// account is expired stays pending — it counts no attempt and is never failed — while the action's own local change
// stays committed. Once the account is connected again, the rows go through. Fake at the GitHubApi seam.
import { describe, expect, it } from 'vitest';
import { type ConnectedAccountTokens } from '../../src/domain/ports.ts';
import { OUTBOX_ATTEMPTS } from '../../src/domain/github-outbox.ts';
import { expired } from '../../src/connected-accounts/service.ts';
import { createAccountSource } from '../../src/sources/compose.ts';
import { githubAccountOptions } from '../../src/sources/config.ts';
import { GitHubApiError, createFakeGitHub, type GitHubApi } from '../../src/sources/github/index.ts';
import { createGitHubOutbox, memoryGitHubOutbox, outboxSend } from '../../src/sources/github/outbox.ts';
import { testTrust } from './fixtures/github-support.ts';

const REPO = 'owner/repo';
const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const clock = { now: () => new Date('2026-10-18T10:00:00.000Z') };
const noRead = async () => {};

/** A connected account a test makes expired and connects again. */
function connection() {
  let ended = false;
  const accounts: ConnectedAccountTokens = {
    account: () => (ended ? undefined : 'owner'), ended: () => (ended ? expired('github') : undefined), expired: () => ended,
    token: async () => { if (ended) throw new Error(expired('github')); return 'token'; }, renew: async () => 'token',
    endpoints: () => ({ url: 'https://github.com', apiUrl: 'https://api.github.com' }), jobRepositories: () => [REPO],
  };
  return { accounts, expire: () => { ended = true; }, connect: () => { ended = false; }, ended: () => ended };
}

/** A GitHub whose next write makes the account expired and fails as the connection then does: `error` says how. */
function endsOnWrite(gh: GitHubApi, c: ReturnType<typeof connection>, error: () => Error) {
  let armed = true;
  const api = new Proxy(gh, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function' || !['addAssignees', 'addLabels', 'removeLabels'].includes(String(prop))) return v;
      return async (...args: unknown[]) => {
        if (armed || c.ended()) { armed = false; c.expire(); throw error(); }
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return api;
}

/** The ways a write fails once the account is expired: the token read refused, or GitHub refusing the token (a 401). */
const FAILURES: [string, () => Error][] = [
  ['the token read is refused', () => new GitHubApiError(expired('github'), false)],
  ['GitHub refuses the token (401)', () => new GitHubApiError('assign owner/repo#1: GitHub refused the connected account\'s token (401: Bad credentials)', true, 401)],
];

describe('a reconnect needed holds the outbox\'s writes (issue #1891)', () => {
  for (const [how, error] of FAILURES) {
    it(`${how}: the row stays pending with no attempt counted, never failed; a new connection sends it`, async () => {
      const gh = createFakeGitHub();
      const c = connection();
      const events: string[] = [];
      const s = createAccountSource({
        name: 'github-account', key: 'github', accounts: c.accounts, api: endsOnWrite(gh, c, error), clock,
        knownKeys: () => new Set(), rerunnable: () => new Set(), trust: testTrust(),
        intake: {
          holder: 'a1b2c3d4e5f6', othersKnown: () => new Set(), migration: () => ({ at: clock.now().toISOString(), changes: [] }), migrated: () => {},
          record: (type) => { events.push(type); }, requestOpened: () => false, requestsWaiting: () => [],
        },
      }, githubAccountOptions.parse({}));
      gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
      await s.discover();
      expect(await s.intakeAction?.({ kind: 'assign', keys: [url(1)] })).toEqual({ done: [url(1)], failed: {} });
      const gaveUp: string[] = [];
      const acts = { pullRequest: async () => {}, gaveUp: () => { gaveUp.push('pr'); }, giveBack: async () => {}, giveBackFailed: () => { gaveUp.push('give back'); } };

      // The account becomes expired while the write is sent.
      expect(await s.flushOutbox!(acts)).toEqual({ due: 1, wrote: [] });
      expect(c.ended()).toBe(true);
      // Many flushes later the row still waits: no attempt counted, nothing failed, nothing written.
      for (let i = 0; i < OUTBOX_ATTEMPTS + 1; i++) expect(await s.flushOutbox!(acts)).toEqual({ due: 0, wrote: [] });
      expect(gaveUp).toEqual([]);
      expect(gh.issue(REPO, 1).assignees).toEqual([]);
      expect(events).not.toContain('source.issues_assigned');

      // Connected again: the row goes through, and its event is recorded.
      c.connect();
      expect(await s.flushOutbox!(acts)).toEqual({ due: 1, wrote: [REPO] });
      expect(gh.issue(REPO, 1).assignees).toEqual(['owner']);
      expect(events).toContain('source.issues_assigned');
      expect(s.describe()).not.toHaveProperty('outboxFailed');
    });
  }

  it('the outbox alone: a failed call while expired keeps every row pending, at its attempts, with why', async () => {
    const gh = createFakeGitHub();
    gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    const rows = memoryGitHubOutbox();
    let connected = true;
    const outbox = createGitHubOutbox({ source: 'github', rows, clock, connected: () => connected });
    outbox.queue('resolve', url(1), REPO, [{ change: { op: 'add_assignees', assignees: ['owner'] } }, { change: { op: 'comment', body: 'Resolved.' } }], { tag: 'j1@1' });
    const refused = async () => { connected = false; throw new GitHubApiError(expired('github'), true); };
    expect(await outbox.flush(refused)).toEqual({ due: 2, wrote: [] });
    expect(rows.open('github')).toMatchObject([
      { state: 'pending', attempts: 0, lastError: expired('github') }, { state: 'pending', attempts: 0, lastError: expired('github') },
    ]);
    // Expired, nothing is sent at all.
    expect(await outbox.flush(refused)).toEqual({ due: 0, wrote: [] });
    expect(outbox.resolution(url(1), 'j1@1')).toEqual({ state: 'pending', error: expired('github') });
    connected = true;
    expect(await outbox.flush(outboxSend(gh, noRead))).toEqual({ due: 2, wrote: [REPO] });
    expect(outbox.resolution(url(1), 'j1@1')).toEqual({ state: 'written' });
    expect(gh.issue(REPO, 1).assignees).toEqual(['owner']);
  });
});
