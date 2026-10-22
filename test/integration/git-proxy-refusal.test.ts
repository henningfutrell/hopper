// Issue #2481: a push the hopper cannot take as git sent it was answered a bare HTTP 403, which git shows as "RPC failed"
// with no reason. A push from a shallow clone sends `shallow` lines before its ref updates; a push whose pack is over
// git's `http.postBuffer` first sends a probe (a flush packet only), then the pack chunked. The daemon, store and HTTP edge
// are real; GitHub is a fake on loopback whose git is git's own `git-http-backend`; the job runs the real git.
//
// Feature: a push the hopper cannot take says why
//   Scenario: a job pushes from a shallow clone
//     Then git shows the hopper's refusal, `! [remote rejected]` with the reason, and nothing changes on GitHub
//   Scenario: a job pushes a pack bigger than git's post buffer
//     Then git's probe is answered, the pack goes to GitHub, and the branch is on GitHub
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { branchesOf, eventsOf, running, start, stopGitProxies } from '../support/git-proxy.ts';

afterEach(stopGitProxies);

describe('a push the hopper cannot take says why (issue #2481)', () => {
  it('a push from a shallow clone is refused with the reason, not a bare HTTP 403', async () => {
    const t = await start();
    const { job, home, git } = await running(t, 'octo/tools');
    expect((await git(['clone', '--quiet', '--depth', '1', `${t.github.url}/elsewhere/lib.git`, 'lib'])).code).toBe(0);
    const work = join(home, 'lib');
    writeFileSync(join(work, 'fix.txt'), 'fixed\n');
    await git(['add', '.'], work);
    await git(['commit', '--quiet', '-m', 'The change belongs here'], work);
    const r = await git(['push', 'origin', 'HEAD:refs/heads/feature/x'], work);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('refused: a push from a shallow clone is not taken: fetch the full history first');
    expect(r.stderr).not.toContain('RPC failed');
    expect((await branchesOf(t, 'elsewhere/lib')).stdout).not.toContain('feature/x');
    expect(eventsOf(t.app, 'github_proxy.refused')).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ repo: 'elsewhere/lib', refs: ['refs/heads/feature/x'], reason: expect.stringContaining('shallow clone') }) }),
    ]));
  });

  it('a push bigger than git\'s post buffer, sent chunked after a probe, goes to GitHub', async () => {
    const t = await start();
    const { job, home, git } = await running(t, 'octo/tools');
    expect((await git(['clone', '--quiet', `${t.github.url}/elsewhere/lib.git`, 'lib'])).code).toBe(0);
    const work = join(home, 'lib');
    writeFileSync(join(work, 'big.bin'), randomBytes(64 * 1024));
    await git(['add', '.'], work);
    await git(['commit', '--quiet', '-m', 'A big file'], work);
    const r = await git(['-c', 'http.postBuffer=4096', 'push', 'origin', 'HEAD:refs/heads/feature/big'], work);
    expect(r).toMatchObject({ code: 0 });
    const head = (await git(['rev-parse', 'HEAD'], work)).stdout.trim();
    expect((await branchesOf(t, 'elsewhere/lib')).stdout).toContain(`feature/big ${head}`);
    const pushes = eventsOf(t.app, 'github_proxy.done').filter((e) => e.jobId === job.id);
    expect(pushes).toEqual([expect.objectContaining({ data: expect.objectContaining({ repo: 'elsewhere/lib', refs: ['refs/heads/feature/big'] }) })]);
    expect(eventsOf(t.app, 'github_proxy.refused')).toEqual([]);
  });
});
