// @vitest-environment happy-dom
// Issue #1178: a decision on a request card is kept in the page only while the source's list agrees with it. The list
// resets it when it asks again — other text (another hash), or no approved text — or when the item's job ended.
import { beforeEach, describe, expect, it } from 'vitest';
import type { IntakeOutcome } from '../../src/domain/intake.ts';

type Approval = { hash: string; state: string; error?: string };
interface Store {
  useApprovals: { getState(): Record<string, Approval | undefined>; setState(s: Record<string, Approval>, replace?: boolean): void };
  reconcileApprovals(items: IntakeOutcome[], jobStatus?: (id: string) => string | undefined): void;
}
const path = '../../ui/src/store/intake.ts'; // browser code, type-checked by ui/tsconfig.json: imported by path
let store: Store;

const KEY = 'https://github.com/o/r/issues/1';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const card = (hash: string, approved?: { title: string; body: string }): IntakeOutcome => ({
  key: KEY, title: 'Fix it', reason: 'a request: approve it to take it', action: 'approve', group: 'request',
  request: { hash, title: 'Fix it', body: 'Please.', author: 'stranger', actors: [], why: ['written by stranger'], ...(approved ? { approved } : {}) },
});
const taken = (jobStatus: IntakeOutcome['jobStatus']): IntakeOutcome => ({ key: KEY, title: 'Fix it', jobId: 'j-1', jobStatus });

beforeEach(async () => {
  store = (await import(path)) as Store;
  store.useApprovals.setState({}, true);
});
const now = () => store.useApprovals.getState()[KEY];

describe('the daemon is the source of truth for a decision on a request card (issue #1178)', () => {
  it('a request card with another hash resets an approval', () => {
    store.useApprovals.setState({ [KEY]: { hash: A, state: 'approved' } });
    store.reconcileApprovals([card(B, { title: 'Fix it', body: 'Before.' })]);
    expect(now()).toBeUndefined();
  });

  it('a request card with no approved text resets an approval and a decline, even with the same hash', () => {
    store.useApprovals.setState({ [KEY]: { hash: A, state: 'approved' } });
    store.reconcileApprovals([card(A)]);
    expect(now()).toBeUndefined();
    store.useApprovals.setState({ [KEY]: { hash: A, state: 'declined' } });
    store.reconcileApprovals([card(A)]);
    expect(now()).toBeUndefined();
  });

  it('a request card with the same hash and the approved text keeps an approval; a refusal stays, also when the hash changes (issue #1316)', () => {
    store.useApprovals.setState({ [KEY]: { hash: A, state: 'approved' } });
    store.reconcileApprovals([card(A, { title: 'Fix it', body: 'Before.' })]);
    expect(now()).toEqual({ hash: A, state: 'approved' });
    store.useApprovals.setState({ [KEY]: { hash: A, state: 'refused', error: 'no' } });
    store.reconcileApprovals([card(A)]);
    expect(now()?.state).toBe('refused');
    store.reconcileApprovals([card(B)]);
    expect(now()?.state).toBe('refused');
  });

  it('a decision that waits for the daemon is never reset: the list can arrive before the answer', () => {
    store.useApprovals.setState({ [KEY]: { hash: A, state: 'pending' } });
    store.reconcileApprovals([card(B)]);
    store.reconcileApprovals([taken('finished')]);
    expect(now()).toEqual({ hash: A, state: 'pending' });
  });

  it('an approved item taken by a running job stays; one whose job ended is done and is reset', () => {
    store.useApprovals.setState({ [KEY]: { hash: A, state: 'approved' } });
    store.reconcileApprovals([taken('running')]);
    expect(now()?.state).toBe('approved');
    store.reconcileApprovals([taken('running')], () => 'finished');
    expect(now()).toBeUndefined();
  });
});
