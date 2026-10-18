// The GitHub outbox's rows (issue #1238, tenant migration 62): kept in the user's store, so a restart keeps what was not
// sent; a row goes with the transaction it was added in. A send claims its rows (issue #1959): one statement takes the
// rows due, so of two hoppers on one database one sends each row; a row a stopped or killed hopper left `sending` is due
// again once its claim ends.
import { describe, expect, it } from 'vitest';
import type { OutboxInput } from '../../src/domain/github-outbox.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();
const AT = '2026-10-15T10:00:00.000Z';
const UNTIL = '2026-10-15T10:02:00.000Z';
const row = (over: Partial<OutboxInput> = {}): OutboxInput => ({
  source: 'github', repo: 'o/r', key: 'https://github.com/o/r/issues/1', act: 'assign', tag: '',
  change: { op: 'add_assignees', assignees: ['dev'] }, event: { type: 'source.issues_assigned', data: { keys: ['k'] } }, ...over,
});

describe('the GitHub outbox rows', () => {
  it('a claim takes the source\'s rows due, once: a second hopper on the same database gets none of them', () => {
    const url = t.url();
    const a = t.open(url), b = t.open(url);
    a.githubOutbox.add([row(), row({ source: 'other' }), row({ key: 'https://github.com/o/r/issues/2' })], AT);
    const mine = a.githubOutbox.claim('github', AT, UNTIL);
    expect(mine.map((r) => [r.key, r.state, r.nextAt])).toEqual([
      ['https://github.com/o/r/issues/1', 'sending', UNTIL], ['https://github.com/o/r/issues/2', 'sending', UNTIL],
    ]);
    expect(b.githubOutbox.claim('github', AT, UNTIL)).toEqual([]);
    expect(b.githubOutbox.open('github').map((r) => r.state)).toEqual(['sending', 'sending']);
    expect(b.githubOutbox.claim('other', AT, UNTIL)).toHaveLength(1);
  });

  it('a reopened store keeps the rows not sent; a row left sending is claimed again once its claim ended', () => {
    const url = t.url();
    const first = t.open(url);
    first.githubOutbox.add([row()], AT);
    const [mine] = first.githubOutbox.claim('github', AT, UNTIL);
    first.close();
    const second = t.open(url);
    expect(second.githubOutbox.claim('github', '2026-10-15T10:01:59.999Z', '2026-10-15T10:04:00.000Z')).toEqual([]);
    expect(second.githubOutbox.claim('github', UNTIL, '2026-10-15T10:04:00.000Z')).toEqual([
      { ...row(), id: mine!.id, state: 'sending', attempts: 0, nextAt: '2026-10-15T10:04:00.000Z', createdAt: AT },
    ]);
  });

  it('a row waits for its next attempt; a sent row leaves the open rows and is pruned later', () => {
    const store = t.open(t.url());
    store.githubOutbox.add([row()], AT);
    const [r] = store.githubOutbox.open('github');
    store.githubOutbox.update([r!.id], { state: 'pending', attempts: 1, lastError: 'down', nextAt: '2026-10-15T10:00:05.000Z' });
    expect(store.githubOutbox.claim('github', AT, UNTIL)).toEqual([]);
    expect(store.githubOutbox.open('github')[0]).toMatchObject({ attempts: 1, lastError: 'down' });
    store.githubOutbox.update([r!.id], { state: 'sent', sentAt: AT, lastError: undefined });
    expect(store.githubOutbox.open('github')).toEqual([]);
    expect(store.githubOutbox.claim('github', '2026-10-15T11:00:00.000Z', UNTIL)).toEqual([]);
    expect(store.githubOutbox.prune('2026-10-15T09:00:00.000Z')).toBe(0);
    expect(store.githubOutbox.prune('2026-10-15T11:00:00.000Z')).toBe(1);
  });

  it('a failed row is never claimed', () => {
    const store = t.open(t.url());
    store.githubOutbox.add([row()], AT);
    const [r] = store.githubOutbox.open('github');
    store.githubOutbox.update([r!.id], { state: 'failed', attempts: 5, lastError: 'refused' });
    expect(store.githubOutbox.claim('github', '2026-10-15T11:00:00.000Z', UNTIL)).toEqual([]);
  });

  it('a row added in a transaction that fails is not kept', () => {
    const store = t.open(t.url());
    expect(() => store.githubOutbox.tx(() => { store.githubOutbox.add([row()], AT); throw new Error('local change refused'); })).toThrow('local change refused');
    expect(store.githubOutbox.open('github')).toEqual([]);
  });
});
