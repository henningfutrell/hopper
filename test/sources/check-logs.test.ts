// The GitHub source's read of failed checks' logs (issue #993): each GitHub Actions job's log is read once — a finished
// job's log does not change, so it is kept per run —, trimmed, and put on its failed check; a log GitHub refuses says why.
import { describe, expect, it } from 'vitest';
import { createCheckLogs, MAX_KEPT_LOGS } from '../../src/sources/github/check-logs.ts';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { createFakeGitHub } from '../../src/sources/index.ts';

const REPO = 'owner/repo';
const job = (id: number) => `https://github.com/${REPO}/actions/runs/18/job/${id}`;

describe('the read of failed checks\' logs (issue #993)', () => {
  it('reads each Actions job\'s log once, trims it, and keeps the rest of the check', async () => {
    const gh = createFakeGitHub();
    gh.setJobLog(REPO, 42, '2026-10-13T10:00:02.0000000Z Error: the store is closed\n');
    const logs = createCheckLogs(gh);
    const failed = [{ name: 'test (6)', url: job(42), reported: ['a.ts:1: x'] }, { name: 'ci/external', url: 'https://ci.example.org/build/3' }, { name: 'lint' }];
    const read = await logs.read(failed);
    expect(read).toEqual([{ name: 'test (6)', url: job(42), reported: ['a.ts:1: x'], log: ['Error: the store is closed'] }, failed[1], failed[2]]);
    expect(await logs.read(failed)).toEqual(read);
    expect(gh.calls.filter((c) => c.method === 'jobLog')).toEqual([{ method: 'jobLog', args: [REPO, 42] }]);
  });

  it('a log GitHub refuses: why, on its check; a transient failure is asked again next time', async () => {
    const gh = createFakeGitHub();
    gh.setJobLog(REPO, 42, new GitHubApiError('Not Found', true, 404));
    gh.setJobLog(REPO, 43, new GitHubApiError('socket hang up', false));
    const logs = createCheckLogs(gh);
    expect(await logs.read([{ name: 'a', url: job(42) }, { name: 'b', url: job(43) }])).toEqual([
      { name: 'a', url: job(42), logError: 'GitHub has no log for it (404: Not Found): the log expired, or the run was deleted.' },
      { name: 'b', url: job(43), logError: 'GitHub did not answer: socket hang up.' },
    ]);
    gh.setJobLog(REPO, 43, 'Error: now it reads');
    expect(await logs.read([{ name: 'a', url: job(42) }, { name: 'b', url: job(43) }])).toEqual([
      { name: 'a', url: job(42), logError: 'GitHub has no log for it (404: Not Found): the log expired, or the run was deleted.' },
      { name: 'b', url: job(43), log: ['Error: now it reads'] },
    ]);
    expect(gh.calls.filter((c) => c.method === 'jobLog').map((c) => c.args[1])).toEqual([42, 43, 43]);
  });

  it('a port that cannot read logs leaves the checks as they are', async () => {
    const gh = createFakeGitHub();
    const { jobLog: _no, ...api } = gh;
    expect(await createCheckLogs(api).read([{ name: 'a', url: job(42) }])).toEqual([{ name: 'a', url: job(42) }]);
  });

  it(`keeps at most ${MAX_KEPT_LOGS} logs`, async () => {
    const gh = createFakeGitHub();
    for (let i = 0; i <= MAX_KEPT_LOGS; i++) gh.setJobLog(REPO, i, `Error: ${i}`);
    const logs = createCheckLogs(gh);
    for (let i = 0; i <= MAX_KEPT_LOGS; i++) await logs.read([{ name: 'a', url: job(i) }]);
    await logs.read([{ name: 'a', url: job(0) }]);
    await logs.read([{ name: 'a', url: job(MAX_KEPT_LOGS) }]);
    expect(gh.calls.filter((c) => c.method === 'jobLog' && (c.args[1] === 0 || c.args[1] === MAX_KEPT_LOGS)).map((c) => c.args[1])).toEqual([0, MAX_KEPT_LOGS, 0]);
  });
});
