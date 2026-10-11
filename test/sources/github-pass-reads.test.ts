// The pass reads of a GitHub source (issue #822): inside one pass a read is asked of GitHub once; a write to a
// repository makes its next read go to GitHub again; outside a pass, and in the next pass, every read goes to GitHub.
import { describe, expect, it } from 'vitest';
import { GitHubApiError } from '../../src/sources/github/api.ts';
import { createFakeGitHub } from '../../src/sources/index.ts';
import { passReads } from '../../src/sources/github/pass-reads.ts';

const REPO = 'owner/repo';
const OTHER = 'owner/other';
const asked = (gh: ReturnType<typeof createFakeGitHub>, method: string) => gh.calls.filter((c) => c.method === method).length;

describe('pass reads (issue #822)', () => {
  it('inside a pass, the same read is asked once, two reads at the same time included', async () => {
    const gh = createFakeGitHub();
    const issue = gh.createIssue({ repo: REPO, body: 'b', labels: ['hopper'] });
    const r = passReads(gh);
    await r.pass(async () => {
      const [a, b] = await Promise.all([r.api.getIssue(REPO, issue.number), r.api.getIssue(REPO, issue.number)]);
      expect(b).toEqual(a);
      await r.api.getIssue(REPO, issue.number);
    });
    expect(asked(gh, 'getIssue')).toBe(1);
  });

  it('a write to a repository makes its next read go to GitHub; another repository keeps its reads', async () => {
    const gh = createFakeGitHub();
    const issue = gh.createIssue({ repo: REPO, body: 'b', labels: ['hopper'] });
    const other = gh.createIssue({ repo: OTHER, body: 'b', labels: ['hopper'] });
    const r = passReads(gh);
    await r.pass(async () => {
      await r.api.getIssue(REPO, issue.number);
      await r.api.getIssue(OTHER, other.number);
      await r.api.removeLabels(REPO, issue.number, ['hopper']);
      expect((await r.api.getIssue(REPO, issue.number)).labels).not.toContain('hopper');
      await r.api.getIssue(OTHER, other.number);
    });
    expect(gh.calls.filter((c) => c.method === 'getIssue').map((c) => c.args[0])).toEqual([REPO, OTHER, REPO]);
  });

  it('outside a pass, and in the next pass, every read goes to GitHub', async () => {
    const gh = createFakeGitHub();
    const issue = gh.createIssue({ repo: REPO, body: 'b', labels: ['hopper'] });
    const r = passReads(gh);
    await r.api.getIssue(REPO, issue.number);
    await r.api.getIssue(REPO, issue.number);
    await r.pass(() => r.api.getIssue(REPO, issue.number));
    await r.pass(() => r.api.getIssue(REPO, issue.number));
    expect(asked(gh, 'getIssue')).toBe(4);
  });

  it('a read that failed is not kept: it is asked again in the same pass', async () => {
    const gh = createFakeGitHub();
    const issue = gh.createIssue({ repo: REPO, body: 'b', labels: ['hopper'] });
    gh.failNext('getIssue', new GitHubApiError('get: timeout', false));
    const r = passReads(gh);
    await r.pass(async () => {
      await expect(r.api.getIssue(REPO, issue.number)).rejects.toThrow('timeout');
      expect((await r.api.getIssue(REPO, issue.number)).number).toBe(issue.number);
    });
    expect(asked(gh, 'getIssue')).toBe(2);
  });

  it('keeps an adapter without the optional reads without them', () => {
    const gh = createFakeGitHub();
    expect(passReads(gh).api.botLogin).toBeUndefined();
    expect(passReads(gh).api.listInstalledRepos).toBeUndefined();
    expect(passReads(gh).api.listAssignedIssues).toBeTypeOf('function');
  });
});
