// Issue #1508: a job's own wait that names other items — an issue or a pull request of any repository, a workflow run —
// is watched by the hopper: at each sync of the job's source each named item is read, and once every one ended (closed,
// merged, the run completed) the job wakes, though it ended before the watch began. A wait the hopper watches no other
// way, and its pane carries (a background poll in it), wakes when its pane is lost. Pure.
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { settledBy, waitOnOf, waitsFor, type WaitOn } from '../../src/domain/wait-on.ts';
import { endedBeforeWait, endedNote, paneCarriesWait, watchedItems, watchedOf, watchKey, type WatchedEnd } from '../../src/domain/watched-items.ts';

const NOT_FOUND_NOTE = (url: string) => `${url} cannot be read: no such repository or item, or the hopper has no access to it, so the wait never ends on it; check the owner and name you wrote`;
const since = '2026-10-16T21:00:00.000Z';
type W = Pick<Job, 'id' | 'status' | 'wait' | 'source'>;
const waiting = (id: string, w: { for: string; until?: string; on?: WaitOn }, repo = 'acme/platform-workflows', number = 7): W =>
  ({ id, status: 'waiting_on', source: { source: 'github', kind: 'github-account', key: `https://github.com/${repo}/issues/${number}`, repo, number }, wait: { ...w, since } });

describe('what a wait watches (issue #1508)', () => {
  it('an issue or pull request named by its repository, its name alone (the job\'s owner), or a link', () => {
    expect(watchedOf(waiting('a', { for: 'identity work', on: { kind: 'outside', what: 'until identity#199 closes' } }))).toEqual([
      { kind: 'issue', repo: 'acme/identity', number: 199 },
    ]);
    expect(watchedOf(waiting('b', { for: 'the two changes', on: { kind: 'outside', what: 'until ops-tools#360 and platform#113 close with merged pull requests' } }))).toEqual([
      { kind: 'issue', repo: 'acme/ops-tools', number: 360 }, { kind: 'issue', repo: 'acme/platform', number: 113 },
    ]);
    expect(watchedOf(waiting('c', { for: 'other/thing#4 and https://github.com/x/y/pull/9', on: { kind: 'outside', what: 'them' } }))).toEqual([
      { kind: 'issue', repo: 'other/thing', number: 4 }, { kind: 'issue', repo: 'x/y', number: 9 },
    ]);
  });

  it('the owner a wait writes is kept: a bare name of the same item does not move it to the job\'s owner (issue #2066)', () => {
    const job = waiting('a', { for: 'the hopper fix (hopper#2042) to merge', on: waitOnOf({ for: 'x', on: 'outside: henningfutrell/hopper#2042' }) }, 'org-a/x');
    expect(watchedOf(job)).toEqual([{ kind: 'issue', repo: 'henningfutrell/hopper', number: 2042 }]);
    expect(watchedOf(waiting('b', { for: 'y#5 to close', on: waitOnOf({ for: 'x', on: 'outside: org-b/y#5' }) }, 'org-a/x'))).toEqual([
      { kind: 'issue', repo: 'org-b/y', number: 5 },
    ]);
    expect(watchedOf(waiting('c', { for: 'y#5, run of y 1234567', until: 'https://github.com/org-b/y/actions/runs/1234567 ends', on: { kind: 'outside', what: 'y run 1234567' } }, 'org-a/x'))).toEqual([
      { kind: 'issue', repo: 'org-a/y', number: 5 }, { kind: 'run', repo: 'org-b/y', runId: 1234567 },
    ]);
    expect(watchedOf(waiting('d', { for: 'y#5 and org-b/z#5', on: { kind: 'outside', what: 'both' } }, 'org-a/x'))).toEqual([
      { kind: 'issue', repo: 'org-a/y', number: 5 }, { kind: 'issue', repo: 'org-b/z', number: 5 },
    ]);
  });

  it('"issue N" in the job\'s own repository; the job\'s own issue is left out (its close ends the job, issue #1460)', () => {
    expect(watchedOf(waiting('a', { for: 'the fix', until: 'issue 1250 is closed', on: { kind: 'outside', what: 'the fix' } }))).toEqual([
      { kind: 'issue', repo: 'acme/platform-workflows', number: 1250 },
    ]);
    expect(watchedOf(waiting('b', { for: 'my issue', on: { kind: 'outside', what: 'until issue 7 is closed' } }))).toEqual([]);
  });

  it('a wait on an item is watched, also one the work-item ledger does not hold', () => {
    expect(watchedOf(waiting('a', { for: 'the other issue', on: { kind: 'item', repo: 'acme/identity', number: 3 } }))).toEqual([
      { kind: 'issue', repo: 'acme/identity', number: 3 },
    ]);
    expect(watchedOf(waiting('b', { for: 'the other issue', on: { kind: 'item', number: 12 } }))).toEqual([
      { kind: 'issue', repo: 'acme/platform-workflows', number: 12 },
    ]);
  });

  it('a workflow run: by its link, "<repo> run N", or "workflow run N" in the job\'s own repository', () => {
    expect(watchedOf(waiting('a', { for: 'approval', on: { kind: 'outside', what: "the Production approver's decision on platform run 37998997248" } }))).toEqual([
      { kind: 'run', repo: 'acme/platform', runId: 37998997248 },
    ]);
    expect(watchedOf(waiting('b', { for: 'https://github.com/x/y/actions/runs/123456789 to end', on: { kind: 'outside', what: 'it' } }))).toEqual([
      { kind: 'run', repo: 'x/y', runId: 123456789 },
    ]);
    expect(watchedOf(waiting('c', { for: 'the deploy', on: { kind: 'outside', what: 'the workflow run 5551234 to finish' } }))).toEqual([
      { kind: 'run', repo: 'acme/platform-workflows', runId: 5551234 },
    ]);
    expect(watchedOf(waiting('d', { for: 'the deploy', on: { kind: 'outside', what: 'run 3 times' } }))).toEqual([]);
  });

  it('nothing for a wait the hopper settles another way, or one that names no item', () => {
    expect(watchedOf(waiting('a', { for: 'PR 5', on: { kind: 'pull_request', number: 5, about: 'merge' } }))).toEqual([]);
    expect(watchedOf(waiting('b', { for: 'background probe bs9rrvy1v', on: { kind: 'outside', what: 'background probe bs9rrvy1v' } }))).toEqual([]);
    expect(watchedOf({ ...waiting('c', { for: 'identity#199', on: { kind: 'outside', what: 'x' } }), status: 'running' })).toEqual([]);
  });

  it('the items of all waits, each once, with the jobs that watch it', () => {
    const jobs = [
      waiting('a', { for: 'identity#199', on: { kind: 'outside', what: 'identity#199 closes' } }),
      waiting('b', { for: 'acme/identity#199 and ops-tools#1', on: { kind: 'outside', what: 'both' } }),
    ];
    expect(watchedItems(jobs)).toEqual([
      { ref: { kind: 'issue', repo: 'acme/identity', number: 199 }, jobIds: ['a', 'b'] },
      { ref: { kind: 'issue', repo: 'acme/ops-tools', number: 1 }, jobIds: ['b'] },
    ]);
    expect(watchKey({ kind: 'issue', repo: 'Acme/Identity', number: 199 })).toBe(watchKey({ kind: 'issue', repo: 'acme/identity', number: 199 }));
  });
});

describe('waking on what it watches (issue #1508)', () => {
  const ended: WatchedEnd[] = [
    { ref: { kind: 'issue', repo: 'acme/identity', number: 199 }, url: 'https://github.com/acme/identity/issues/199', state: 'closed' },
    { ref: { kind: 'run', repo: 'acme/platform', runId: 42 }, url: 'https://github.com/acme/platform/actions/runs/42', state: 'failure' },
  ];

  it('says what ended in a few words', () => {
    expect(endedNote(ended)).toBe('https://github.com/acme/identity/issues/199 was closed; https://github.com/acme/platform/actions/runs/42 completed (failure)');
  });

  it('says an item that does not exist, or the hopper cannot read, was not found (issues #1691, #2066)', () => {
    expect(endedNote([{ url: 'https://github.com/acme/gss/issues/330', state: 'not_found' }]))
      .toBe(NOT_FOUND_NOTE('https://github.com/acme/gss/issues/330'));
  });

  it('job.waited_items_ended wakes that job only', () => {
    const s = settledBy({ type: 'job.waited_items_ended', jobId: 'a', data: { items: ended.map(({ url, state }) => ({ url, state })) } });
    expect(s).toEqual({ kind: 'watched', jobId: 'a', note: endedNote(ended) });
    expect(waitsFor(waiting('a', { for: 'x', on: { kind: 'outside', what: 'identity#199' } }), s!)).toBe(true);
    expect(waitsFor(waiting('b', { for: 'x', on: { kind: 'outside', what: 'identity#199' } }), s!)).toBe(false);
    expect(waitsFor({ ...waiting('a', { for: 'x', on: { kind: 'outside', what: 'identity#199' } }), status: 'queued' }, s!)).toBe(false);
  });

  it('an outside wait: an item that ended before the wait began is not its event (issue #2219); a wait on an item still ends on it', () => {
    const pr = { ref: { kind: 'issue', repo: 'acme/gitops', number: 431 }, url: 'https://github.com/acme/gitops/pull/431', state: 'closed' } as const;
    const outside = waiting('a', { for: 'the gitops apply', on: { kind: 'outside', what: 'the apply after gitops#431', why: 'gated' } });
    expect(endedBeforeWait(outside, { ...pr, at: '2026-10-16T20:59:59.000Z' })).toBe(true);
    expect(endedBeforeWait(outside, { ...pr, at: since })).toBe(false);
    expect(endedBeforeWait(outside, pr)).toBe(false);
    expect(endedBeforeWait(outside, undefined)).toBe(false);
    expect(endedBeforeWait(waiting('b', { for: 'gitops#431' }), { ...pr, at: '2026-10-16T20:00:00.000Z' })).toBe(true);
    expect(endedBeforeWait(waiting('c', { for: 'x', on: { kind: 'item', repo: 'acme/gitops', number: 431 } }), { ...pr, at: '2026-10-16T20:00:00.000Z' })).toBe(false);
    expect(endedBeforeWait(outside, { ...pr, state: 'not_found', at: '2026-10-16T20:00:00.000Z' })).toBe(false);
  });
});

describe('a wait its pane carries (issues #1508, #2338)', () => {
  it('its own command only', () => {
    expect(paneCarriesWait(waiting('a', { for: 'tests', on: { kind: 'own_command' } }))).toBe(true);
  });

  it('not an outside event that names nothing watched, or a wait with nothing recorded: a person ends it, not its pane (issue #2338)', () => {
    expect(paneCarriesWait(waiting('b', { for: 'background poll bqehqv96k', on: { kind: 'outside', what: 'background poll bqehqv96k' } }))).toBe(false);
    expect(paneCarriesWait(waiting('c', { for: 'the apply', on: { kind: 'outside', what: 'the apply', why: 'gated' } }))).toBe(false);
    expect(paneCarriesWait(waiting('d', { for: 'legacy' }))).toBe(false);
  });

  it('not a wait the hopper settles itself', () => {
    expect(paneCarriesWait(waiting('a', { for: 'identity#199', on: { kind: 'outside', what: 'identity#199 closes' } }))).toBe(false);
    expect(paneCarriesWait(waiting('b', { for: 'PR 5', on: { kind: 'pull_request', number: 5, about: 'merge' } }))).toBe(false);
    expect(paneCarriesWait(waiting('c', { for: 'q', on: { kind: 'question', questionId: 'q1' } }))).toBe(false);
    expect(paneCarriesWait({ ...waiting('d', { for: 'tests', on: { kind: 'own_command' } }), status: 'running' })).toBe(false);
  });
});
