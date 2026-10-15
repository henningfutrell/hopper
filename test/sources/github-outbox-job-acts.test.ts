// Issue #1238, the last part: a person's act on a job — Merge now, Close PR, a give-back — shows on its job from its
// GitHub outbox row, as an intake item's write shows on its item. The source's detail says, per job, the act whose row is
// not sent: `running` (with the next `attempt` and the `error` of the try before while it waits its backoff), or `failed`
// with why. Once the row is sent, the job has no marker. An intake item's rows give no job a marker.
import { describe, expect, it } from 'vitest';
import { SourceError } from '../../src/domain/ports.ts';
import { jobActMarkers, type OutboxChange, type OutboxRow } from '../../src/domain/github-outbox.ts';
import { createGitHubOutbox, memoryGitHubOutbox } from '../../src/sources/github/outbox.ts';

const REPO = 'owner/hopper-sandbox';
const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const PAT = { person: 'Pat', via: 'ui' as const };

function counting(fail?: (change: OutboxChange) => Error | undefined) {
  let now = new Date('2026-10-15T10:00:00.000Z');
  const outbox = createGitHubOutbox({ source: 'github', rows: memoryGitHubOutbox(), clock: { now: () => now } });
  const send = async (_repo: string, _key: string, change: OutboxChange) => { const e = fail?.(change); if (e) throw e; };
  return { outbox, flush: () => outbox.flush(send), later: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const row = (id: number, change: OutboxChange, more: Partial<OutboxRow> = {}): OutboxRow => ({
  id, source: 'github', repo: REPO, key: url(1), act: change.op === 'pull_request' || change.op === 'give_back' ? change.act : 'assign', tag: '',
  change, state: 'pending', attempts: 0, nextAt: '2026-10-15T10:00:00.000Z', createdAt: '2026-10-15T10:00:00.000Z', ...more,
});

describe('the marker of a job act in the GitHub outbox (issue #1238)', () => {
  it('each job with a row not sent has its act: running, running with its next attempt, or failed with why', () => {
    expect(jobActMarkers([
      row(1, { op: 'pull_request', act: 'merge', jobId: 'j1', acting: PAT }),
      row(2, { op: 'give_back', act: 'rerun', jobId: 'j2' }, { attempts: 1, lastError: 'GitHub is out of reach' }),
      row(3, { op: 'give_back', act: 'tend', jobId: 'j3' }, { state: 'failed', attempts: 5, lastError: 'Not Found (HTTP 404)' }),
      row(4, { op: 'add_assignees', assignees: ['octo'] }),
    ])).toEqual({
      j1: { act: 'merge', state: 'running' },
      j2: { act: 'rerun', state: 'running', attempt: 2, error: 'GitHub is out of reach' },
      j3: { act: 'tend', state: 'failed', error: 'Not Found (HTTP 404)' },
    });
  });

  it('a failed row of a job wins over its other rows', () => {
    expect(jobActMarkers([
      row(1, { op: 'pull_request', act: 'close', jobId: 'j1', acting: PAT }, { state: 'failed', lastError: 'refused' }),
      row(2, { op: 'give_back', act: 'rerun', jobId: 'j1' }),
    ])).toEqual({ j1: { act: 'close', state: 'failed', error: 'refused' } });
  });

  it('the detail lists the job acts not sent, and none once they went through', async () => {
    let error: Error | undefined = new SourceError('Pull Request is not mergeable (HTTP 405)', true, 405);
    const { outbox, flush } = counting(() => error);
    outbox.pullRequestAct(url(1), REPO, 'merge', 'j1', PAT);
    outbox.giveBackAct(url(2), REPO, 'rerun', 'j2', PAT);
    outbox.queue('assign', url(3), REPO, [{ change: { op: 'add_assignees', assignees: ['octo'] } }]);
    expect(outbox.detail().jobActs).toEqual({ j1: { act: 'merge', state: 'running' }, j2: { act: 'rerun', state: 'running' } });
    await flush();
    expect(outbox.detail().jobActs).toEqual({ j1: { act: 'merge', state: 'failed', error: 'Pull Request is not mergeable (HTTP 405)' }, j2: { act: 'rerun', state: 'failed', error: 'Pull Request is not mergeable (HTTP 405)' } });
    error = undefined;
    outbox.pullRequestAct(url(1), REPO, 'merge', 'j1', PAT);
    outbox.giveBackAct(url(2), REPO, 'rerun', 'j2', PAT);
    await flush();
    expect(outbox.detail().jobActs).toBeUndefined();
  });
});
