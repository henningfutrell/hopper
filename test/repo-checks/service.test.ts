// Issue #1250: the repositories' checks are read from GitHub only on Refresh or on the schedule, never when listed; reads
// are coalesced, each repository's read and its answers' ETags are kept in the store, and a failed read is read again
// by the schedule only after a backoff that doubles. The service over a fake GitHub and an in-memory store.
import { describe, expect, it } from 'vitest';
import { createRepoChecks, FRESH_MS, MAX_RETRY_MS, RETRY_MS, type RepoChecksGitHub } from '../../src/repo-checks/index.ts';
import { RepoChecksGitHubError } from '../../src/repo-checks/github.ts';
import type { RepoChecksFound, RepoChecksRead } from '../../src/domain/types.ts';

const FOUND: RepoChecksFound = { required: ['test'], workflows: [], pullRequests: { read: 0, withChecks: 0 } };

function setup(repos = ['octo/a', 'octo/b']) {
  const calls: string[] = [];
  let fail: Error | undefined;
  let hold: Promise<void> | undefined;
  const api: RepoChecksGitHub = {
    async found(repo, answers) {
      calls.push(repo);
      await hold;
      if (fail) throw fail;
      answers.keep(`GET /repos/${repo}`, { etag: '"e1"', data: {} });
      return FOUND;
    },
    openIssue: async () => undefined,
    file: async () => ({ number: 1, url: 'u' }),
  };
  const kept = new Map<string, RepoChecksRead>();
  let now = Date.parse('2026-10-15T10:00:00.000Z');
  const service = createRepoChecks({
    github: () => ({ api, login: 'owner' }),
    repos: () => repos,
    reads: { get: (repo) => kept.get(repo), put: (r) => { kept.set(r.repo, r); } },
    yolo: () => false, dismissed: () => [], setDismissed: () => {}, record: () => {},
    now: () => now, log: () => {},
  });
  return {
    service, calls, kept,
    advance: (ms: number) => { now += ms; },
    failWith: (e: Error | undefined) => { fail = e; },
    holdUntil: (p: Promise<void> | undefined) => { hold = p; },
  };
}

describe('repository checks: reads from GitHub', () => {
  it('a list reads nothing; it answers what the store holds', async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) expect(s.service.list().repos.map((r) => r.state)).toEqual(['unknown', 'unknown']);
    expect(s.calls).toEqual([]);
    await s.service.refresh().done;
    expect(s.service.list().repos.map((r) => r.state)).toEqual(['checks', 'checks']);
    expect(s.calls).toEqual(['octo/a', 'octo/b']);
  });

  it('Refresh answers at once, says each repository is read, and a second Refresh meanwhile reads nothing more', async () => {
    const s = setup();
    let release!: () => void;
    s.holdUntil(new Promise<void>((r) => { release = r; }));
    const first = s.service.refresh();
    expect(first.view.repos.map((r) => r.reading)).toEqual([true, true]);
    const second = s.service.refresh();
    expect(s.calls).toEqual(['octo/a', 'octo/b']);
    release();
    await Promise.all([first.done, second.done]);
    expect(s.calls).toEqual(['octo/a', 'octo/b']);
    expect(s.service.list().repos.map((r) => r.reading)).toEqual([undefined, undefined]);
  });

  it('keeps each read and its answers in the store, so a new service answers the same', async () => {
    const s = setup();
    await s.service.refresh('octo/a').done;
    expect(s.calls).toEqual(['octo/a']);
    expect(s.kept.get('octo/a')).toMatchObject({ repo: 'octo/a', found: FOUND, failures: 0, etags: { 'GET /repos/octo/a': { etag: '"e1"' } } });
  });

  it('the schedule reads a repository not read yet, and one read FRESH_MS ago; nothing else', async () => {
    const s = setup();
    await s.service.tick();
    expect(s.calls).toEqual(['octo/a', 'octo/b']);
    s.advance(FRESH_MS - 1);
    await s.service.tick();
    expect(s.calls).toHaveLength(2);
    s.advance(1);
    await s.service.tick();
    expect(s.calls).toHaveLength(4);
  });

  it('a failed read is read again by the schedule only after a backoff that doubles, up to MAX_RETRY_MS', async () => {
    const s = setup(['octo/a']);
    s.failWith(new RepoChecksGitHubError('GitHub answered 503', 503));
    await s.service.tick();
    expect(s.service.list().repos[0]).toMatchObject({ state: 'unknown', error: 'GitHub answered 503' });
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = s.calls.length;
      let waited = 0;
      while (s.calls.length === before) {
        s.advance(RETRY_MS);
        waited += RETRY_MS;
        await s.service.tick();
      }
      waits.push(waited);
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 30, 30, 30].map((m) => Math.min(m * RETRY_MS, MAX_RETRY_MS)));
    s.failWith(undefined);
    s.advance(MAX_RETRY_MS);
    await s.service.tick();
    expect(s.kept.get('octo/a')).toMatchObject({ failures: 0, found: FOUND });
    expect(s.kept.get('octo/a')!.error).toBeUndefined();
  });

  it('a read GitHub rate-limited is read again by the schedule no sooner than GitHub said', async () => {
    const s = setup(['octo/a']);
    s.failWith(new RepoChecksGitHubError('rate-limited', 403, Date.parse('2026-10-15T10:20:00.000Z')));
    await s.service.tick();
    s.advance(19 * 60_000);
    await s.service.tick();
    expect(s.calls).toHaveLength(1);
    s.advance(60_000);
    await s.service.tick();
    expect(s.calls).toHaveLength(2);
  });
});
