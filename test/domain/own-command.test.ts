// Issue #1037: a job's own wait whose `until:` names its own background command waits on nothing outside the job. Pure.
import { describe, expect, it } from 'vitest';
import { namesOwnCommand, ownWaitOf, POLL_WAIT_CAP_MS, polledWait } from '../../src/domain/own-command.ts';
import type { Job, JobWait } from '../../src/domain/types.ts';

const since = '2026-10-13T00:00:00.000Z';

describe('a wait that names its own command (issue #1037)', () => {
  it.each([
    'background command b7x2 ends',
    'Background command 4 exits',
    'own command abc123 ends',
    'the background shell bash_3 finishes',
    'when my background task completes',
  ])('"%s" is its own command', (until) => { expect(namesOwnCommand({ until })).toBe(true); });

  it.each([
    'a background poll of the push',
    'the review is in',
    'a background poll that ends when the release is out',
    'write access is granted',
  ])('"%s" is the outside world', (until) => { expect(namesOwnCommand({ until })).toBe(false); });

  it('a wait with no until line is the outside world', () => {
    expect(namesOwnCommand({})).toBe(false);
  });

  it('a job on its own command is running; once flagged stuck, it waits on a person', () => {
    const wait: JobWait = { for: 'the test run', until: 'background command 1 ends', since, ownCommand: true };
    expect(ownWaitOf({ status: 'waiting_on', wait } as Job)).toBe('command');
    expect(ownWaitOf({ status: 'waiting_on', wait: { ...wait, stuckAt: since } } as Job)).toBe('stuck');
    expect(ownWaitOf({ status: 'waiting_on', wait: { for: 'a review', since } } as Job)).toBeUndefined();
    expect(ownWaitOf({ status: 'running' } as Job)).toBeUndefined();
  });
});

describe('a wait on its own command that only polls hopper state (issue #1210)', () => {
  const wait: JobWait = { for: 'PR 8 to be mergeable', until: 'own command 3 ends', since, ownCommand: true, on: { kind: 'own_command' } };
  const on = { kind: 'pull_request' as const, repo: 'octo/tools', number: 8, about: 'merge' as const };
  const t0 = Date.parse(since);

  it('typed as what it polls, once; it stays its own command, so it holds no tending queue', () => {
    const typed = polledWait({ status: 'waiting_on', wait } as Job, on, t0 + 5 * 60_000);
    expect(typed).toEqual({ kind: 'type', wait: { ...wait, on, polledAt: '2026-10-13T00:05:00.000Z' } });
    const job = { status: 'waiting_on', wait: typed!.kind === 'type' ? typed!.wait : wait } as Job;
    expect(ownWaitOf(job)).toBe('command');
    expect(polledWait(job, on, t0 + 10 * 60_000)).toBeUndefined();
  });

  it('ended once it waited the cap: the hopper ends it with what it knows', () => {
    expect(polledWait({ status: 'waiting_on', wait } as Job, on, t0 + POLL_WAIT_CAP_MS)).toEqual({ kind: 'end' });
    expect(POLL_WAIT_CAP_MS).toBe(60 * 60 * 1000);
  });

  it('nothing for a job on another wait, or not on a wait', () => {
    expect(polledWait({ status: 'waiting_on', wait: { for: 'a review', since, on: { kind: 'outside', what: 'a review' } } } as Job, on, t0 + POLL_WAIT_CAP_MS)).toBeUndefined();
    expect(polledWait({ status: 'running' } as Job, on, t0 + POLL_WAIT_CAP_MS)).toBeUndefined();
  });
});
