// The shrink guard (issue #1096, design.md "The shrink guard"), through git's way to the hopper (issue #652): a job's push
// that brings in its branch's base and empties or shrinks a file the branch's own change did not is refused.
//
// Feature: the shrink guard
//   Scenario: a rebase onto dev that empties a file the pull request only edited (issue #1096, the shrink guard)
//     Then the push is refused with the file named, nothing changes on GitHub, and the refusal is on its timeline
//     And a resolution that keeps the lines of both sides goes through
//     And a job that ends with its last push refused ends failed, not done
//   Scenario: the pull request's own change empties the file
//     Then the rebase that keeps it empty goes through
//   Scenario: a rebase renames a file the pull request added, as dev took its number (issue #2225)
//     Then the push goes through, and a push that empties dev's file of that number is still refused
//   Scenario: a rebase onto main, the pull request's base, while main shrank a file dev still has whole (issue #1147)
//     Given a repository whose default branch is dev, and a pull request into main
//     Then the guard compares the push with main: the rebase goes through, and a push that empties the file is refused
//   Scenario: a branch with no pull request, in a repository with landing batches (issue #1147)
//     Then the guard compares the push with the landing branch, main: a push that empties the file is refused, the rebase goes through
//   Scenario: an admin sets the guard's percent (Settings → Shrink guard)
//     Then a push that takes more than that percent of a file's lines is refused, and the change is recorded
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { branchesOf, eventsOf, linesOf, run, running, seedCommit, start, stopGitProxies, type Started } from '../support/git-proxy.ts';

afterEach(stopGitProxies);

// Each test clones and pushes through the guard: about 10 s apiece on a loaded CI shard, past 15 s at times.
describe('the shrink guard (issue #1096)', { timeout: 60_000 }, () => {
  /** dev with a 200-line design; the job's branch issue-7 edits it (or `own` instead); then dev moves on to 220 lines. */
  async function branchThenDevMoves(t: Started, own: string = linesOf(201)) {
    await seedCommit(t, 'octo/tools', 'dev', { 'docs/design.md': linesOf(200) });
    const r = await running(t);
    expect((await r.git(['clone', '--quiet', `${t.github.url}/octo/tools.git`, 'tools'])).code).toBe(0);
    const work = join(r.home, 'tools');
    writeFileSync(join(work, 'docs/design.md'), own);
    await r.git(['commit', '--quiet', '-am', 'Edit the design'], work);
    expect((await r.git(['push', '--quiet', 'origin', 'HEAD:refs/heads/issue-7'], work)).code).toBe(0);
    await seedCommit(t, 'octo/tools', 'dev', { 'docs/design.md': linesOf(220) });
    expect((await r.git(['fetch', '--quiet', 'origin'], work)).code).toBe(0);
    return { ...r, work };
  }

  /** The job's resolution on dev's tip, `design` as docs/design.md, pushed over issue-7 with a lease. */
  async function resolve(r: Awaited<ReturnType<typeof branchThenDevMoves>>, design: string) {
    await r.git(['checkout', '--quiet', '-B', 'tended', 'origin/dev'], r.work);
    writeFileSync(join(r.work, 'docs/design.md'), design);
    await r.git(['commit', '--quiet', '--allow-empty', '-am', 'Resolve'], r.work);
    return r.git(['push', '--force-with-lease=issue-7:origin/issue-7', 'origin', 'HEAD:refs/heads/issue-7'], r.work);
  }

  it('refuses a rebase that empties a file the pull request only edited, then takes one that keeps both sides', async () => {
    const t = await start();
    const r = await branchThenDevMoves(t);
    const before = (await branchesOf(t, 'octo/tools')).stdout;

    const blanked = await resolve(r, '');
    expect(blanked.code).not.toBe(0);
    expect(blanked.stderr).toContain('the shrink guard refused this push');
    expect(blanked.stderr).toContain('docs/design.md (220 lines on dev, 0 after)');
    expect((await branchesOf(t, 'octo/tools')).stdout).toBe(before);
    expect(eventsOf(t.app, 'github_proxy.refused')).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: r.job.id, data: expect.objectContaining({ op: 'git.push', refs: ['refs/heads/issue-7'], shrunk: [{ path: 'docs/design.md', from: 220, to: 0, against: 'base' }] }) }),
    ]));

    expect(await resolve(r, linesOf(221))).toMatchObject({ code: 0 });
    t.held.get(r.job.id)!.end();
    await t.app.waitForStatus(r.job.id, 'finished');
  });

  it('a job that ends with its last push refused by the guard ends failed, saying so', async () => {
    const t = await start();
    const r = await branchThenDevMoves(t);
    expect((await resolve(r, '')).code).not.toBe(0);
    t.held.get(r.job.id)!.end();
    const ended = await t.app.waitForStatus(r.job.id, 'failed');
    expect(JSON.stringify(ended)).toContain('the shrink guard refused its last push, which emptied or shrank docs/design.md');
  });

  it('the percent is an admin\'s setting: 50 by default, recorded when it changes, read at the next push', async () => {
    const t = await start();
    expect((await t.app.api('GET', '/api/shrink-guard')).body).toEqual({ percent: 50 });
    expect((await t.app.ui('/ui/api/shrink-guard', { percent: 20 })).status).toBe(403);
    const token = await t.app.login();
    for (const percent of [0, 101, 2.5]) expect((await t.app.ui('/ui/api/shrink-guard', { percent }, { token })).status).toBe(400);
    expect((await t.app.ui('/ui/api/shrink-guard', { percent: 50 }, { token })).status).toBe(200);
    expect(eventsOf(t.app, 'shrink_guard.changed')).toEqual([]);

    const r = await branchThenDevMoves(t);
    expect(await t.app.ui('/ui/api/shrink-guard', { percent: 20 }, { token })).toMatchObject({ status: 200, body: { percent: 20 } });
    expect(eventsOf(t.app, 'shrink_guard.changed')).toEqual([expect.objectContaining({ data: expect.objectContaining({ from: { percent: 50 }, to: { percent: 20 } }) })]);
    // 220 lines on dev to 150: 32% lost, over 20%.
    const refused = await resolve(r, linesOf(150));
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('docs/design.md (220 lines on dev, 150 after)');
    // Under the default, it goes through.
    await t.app.ui('/ui/api/shrink-guard', { percent: 50 }, { token });
    expect(await resolve(r, linesOf(150))).toMatchObject({ code: 0 });
  });

  it('takes a rebase that keeps the file the pull request itself emptied', async () => {
    const t = await start();
    const r = await branchThenDevMoves(t, '');
    expect(await resolve(r, '')).toMatchObject({ code: 0 });
  });

  it('takes a rebase that renames a file the pull request added, and still refuses one that empties dev\'s (issue #2225)', async () => {
    const t = await start();
    await seedCommit(t, 'octo/tools', 'dev', { 'docs/design.md': linesOf(200) });
    const r = await running(t);
    expect((await r.git(['clone', '--quiet', `${t.github.url}/octo/tools.git`, 'tools'])).code).toBe(0);
    const work = join(r.home, 'tools');
    mkdirSync(join(work, 'docs/adrs'));
    writeFileSync(join(work, 'docs/adrs/ADR-0019-dashboard.md'), linesOf(98));
    await r.git(['add', '.'], work);
    await r.git(['commit', '--quiet', '-m', 'Add ADR 19'], work);
    expect((await r.git(['push', '--quiet', 'origin', 'HEAD:refs/heads/issue-7'], work)).code).toBe(0);
    await seedCommit(t, 'octo/tools', 'dev', { 'docs/adrs/ADR-0019-kotlin.md': linesOf(120) });
    expect((await r.git(['fetch', '--quiet', 'origin'], work)).code).toBe(0);
    const rebase = async (kotlin: string) => {
      await r.git(['checkout', '--quiet', '-B', 'tended', 'origin/dev'], work);
      writeFileSync(join(work, 'docs/adrs/ADR-0020-dashboard.md'), linesOf(98));
      writeFileSync(join(work, 'docs/adrs/ADR-0019-kotlin.md'), kotlin);
      await r.git(['add', '.'], work);
      await r.git(['commit', '--quiet', '-m', 'Add ADR 20'], work);
      return r.git(['push', '--force-with-lease=issue-7:origin/issue-7', 'origin', 'HEAD:refs/heads/issue-7'], work);
    };

    const blanked = await rebase('');
    expect(blanked.code).not.toBe(0);
    expect(blanked.stderr).toContain('docs/adrs/ADR-0019-kotlin.md (120 lines on dev, 0 after)');
    expect(blanked.stderr).not.toContain('ADR-0019-dashboard');

    expect(await rebase(linesOf(120))).toMatchObject({ code: 0 });
  }, 30_000); // a clone, three pushes through the guard and two rebases: past 15 s on a loaded CI runner

  /**
   * main from dev, with a 200-line design; the job's branch issue-7 off main edits notes.md; then dev moves on, main takes
   * dev and shrinks the design to 100 lines on purpose, which dev does not have.
   */
  async function branchThenMainShrinks(t: Started) {
    await seedCommit(t, 'octo/tools', 'dev', { 'docs/design.md': linesOf(200) });
    const bare = join(t.gitRoot, 'octo/tools.git');
    await run('git', ['--git-dir', bare, 'branch', 'main', 'dev']);
    const r = await running(t);
    expect((await r.git(['clone', '--quiet', '--branch', 'main', `${t.github.url}/octo/tools.git`, 'tools'])).code).toBe(0);
    const work = join(r.home, 'tools');
    writeFileSync(join(work, 'notes.md'), 'notes\n');
    await r.git(['add', 'notes.md'], work);
    await r.git(['commit', '--quiet', '-m', 'Add notes'], work);
    expect((await r.git(['push', '--quiet', 'origin', 'HEAD:refs/heads/issue-7'], work)).code).toBe(0);
    await seedCommit(t, 'octo/tools', 'dev', { 'other.md': 'other\n' });
    await run('git', ['--git-dir', bare, 'update-ref', 'refs/heads/main', 'refs/heads/dev']);
    await seedCommit(t, 'octo/tools', 'main', { 'docs/design.md': linesOf(100) });
    expect((await r.git(['fetch', '--quiet', 'origin'], work)).code).toBe(0);
    /** issue-7 rebased onto main's tip, `design` as docs/design.md, pushed with a lease. */
    const rebase = async (design = linesOf(100)) => {
      await r.git(['checkout', '--quiet', '-B', 'tended', 'origin/main'], work);
      writeFileSync(join(work, 'notes.md'), 'notes\n');
      writeFileSync(join(work, 'docs/design.md'), design);
      await r.git(['add', '.'], work);
      await r.git(['commit', '--quiet', '-m', 'Add notes'], work);
      return r.git(['push', '--force-with-lease=issue-7:origin/issue-7', 'origin', 'HEAD:refs/heads/issue-7'], work);
    };
    return { ...r, work, rebase };
  }

  it('compares a rebase with the pull request\'s base, not the default branch (issue #1147)', async () => {
    const t = await start();
    const r = await branchThenMainShrinks(t);
    const opened = await fetch(`${t.github.url}/api/v3/repos/octo/tools/pulls`, {
      method: 'POST', headers: { authorization: 'token test-account-token', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Add notes', body: 'Closes #7', head: 'issue-7', base: 'main' }),
    });
    expect(opened.status).toBe(201);

    const emptied = await r.rebase('');
    expect(emptied.code).not.toBe(0);
    expect(emptied.stderr).toContain('docs/design.md (100 lines on main, 0 after)');
    expect(await r.rebase()).toMatchObject({ code: 0 });
  });

  it('compares a branch with no pull request with the landing branch (issue #1147)', async () => {
    const t = await start();
    const token = await t.app.login();
    expect((await t.app.ui('/ui/api/landing-batches', { repos: { 'octo/tools': { tested: 'dev' } } }, { token })).status).toBe(200);
    const r = await branchThenMainShrinks(t);
    expect((await r.rebase('')).stderr).toContain('docs/design.md (100 lines on main, 0 after)');
    expect(await r.rebase()).toMatchObject({ code: 0 });
  });
});
