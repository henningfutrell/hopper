// Issue #1194, part 8, on the GitHub outbox (issue #1238): the write-behind of an intake action tries a GitHub write again
// when GitHub refused it for now (a 5xx, GitHub out of reach), and shows it running with its next attempt and why
// meanwhile; a write GitHub refuses for good (a 4xx) fails at once. The source's detail says how many rows are under way
// and when the last one went through, and each act's rows are timed for `afterAnswer`. The outbox's backoff
// (`outboxBackoffMs`) replaced part 8's fixed waits; the clock moves the rows due here, never the wall clock.
import { describe, expect, it } from 'vitest';
import { OUTBOX_ATTEMPTS, outboxBackoffMs } from '../../src/domain/github-outbox.ts';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { createGitHubOutbox, memoryGitHubOutbox, type OutboxSend } from '../../src/sources/github/outbox.ts';

const KEY = 'https://github.com/owner/repo/issues/1';
const REPO = 'owner/repo';
const AT = new Date('2026-10-15T10:00:00.000Z');
const ASSIGN = { change: { op: 'add_assignees' as const, assignees: ['owner'] } };

/** An outbox on a clock the test moves. */
function setup() {
  let at = AT.getTime();
  const clock = { now: () => new Date(at) };
  const outbox = createGitHubOutbox({ source: 'github', rows: memoryGitHubOutbox(), clock });
  return { outbox, later: (ms: number) => { at += ms; } };
}

/** A send that fails with each error in turn, then goes through; `calls` counts its tries. */
function flaky(...errors: Error[]) {
  const s = { calls: 0 };
  const send: OutboxSend = async () => { const e = errors[s.calls++]; if (e) throw e; };
  return { s, send };
}

/** A send that waits until `open()`. */
function gated() {
  let open!: () => void;
  const gate = new Promise<void>((res) => { open = res; });
  const send: OutboxSend = () => gate;
  return { send, open: () => open() };
}

const down = () => new GitHubApiError('GitHub is down', false, 502);

describe('the write-behind tries a write again (issue #1194)', () => {
  it('a write GitHub refused for now is tried again, shown running with why meanwhile, and goes through', async () => {
    const { outbox, later } = setup();
    const f = flaky(down());
    outbox.queue('assign', KEY, REPO, [ASSIGN]);
    await outbox.flush(f.send);
    expect(outbox.of(KEY)).toEqual({ act: 'assign', state: 'running', attempt: 2, error: 'GitHub is down' });
    // Not due before its backoff.
    expect(await outbox.flush(f.send)).toEqual({ due: 0, wrote: [] });
    later(outboxBackoffMs(1));
    expect(await outbox.flush(f.send)).toEqual({ due: 1, wrote: [REPO] });
    expect(f.s.calls).toBe(2);
    expect(outbox.of(KEY)).toBeUndefined();
    expect(outbox.detail()).toEqual({ lastWriteBehindAt: new Date(AT.getTime() + outboxBackoffMs(1)).toISOString() });
  });

  it('a write still refused at its last attempt fails, with GitHub\'s last words', async () => {
    const { outbox, later } = setup();
    const f = flaky(...Array.from({ length: OUTBOX_ATTEMPTS - 1 }, down), new GitHubApiError('still down', false, 503));
    outbox.queue('release', KEY, REPO, [ASSIGN]);
    for (let n = 1; n <= OUTBOX_ATTEMPTS; n++) {
      await outbox.flush(f.send);
      later(outboxBackoffMs(n));
    }
    expect(f.s.calls).toBe(OUTBOX_ATTEMPTS);
    expect(outbox.of(KEY)).toEqual({ act: 'release', state: 'failed', error: 'still down' });
    expect(outbox.detail()).toEqual({ writeBehindErrors: { [KEY]: 'release: still down' } });
  });

  it('a write GitHub refuses for good fails at once, with no second try', async () => {
    const { outbox, later } = setup();
    const f = flaky(new GitHubApiError('Validation Failed', true, 422));
    outbox.queue('take_in', KEY, REPO, [ASSIGN]);
    await outbox.flush(f.send);
    later(outboxBackoffMs(OUTBOX_ATTEMPTS));
    await outbox.flush(f.send);
    expect(f.s.calls).toBe(1);
    expect(outbox.of(KEY)).toEqual({ act: 'take_in', state: 'failed', error: 'Validation Failed' });
  });

  it('a write GitHub rate-limited waits until GitHub\'s own retry time, not the backoff', async () => {
    const { outbox, later } = setup();
    const f = flaky(new GitHubApiError('rate limited', false, 403, AT.getTime() + 3_600_000));
    outbox.queue('assign', KEY, REPO, [ASSIGN]);
    await outbox.flush(f.send);
    expect(outbox.of(KEY)).toMatchObject({ state: 'running', attempt: 2, error: 'rate limited' });
    later(outboxBackoffMs(1));
    expect(await outbox.flush(f.send)).toEqual({ due: 0, wrote: [] });
    later(3_600_000);
    expect(await outbox.flush(f.send)).toEqual({ due: 1, wrote: [REPO] });
    expect(f.s.calls).toBe(2);
  });
});

describe('the write-behind in the source\'s detail and timings (issue #1194)', () => {
  it('says how many rows are under way, and when the last one went through', async () => {
    const { outbox } = setup();
    const g = gated();
    outbox.queue('assign', KEY, REPO, [ASSIGN]);
    outbox.queue('release', `${KEY}0`, REPO, [{ change: { op: 'remove_labels', labels: ['hopper:claimed'] } }]);
    expect(outbox.detail()).toEqual({ writeBehindPending: 2 });
    const flushed = outbox.flush(g.send);
    g.open();
    await flushed;
    expect(outbox.detail()).toEqual({ lastWriteBehindAt: AT.toISOString() });
  });

  it('times each act\'s rows, whether they went through or failed for good', async () => {
    const { outbox, later } = setup();
    outbox.queue('assign', KEY, REPO, [ASSIGN]);
    outbox.queue('take_in', `${KEY}0`, REPO, [ASSIGN]);
    expect(outbox.timings()).toEqual([]);
    later(250);
    await outbox.flush(async (_repo, key) => { if (key !== KEY) throw new GitHubApiError('Validation Failed', true, 422); });
    const [assign, takeIn] = outbox.timings();
    expect(assign).toMatchObject({ act: 'assign', count: 1, lastAt: new Date(AT.getTime() + 250).toISOString() });
    // Its wait in the outbox: from its row to its call.
    expect(assign!.waitMs.max).toBeGreaterThanOrEqual(240);
    expect(takeIn).toMatchObject({ act: 'take_in', count: 1 });
  });
});
