// Issue #2335 gap 2: every job on its own wait has its agent ended, whatever it waits on, but a wait on its own command —
// a build or a test run of the job that runs in its pane. A wait only a background poll in its pane watched (an outside
// event the hopper watches nothing of) is the hopper's now too: a person ends it, or the check-in it named (issue #2338).
import { describe, expect, it } from 'vitest';
import type { Job, JobWait } from '../../src/domain/types.ts';
import type { EngineContext } from '../../src/engine/context.ts';
import { waitSessionsOf } from '../../src/engine/wait-release.ts';

const SINCE = '2026-10-21T10:00:00.000Z';
const job = (id: string, wait: Partial<JobWait>): Job => ({
  id, spec: { executor: 'herdr-claude', payload: {} }, priority: 50, status: 'waiting_on', approved: true, createdAt: SINCE, updatedAt: SINCE, attempts: 1,
  agentSession: `session-${id}`, resumeOn: 'seat',
  source: { source: 's', kind: 'github', key: 'https://github.com/octo/tools/issues/7', repo: 'octo/tools', number: 7 },
  wait: { for: 'it', since: SINCE, ...wait },
});

const WAITS: Record<string, Partial<JobWait>> = {
  'pr merge': { on: { kind: 'pull_request', number: 8, about: 'merge' } },
  'pr checks': { on: { kind: 'pull_request', number: 8, about: 'checks' } },
  'pr review': { on: { kind: 'pull_request', number: 8, about: 'review' } },
  issue: { on: { kind: 'item', number: 9 } },
  job: { on: { kind: 'job', jobId: 'j9' } },
  question: { on: { kind: 'question', questionId: 'q1' } },
  'sandbox approval': { on: { kind: 'approval', of: 'sandbox' } },
  'vault grant': { on: { kind: 'grant' } },
  plan: { on: { kind: 'plan', planId: 'p1' } },
  'scheduled recheck': { on: { kind: 'outside', what: 'a deploy window' }, checkLine: 'after 2h' },
  'outside, named items': { on: { kind: 'outside', what: 'octo/identity#199 to close' } },
  'outside, nothing the hopper watches (a background poll)': { on: { kind: 'outside', what: 'the deploy to finish' } },
  'outside, gated': { on: { kind: 'outside', what: 'the production apply', why: 'gated' } },
  'outside, not managed': { on: { kind: 'outside', what: 'a release of a vendor repository', why: 'not_managed' } },
  'nothing recorded': {},
};

const ctx = (jobs: Job[]) => ({ store: { jobs: { list: () => jobs } } }) as unknown as Pick<EngineContext, 'store'>;

describe('the waits whose agent ends (issue #2335)', () => {
  it('every wait type but a running command of the job', () => {
    const jobs = Object.entries(WAITS).map(([name, w]) => job(name, w));
    const own = [job('own command', { on: { kind: 'own_command' }, ownCommand: true }), job('own command, older', { ownCommand: true })];
    const released = waitSessionsOf(ctx([...jobs, ...own]), ['herdr-claude']).map((s) => s.jobId);
    expect(released).toEqual(Object.keys(WAITS));
  });
});
