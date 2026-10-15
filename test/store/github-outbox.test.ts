// The GitHub outbox's rows (issue #1238, tenant migration 62): kept in the user's store, so a restart keeps what was not
// sent; a row a stopped process left `sending` goes back to `pending`; a row goes with the transaction it was added in.
import { describe, expect, it } from 'vitest';
import type { OutboxInput } from '../../src/domain/github-outbox.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();
const AT = '2026-10-15T10:00:00.000Z';
const row = (over: Partial<OutboxInput> = {}): OutboxInput => ({
  source: 'github', repo: 'o/r', key: 'https://github.com/o/r/issues/1', act: 'assign', tag: '',
  change: { op: 'add_assignees', assignees: ['dev'] }, event: { type: 'source.issues_assigned', data: { keys: ['k'] } }, ...over,
});

describe('the GitHub outbox rows', () => {
  it('a reopened store keeps the rows not sent; a row left sending is pending again', () => {
    const url = t.url();
    const first = t.open(url);
    first.githubOutbox.add([row(), row({ source: 'other' })], AT);
    const [mine] = first.githubOutbox.due('github', AT);
    first.githubOutbox.update([mine!.id], { state: 'sending' });
    first.close();
    const second = t.open(url);
    expect(second.githubOutbox.due('github', AT)).toEqual([]);
    expect(second.githubOutbox.recover('github')).toBe(1);
    expect(second.githubOutbox.due('github', AT)).toEqual([{ ...row(), id: mine!.id, state: 'pending', attempts: 0, nextAt: AT, createdAt: AT }]);
  });

  it('a row waits for its next attempt; a sent row leaves the open rows and is pruned later', () => {
    const store = t.open(t.url());
    store.githubOutbox.add([row()], AT);
    const [r] = store.githubOutbox.open('github');
    store.githubOutbox.update([r!.id], { state: 'pending', attempts: 1, lastError: 'down', nextAt: '2026-10-15T10:00:05.000Z' });
    expect(store.githubOutbox.due('github', AT)).toEqual([]);
    expect(store.githubOutbox.open('github')[0]).toMatchObject({ attempts: 1, lastError: 'down' });
    store.githubOutbox.update([r!.id], { state: 'sent', sentAt: AT, lastError: undefined });
    expect(store.githubOutbox.open('github')).toEqual([]);
    expect(store.githubOutbox.prune('2026-10-15T09:00:00.000Z')).toBe(0);
    expect(store.githubOutbox.prune('2026-10-15T11:00:00.000Z')).toBe(1);
  });

  it('a row added in a transaction that fails is not kept', () => {
    const store = t.open(t.url());
    expect(() => store.githubOutbox.tx(() => { store.githubOutbox.add([row()], AT); throw new Error('local change refused'); })).toThrow('local change refused');
    expect(store.githubOutbox.open('github')).toEqual([]);
  });
});
