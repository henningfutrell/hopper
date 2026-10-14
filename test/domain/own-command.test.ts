// Issue #1037: a job's own wait whose `until:` names its own background command waits on nothing outside the job. Pure.
import { describe, expect, it } from 'vitest';
import { namesOwnCommand, ownWaitOf } from '../../src/domain/own-command.ts';
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
