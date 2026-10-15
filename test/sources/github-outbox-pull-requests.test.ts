// Issue #1238 part 3: Merge now and Close PR are rows of the GitHub outbox. The act is kept as a row and sent at once,
// not after the batch window. A second act on the same job while its row is on its way answers that one. A refusal for
// now waits its backoff; a permanent one, or the last attempt, fails the row and is said once. The act's row is no
// intake marker, and it is its own call, apart from the labels of its issue.
import { describe, expect, it } from 'vitest';
import { SourceError } from '../../src/domain/ports.ts';
import type { JobSource } from '../../src/domain/ports.ts';
import type { OutboxChange, OutboxRow } from '../../src/domain/github-outbox.ts';
import { createGitHubOutbox, memoryGitHubOutbox } from '../../src/sources/github/outbox.ts';
import { outboxFlushes } from '../../src/sources/outbox-flush.ts';
import type { Slot } from '../../src/sources/sync-slots.ts';

const REPO = 'owner/hopper-sandbox';
const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const PAT = { person: 'Pat', via: 'ui' as const };

function counting(fail?: (change: OutboxChange) => Error | undefined) {
  let now = new Date('2026-10-15T10:00:00.000Z');
  const calls: [string, string, OutboxChange][] = [];
  const gaveUp: [OutboxRow, string][] = [];
  const outbox = createGitHubOutbox({ source: 'github', rows: memoryGitHubOutbox(), clock: { now: () => now } });
  const send = async (repo: string, key: string, change: OutboxChange) => {
    calls.push([repo, key, change]);
    const e = fail?.(change);
    if (e) throw e;
  };
  return {
    calls, gaveUp, outbox,
    flush: () => outbox.flush(send, (row, error) => { gaveUp.push([row, error]); }),
    later: (ms: number) => { now = new Date(now.getTime() + ms); },
  };
}

describe('Merge now and Close PR in the GitHub outbox (issue #1238 part 3)', () => {
  it('the act is one row; a second act on the same job answers the one on its way; one call is sent', async () => {
    const { calls, outbox, flush } = counting();
    expect(outbox.pullRequestAct(url(1), REPO, 'merge', 'j1', PAT)).toBe('merge');
    expect(outbox.pullRequestAct(url(1), REPO, 'merge', 'j1', PAT)).toBe('merge');
    expect(outbox.pullRequestAct(url(1), REPO, 'close', 'j1', PAT)).toBe('merge');
    expect(outbox.detail()).toMatchObject({ writeBehindPending: 1 });
    // The act shows on its pull request's card, not as an intake item's write.
    expect(outbox.of(url(1))).toBeUndefined();
    expect(await flush()).toEqual({ due: 1, wrote: [REPO] });
    expect(calls).toEqual([[REPO, url(1), { op: 'pull_request', act: 'merge', jobId: 'j1', acting: PAT }]]);
    expect(outbox.detail().writeBehindPending).toBeUndefined();
    // Sent: a new act on the job is a new row.
    expect(outbox.pullRequestAct(url(1), REPO, 'close', 'j1', PAT)).toBe('close');
  });

  it('the act is its own call, apart from the labels of its issue', async () => {
    const { calls, outbox, flush } = counting();
    outbox.queue('release', url(1), REPO, [{ change: { op: 'remove_labels', labels: ['hopper:claimed'] } }]);
    outbox.pullRequestAct(url(1), REPO, 'close', 'j1', PAT);
    await flush();
    expect(calls.map(([, , c]) => c.op)).toEqual(['remove_labels', 'pull_request']);
  });

  it('a refusal for now waits its backoff; a permanent one fails the row and is said once', async () => {
    let error: Error | undefined = new SourceError('GitHub is out of reach', false);
    const { calls, gaveUp, outbox, flush, later } = counting(() => error);
    outbox.pullRequestAct(url(1), REPO, 'merge', 'j1', PAT);
    await flush();
    expect(gaveUp).toEqual([]);
    expect(outbox.detail()).toMatchObject({ writeBehindPending: 1 });
    expect(outbox.pullRequestAct(url(1), REPO, 'merge', 'j1', PAT)).toBe('merge');
    // Not due before its backoff.
    expect(await flush()).toEqual({ due: 0, wrote: [] });
    later(5_000);
    error = new SourceError('Pull Request is not mergeable (HTTP 405)', true, 405);
    await flush();
    expect(calls).toHaveLength(2);
    expect(gaveUp.map(([r, e]) => [r.change, e])).toEqual([[{ op: 'pull_request', act: 'merge', jobId: 'j1', acting: PAT }, 'Pull Request is not mergeable (HTTP 405)']]);
    expect(outbox.detail()).toMatchObject({ outboxFailed: [{ key: url(1), repo: REPO, act: 'merge', error: 'Pull Request is not mergeable (HTTP 405)', attempts: 2 }] });
    // Merge now again sends the failed row again, from its first attempt.
    error = undefined;
    expect(outbox.pullRequestAct(url(1), REPO, 'merge', 'j1', PAT)).toBe('merge');
    await flush();
    expect(calls).toHaveLength(3);
    expect(outbox.detail().outboxFailed).toBeUndefined();
  });

  it('the act is sent at once, not after the batch window', async () => {
    const flushed: string[] = [];
    const source = { name: 'github', flushOutbox: async () => { flushed.push('flush'); return { due: 1, wrote: [] }; } } as unknown as JobSource;
    const slot = { source } as Slot;
    const f = outboxFlushes({ slots: () => [slot], running: () => true, sync: () => {}, refresh: () => {}, acts: () => undefined, batchMs: 60_000 });
    f.now(slot);
    await new Promise((r) => setTimeout(r, 10));
    expect(flushed).toEqual(['flush']);
    f.stop();
  });
});
