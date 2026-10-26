// Pull requests of a waiting job (issue #1143 reopened): the newest job of an item is on its own wait, so no follow and no
// tend reaches the pull requests its item's jobs opened. Which ones it holds, when one with merge conflicts wakes it, and
// that the same head wakes it once.
import { describe, expect, it } from 'vitest';
import type { CompanionRead } from '../../src/domain/companion-pull-requests.ts';
import { conflictWake, conflictWakeNote, waitingAfter, waitingPullRequests } from '../../src/domain/waiting-pull-requests.ts';
import type { Job, JobWait } from '../../src/domain/types.ts';
import { jobForIssue, REPO } from '../sources/fixtures/github-support.ts';

const OWN = `https://github.com/${REPO}/pull/7`;
const OTHER = 'https://github.com/elsewhere/app/pull/24';
const at = (m: number) => new Date(Date.UTC(2026, 9, 24, 12, m)).toISOString();
const outside: JobWait = { for: 'the cutover window', on: { kind: 'outside', what: 'the cutover window' }, since: at(5) };
const job = (id: string, m: number, status: Job['status'], extra: Partial<Job> = {}): Job =>
  jobForIssue(1, { id, status, createdAt: at(m), ...extra });
const read = (url: string, conflicting: boolean, head?: string): CompanionRead =>
  ({ url, state: 'open', conflicting, base: 'main', headRef: 'issue-1-work', ...(head ? { head } : {}) });

describe('pull requests of a waiting job (issue #1143 reopened)', () => {
  it('the newest job of an item on its own wait holds the pull requests every job of the item opened', () => {
    const first = job('job-1', 0, 'finished');
    const waiting = job('job-2', 1, 'waiting_on', { wait: outside });
    const opened = (id: string) => (id === 'job-1' ? [OWN] : id === 'job-2' ? [OTHER, 'https://gitlab.example/g/a/-/merge_requests/3'] : []);
    expect(waitingPullRequests([first, waiting], opened)).toEqual([{ job: waiting, pulls: [OTHER, OWN] }]);
  });

  it('a job not on its own wait, or on a wait for its own command, holds none', () => {
    const opened = () => [OWN];
    expect(waitingPullRequests([job('job-1', 0, 'running')], opened)).toEqual([]);
    expect(waitingPullRequests([job('job-1', 0, 'finished')], opened)).toEqual([]);
    expect(waitingPullRequests([job('job-1', 0, 'waiting_on', { wait: { ...outside, on: { kind: 'own_command' } } })], opened)).toEqual([]);
    expect(waitingPullRequests([job('job-1', 0, 'waiting_on', { wait: outside })], () => [])).toEqual([]);
  });

  it('one a read saw end is read no more', () => {
    const j = job('job-1', 0, 'waiting_on', { wait: outside, sourceState: { source: { waitingPulls: { [OWN]: { ended: true } } } } });
    expect(waitingPullRequests([j], () => [OWN, OTHER])).toEqual([{ job: j, pulls: [OTHER] }]);
  });

  it('one with merge conflicts wakes it, once for each head', () => {
    const j = job('job-1', 0, 'waiting_on', { wait: outside });
    expect(conflictWake(j, [OWN], [read(OWN, false, 'a1')])).toBeUndefined();
    expect(conflictWake(j, [OWN], [read(OWN, true, 'a1')])).toEqual(read(OWN, true, 'a1'));
    const woke = { ...j, sourceState: { source: { waitingPulls: waitingAfter(j, [OWN], [read(OWN, true, 'a1')], OWN) } } };
    expect(woke.sourceState.source.waitingPulls).toEqual({ [OWN]: { woke: 'a1' } });
    expect(conflictWake(woke, [OWN], [read(OWN, true, 'a1')])).toBeUndefined();
    // The job pushed, and the base moved again: a new head wakes it again.
    expect(conflictWake(woke, [OWN], [read(OWN, true, 'b2')])).toEqual(read(OWN, true, 'b2'));
  });

  it('a read keeps one that ended, and what woke it', () => {
    const j = job('job-1', 0, 'waiting_on', { wait: outside, sourceState: { source: { waitingPulls: { [OTHER]: { woke: 'c3' } } } } });
    expect(waitingAfter(j, [OWN, OTHER], [{ url: OWN, state: 'merged', conflicting: false }], undefined)).toEqual({ [OWN]: { ended: true }, [OTHER]: { woke: 'c3' } });
  });

  it('the note names the pull request, its base, and that the job waits again after', () => {
    const note = conflictWakeNote(outside, OWN, 'main');
    expect(note).toContain(OWN);
    expect(note).toContain('`main`');
    expect(note).toContain('the cutover window');
    expect(note).toContain('HOPPER_WAITING');
  });
});
