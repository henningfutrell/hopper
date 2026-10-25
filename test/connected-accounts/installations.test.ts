// Issue #1250 part 2: where the hopper's app is installed is read from GitHub only on Refresh, on the schedule, or when the
// account is connected, never when the connected account is shown; reads are coalesced, the read and its answers' ETags are
// kept in the store, and a failed read is read again by the schedule only after a backoff that doubles. The kept reads over
// a fake read and an in-memory store. Issue #2774: each read, the schedule's too, lists every installation and repository
// GitHub answers now, whatever the read before it saw.
import { describe, expect, it } from 'vitest';
import { createInstallationReads, FRESH_MS, MAX_RETRY_MS, RETRY_MS } from '../../src/connected-accounts/installations.ts';
import type { AppInstallation, AppInstallationsRead } from '../../src/domain/types.ts';

const FOUND: AppInstallation[] = [{ account: 'octo', repositorySelection: 'all', repositories: ['octo/a'] }];

function setup(o: { found?: () => AppInstallation[] } = {}) {
  const calls: string[] = [];
  let fail: Error | undefined;
  let hold: Promise<void> | undefined;
  let account: string | undefined = 'octo';
  const kept = new Map<string, AppInstallationsRead>();
  let now = Date.parse('2026-10-15T10:00:00.000Z');
  const reads = createInstallationReads({
    reads: { get: (p) => kept.get(p), put: (r) => { kept.set(r.provider, r); }, remove: (p) => { kept.delete(p); } },
    account: () => account,
    read: async (_p, answers) => {
      calls.push(account!);
      await hold;
      if (fail) throw fail;
      answers.keep('GET /user/installations {}', { etag: '"e1"', data: {} });
      return o.found?.() ?? FOUND;
    },
    now: () => now, log: () => {},
  });
  return {
    reads, calls, kept,
    now: () => now,
    advance: (ms: number) => { now += ms; },
    failWith: (e: Error | undefined) => { fail = e; },
    holdUntil: (p: Promise<void> | undefined) => { hold = p; },
    connectAs: (a: string | undefined) => { account = a; },
  };
}

describe('the app\'s installations: reads from GitHub', () => {
  it('a view reads nothing; it answers what the store holds', async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) expect(s.reads.view('github', 'octo')).toEqual({});
    expect(s.calls).toEqual([]);
    await s.reads.refresh('github');
    expect(s.reads.view('github', 'octo')).toEqual({ installations: FOUND, installationsCheckedAt: '2026-10-15T10:00:00.000Z' });
    expect(s.kept.get('github')?.etags).toEqual({ 'GET /user/installations {}': { etag: '"e1"', data: {} } });
  });

  it('a Refresh while one reads joins it, and the view says it is reading', async () => {
    const s = setup();
    let release!: () => void;
    s.holdUntil(new Promise<void>((r) => { release = r; }));
    const first = s.reads.refresh('github');
    const second = s.reads.refresh('github');
    expect(s.reads.view('github', 'octo')).toEqual({ installationsReading: true });
    release();
    await Promise.all([first, second]);
    expect(s.calls).toEqual(['octo']);
  });

  it('the schedule reads one never read, then only once its read is FRESH_MS old', async () => {
    const s = setup();
    await s.reads.tick();
    expect(s.calls).toHaveLength(1);
    s.advance(FRESH_MS - 1);
    await s.reads.tick();
    expect(s.calls).toHaveLength(1);
    s.advance(1);
    await s.reads.tick();
    expect(s.calls).toHaveLength(2);
  });

  it('reads nothing with no account connected', async () => {
    const s = setup();
    s.connectAs(undefined);
    await s.reads.tick();
    await s.reads.refresh('github');
    expect(s.calls).toEqual([]);
  });

  it('a failed read keeps what was read before, with why, and the backoff doubles to MAX_RETRY_MS', async () => {
    const s = setup();
    await s.reads.refresh('github');
    s.failWith(new Error('GitHub answered 503'));
    s.advance(FRESH_MS);
    await s.reads.tick();
    expect(s.reads.view('github', 'octo')).toEqual({
      installations: FOUND, installationsCheckedAt: '2026-10-15T10:00:00.000Z', installationsError: 'GitHub could not say where the app is installed: GitHub answered 503',
    });
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      const wait = Date.parse(s.kept.get('github')!.nextAt) - s.now();
      waits.push(wait);
      s.advance(wait);
      await s.reads.tick();
    }
    expect(waits).toEqual([RETRY_MS, 2 * RETRY_MS, 4 * RETRY_MS, 8 * RETRY_MS, 16 * RETRY_MS, MAX_RETRY_MS, MAX_RETRY_MS]);
  });

  it('a rate limit\'s retryAt holds the next read past the backoff', async () => {
    const s = setup();
    const retryAt = Date.parse('2026-10-15T11:00:00.000Z');
    s.failWith(Object.assign(new Error('rate limited'), { retryAt }));
    await s.reads.refresh('github');
    expect(s.kept.get('github')!.nextAt).toBe('2026-10-15T11:00:00.000Z');
  });

  it('a read of another account is not shown, and is read again; forget drops it', async () => {
    const s = setup();
    await s.reads.refresh('github');
    expect(s.reads.view('github', 'other')).toEqual({});
    s.connectAs('other');
    await s.reads.tick();
    expect(s.calls).toEqual(['octo', 'other']);
    s.reads.forget('github');
    expect(s.kept.has('github')).toBe(false);
  });

  it('the schedule\'s read lists a new owner and a repository added to an installation (issue #2774)', async () => {
    let found = FOUND;
    const s = setup({ found: () => found });
    await s.reads.refresh('github');
    found = [{ ...FOUND[0]!, repositories: ['octo/a', 'octo/b'] }, { account: 'acme', repositorySelection: 'all', repositories: ['acme/api'] }];
    s.advance(FRESH_MS);
    await s.reads.tick();
    expect(s.reads.view('github', 'octo')).toEqual({ installations: found, installationsCheckedAt: '2026-10-15T10:30:00.000Z' });
  });
});
