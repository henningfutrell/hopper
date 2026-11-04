// Head branch deletion (issue #2914), one source over the in-memory fake GitHub: a merged job pull request's row deletes its
// head branch, and a kept branch stays; the sweep finds stale merged and closed branches and skips one with commits after
// the merge; a row a stopped hopper left, or a failed call, ends with no branch.
import { describe, expect, it, vi } from 'vitest';
import { HEAD_BRANCH_GRACE_MS } from '../../src/domain/head-branches.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { createHeadBranches } from '../../src/sources/github/head-branches.ts';
import { createGitHubOutbox, memoryGitHubOutbox, outboxSend } from '../../src/sources/github/outbox.ts';

const REPO = 'owner/repo';
const OLD = '2026-11-01T00:00:00.000Z';

function world(on = true) {
  const gh: FakeGitHub = createFakeGitHub();
  let now = new Date(OLD).getTime() + HEAD_BRANCH_GRACE_MS;
  const clock = { now: () => new Date(now) };
  const rows = memoryGitHubOutbox();
  const events: [string, Record<string, unknown>][] = [];
  const open = (headRef: string, more: { base?: string; headOid?: string } = {}) => {
    const issue = gh.createIssue({ repo: REPO, body: 'Do it.' });
    return gh.openPullRequest(REPO, issue.number, { createdAt: OLD, headRef, headOid: `oid-${headRef}`, ...more }).url;
  };
  const make = (s: typeof on) => {
    const outbox = createGitHubOutbox({ source: 'github', rows, clock });
    const branches = createHeadBranches({ api: gh, outbox, clock, settings: () => ({ on: s, keep: ['landing'] }), record: (t, d) => { events.push([t, d]); } });
    return { outbox, branches, flush: () => outbox.flush(outboxSend(gh, async () => {}, async () => {}, undefined, branches.send)) };
  };
  return { gh, rows, events, open, ...make(on), again: () => make(on), later: (ms: number) => { now += ms; } };
}

describe('a merged pull request leaves no branch (issue #2914)', () => {
  it('its row deletes the head branch and records it once; a second merge record adds no row', async () => {
    const w = world();
    const url = w.open('hopper/1-fix');
    w.gh.mergePullRequest(url, OLD);
    w.branches.merged(url);
    w.branches.merged(url);
    expect(w.rows.open('github')).toHaveLength(1);
    expect(w.gh.hasBranch(REPO, 'hopper/1-fix')).toBe(true);
    await w.flush();
    expect(w.gh.hasBranch(REPO, 'hopper/1-fix')).toBe(false);
    expect(w.events).toEqual([['head_branch.deleted', { repo: REPO, branch: 'hopper/1-fix', pullRequest: url, head: 'oid-hopper/1-fix', via: 'merge', source: 'github' }]]);
    expect(w.outbox.of(url)).toBeUndefined();
    w.branches.merged(url);
    expect(w.rows.open('github')).toEqual([]);
  });

  it('with the setting off, it keeps no row; a row kept before the setting went off deletes nothing', async () => {
    const off = world(false);
    const a = off.open('hopper/1-fix');
    off.gh.mergePullRequest(a, OLD);
    off.branches.merged(a);
    expect(off.rows.open('github')).toEqual([]);
    off.rows.add([{ source: 'github', repo: REPO, key: a, act: 'head_branch', tag: '', change: { op: 'delete_head_branch', pullRequest: a, via: 'merge' } }], OLD);
    off.later(1000);
    await off.flush();
    expect(off.gh.hasBranch(REPO, 'hopper/1-fix')).toBe(true);
  });

  it('keeps a branch with commits after the merge, a protected one, one a fork owns, and one another open pull request needs', async () => {
    const w = world();
    const moved = w.open('moved'); w.gh.mergePullRequest(moved, OLD); w.gh.setBranch(REPO, 'moved', { tip: 'later' });
    const guarded = w.open('guarded'); w.gh.mergePullRequest(guarded, OLD); w.gh.setBranch(REPO, 'guarded', { protected: true });
    const forked = w.open('forked'); w.gh.setForkPull(forked); w.gh.mergePullRequest(forked, OLD);
    const head = w.open('stacked'); w.open('on-top', { base: 'stacked' }); w.gh.mergePullRequest(head, OLD);
    const twice = w.open('twice'); w.open('twice'); w.gh.mergePullRequest(twice, OLD);
    for (const u of [moved, guarded, forked, head, twice]) w.branches.merged(u);
    await w.flush();
    for (const b of ['moved', 'guarded', 'forked', 'stacked', 'twice']) expect(w.gh.hasBranch(REPO, b), b).toBe(true);
    expect(w.events).toEqual([]);
  });

  it('a call GitHub refuses for now is tried again until the branch is gone', async () => {
    const w = world();
    const url = w.open('hopper/2-fix');
    w.gh.mergePullRequest(url, OLD);
    w.branches.merged(url);
    w.gh.failNext('deleteBranch', new GitHubApiError('GitHub answered 502', false));
    await w.flush();
    expect(w.gh.hasBranch(REPO, 'hopper/2-fix')).toBe(true);
    w.later(5_000);
    await w.flush();
    expect(w.gh.hasBranch(REPO, 'hopper/2-fix')).toBe(false);
    expect(w.events).toHaveLength(1);
  });

  it('a row a stopped hopper left is sent by the next one, and a branch already gone ends it with no call', async () => {
    const w = world();
    const url = w.open('hopper/3-fix');
    w.gh.mergePullRequest(url, OLD);
    w.branches.merged(url);
    // Stopped once GitHub took the delete, before the row was sent.
    w.rows.claim('github', new Date(0).toISOString().replace('1970', '2030'), new Date(new Date(OLD).getTime() + HEAD_BRANCH_GRACE_MS + 1000).toISOString());
    await w.gh.deleteBranch!(REPO, 'hopper/3-fix');
    const calls = () => w.gh.calls.filter((c) => c.method === 'deleteBranch').length;
    w.later(2000);
    await w.again().flush();
    expect(calls()).toBe(1);
    expect(w.rows.open('github')).toEqual([]);
  });
});

describe('the sweep (issue #2914)', () => {
  it('removes stale merged and closed branches, and skips commits after the merge, open pull requests and long-lived branches', async () => {
    const w = world();
    const merged = w.open('stale-merged'); w.gh.mergePullRequest(merged, OLD);
    const closed = w.open('stale-closed'); w.gh.closePullRequest(closed, OLD);
    const moved = w.open('moved'); w.gh.mergePullRequest(moved, OLD); w.gh.setBranch(REPO, 'moved', { tip: 'later' });
    w.open('still-open');
    const landing = w.open('landing'); w.gh.mergePullRequest(landing, OLD);
    const main = w.open('dev'); w.gh.mergePullRequest(main, OLD);
    await w.branches.sweep([REPO], { live: () => false });
    await w.flush();
    expect(w.gh.hasBranch(REPO, 'stale-merged')).toBe(false);
    expect(w.gh.hasBranch(REPO, 'stale-closed')).toBe(false);
    for (const b of ['moved', 'still-open', 'landing', 'dev']) expect(w.gh.hasBranch(REPO, b), b).toBe(true);
    expect(w.events.map(([, d]) => d.via)).toEqual(['sweep', 'sweep']);
  });

  it('skips a pull request a live job names, and a pull request that ended within the grace', async () => {
    const w = world();
    const live = w.open('live'); w.gh.mergePullRequest(live, OLD);
    const fresh = w.open('fresh'); w.gh.mergePullRequest(fresh, new Date(new Date(OLD).getTime() + HEAD_BRANCH_GRACE_MS - 1000).toISOString());
    await w.branches.sweep([REPO], { live: (u) => u === live });
    expect(w.rows.open('github')).toEqual([]);
  });

  it('with the setting off, reads nothing; run twice, keeps one row per pull request', async () => {
    const off = world(false);
    await off.branches.sweep([REPO], { live: () => false });
    expect(off.gh.calls.filter((c) => c.method === 'branchRefs')).toEqual([]);
    const w = world();
    const url = w.open('a'); w.gh.mergePullRequest(url, OLD);
    await w.branches.sweep([REPO], { live: () => false });
    await w.branches.sweep([REPO], { live: () => false });
    expect(w.rows.open('github')).toHaveLength(1);
  });

  it('keeps at most its limit of rows in one pass, and walks every page; one repository that fails does not stop the next', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = world();
    for (let i = 0; i < 3; i++) w.gh.mergePullRequest(w.open(`b${i}`), OLD);
    w.gh.failNext('branchRefs', new GitHubApiError('GitHub answered 502', false));
    await w.branches.sweep(['owner/broken', REPO], { live: () => false }, 2);
    expect(w.rows.open('github')).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
