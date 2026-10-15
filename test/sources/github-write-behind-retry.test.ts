// Issue #1194, part 8: the write-behind of an intake action tries a GitHub write again when GitHub refused it for now (a 5xx,
// GitHub out of reach), and shows it running with why meanwhile; a write GitHub refuses for good (a 4xx) fails at once. The
// source's detail says how many writes are under way and when the last one went through, and each act's write is timed
// for `afterAnswer`.
import { describe, expect, it } from 'vitest';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { createWriteBehind } from '../../src/sources/github/write-behind.ts';

const KEY = 'https://github.com/owner/repo/issues/1';
const AT = new Date('2026-10-15T10:00:00.000Z');

/** A write that fails with each error in turn, then goes through; `calls` counts its tries. */
function flaky(...errors: Error[]) {
  const s = { calls: 0 };
  return { s, work: async () => { const e = errors[s.calls++]; if (e) throw e; } };
}

/** A write that waits until `open()`. */
function gated() {
  let open!: () => void;
  const gate = new Promise<void>((res) => { open = res; });
  return { work: () => gate, open: () => open() };
}

const down = () => new GitHubApiError('GitHub is down', false, 502);

describe('the write-behind tries a write again (issue #1194)', () => {
  it('a write GitHub refused for now is tried again, shown running with why meanwhile, and goes through', async () => {
    const w = createWriteBehind({ now: () => AT, retryMs: [20, 20] });
    const f = flaky(down());
    w.run('assign', KEY, f.work);
    await new Promise((r) => setTimeout(r, 5));
    expect(w.of(KEY)).toEqual({ act: 'assign', state: 'running', attempt: 2, error: 'GitHub is down' });
    await w.begin();
    expect(f.s.calls).toBe(2);
    expect(w.of(KEY)).toBeUndefined();
    expect(w.detail()).toEqual({ lastWriteBehindAt: AT.toISOString() });
  });

  it('a write still refused after the last try fails, with GitHub\'s last words', async () => {
    const w = createWriteBehind({ now: () => AT, retryMs: [1, 1] });
    const f = flaky(down(), down(), new GitHubApiError('still down', false, 503));
    w.run('release', KEY, f.work);
    await w.begin();
    expect(f.s.calls).toBe(3);
    expect(w.of(KEY)).toEqual({ act: 'release', state: 'failed', error: 'still down' });
    expect(w.detail()).toEqual({ writeBehindErrors: { [KEY]: 'release: still down' } });
  });

  it('a write GitHub refuses for good fails at once, with no second try', async () => {
    const w = createWriteBehind({ now: () => AT, retryMs: [1, 1] });
    const f = flaky(new GitHubApiError('Validation Failed', true, 422));
    w.run('take_in', KEY, f.work);
    await w.begin();
    expect(f.s.calls).toBe(1);
    expect(w.of(KEY)).toEqual({ act: 'take_in', state: 'failed', error: 'Validation Failed' });
  });

  it('a write GitHub rate-limited until after the last try fails at once, with no wait', async () => {
    const w = createWriteBehind({ now: () => AT, retryMs: [1, 1] });
    const f = flaky(new GitHubApiError('rate limited', false, 403, AT.getTime() + 3_600_000));
    w.run('assign', KEY, f.work);
    await w.begin();
    expect(f.s.calls).toBe(1);
    expect(w.of(KEY)).toMatchObject({ state: 'failed', error: 'rate limited' });
  });
});

describe('the write-behind in the source\'s detail and timings (issue #1194)', () => {
  it('says how many writes are under way, and when the last one went through', async () => {
    const w = createWriteBehind({ now: () => AT, retryMs: [] });
    const a = gated();
    const b = gated();
    w.run('assign', KEY, a.work);
    w.run('release', `${KEY}0`, b.work);
    expect(w.detail()).toEqual({ writeBehindPending: 2 });
    a.open();
    await new Promise((r) => setTimeout(r, 1));
    expect(w.detail()).toEqual({ writeBehindPending: 1, lastWriteBehindAt: AT.toISOString() });
    b.open();
    await w.begin();
    expect(w.detail()).toEqual({ lastWriteBehindAt: AT.toISOString() });
  });

  it('times each act\'s write, its tries in its run, whether it went through or failed', async () => {
    const w = createWriteBehind({ now: () => AT, retryMs: [15] });
    w.run('assign', KEY, flaky(down()).work);
    w.run('take_in', `${KEY}0`, flaky(new GitHubApiError('Validation Failed', true, 422)).work);
    expect(w.timings()).toEqual([]);
    await w.begin();
    const [assign, takeIn] = w.timings();
    expect(assign).toMatchObject({ act: 'assign', count: 1, lastAt: AT.toISOString() });
    expect(assign!.runMs.max).toBeGreaterThanOrEqual(15);
    expect(takeIn).toMatchObject({ act: 'take_in', count: 1 });
  });
});
