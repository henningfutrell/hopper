// Issue #429: what the contribution flow lets a job ask, pure — forking its own repository when its user cannot push to
// it, a pull request on that repository from the user's fork, issues and reads on the job's fork; each only while the
// user's Contribution is on — and the steps the hopper answers a fork with. The whole path is
// test/integration/contribution.test.ts.
import { describe, expect, it } from 'vitest';
import { checkRequest, CONTRIBUTION_OFF, contributionSteps, proxyRequest, type ProxyAsker, type ProxyRequest } from '../../src/github-proxy/index.ts';

const repos = ['upstream/lib'];
const asker: ProxyAsker = { jobId: 'j', own: true, repo: 'upstream/lib', issue: 7, contribution: true, login: 'owner' };
const req = (r: Record<string, unknown>): ProxyRequest => proxyRequest.parse(r);
const pr = (head: string, repo = 'upstream/lib') => req({ op: 'pr.create', repo, head, title: 't', body: 'b' });
const why = (r: ReturnType<typeof checkRequest>) => (r.ok ? 'ok' : r.reason);

describe('the contribution flow\'s policy (issue #429)', () => {
  it('takes a pull request head of a fork, owner:branch, and the repository reads and forks', () => {
    expect(pr('owner:fix/empty').op).toBe('pr.create');
    expect(proxyRequest.safeParse({ op: 'pr.create', repo: 'upstream/lib', head: 'a:b:c', title: 't', body: 'b' }).success).toBe(false);
    expect(req({ op: 'repo.view', repo: 'upstream/lib' })).toEqual({ op: 'repo.view', repo: 'upstream/lib' });
    expect(proxyRequest.safeParse({ op: 'repo.fork', repo: 'upstream/lib', owner: 'x' }).success).toBe(false);
  });

  it('forks only the job\'s own repository, only with Contribution on, only when its user cannot push to it', () => {
    const fork = req({ op: 'repo.fork', repo: 'upstream/lib' });
    expect(checkRequest(fork, { ...asker, canPush: false }, repos)).toEqual({ ok: true });
    expect(why(checkRequest(fork, { ...asker, canPush: true }, repos))).toBe('your user can push to upstream/lib: push a branch there, with no fork');
    expect(why(checkRequest(fork, { ...asker, contribution: false, canPush: false }, repos))).toBe(CONTRIBUTION_OFF);
    expect(why(checkRequest(req({ op: 'repo.fork', repo: 'octo/x' }), { ...asker, canPush: false }, [...repos, 'octo/x']))).toBe('a job forks only its own repository (upstream/lib)');
    expect(why(checkRequest(fork, { ...asker, own: false }, repos))).toMatch(/^a job of another user may only file an issue/);
  });

  it('opens a pull request from a fork only from its user\'s own, on the job\'s repository, with Contribution on', () => {
    expect(checkRequest(pr('owner:fix/empty'), asker, repos)).toEqual({ ok: true });
    expect(checkRequest(pr('Owner:fix/empty'), asker, repos)).toEqual({ ok: true });
    expect(why(checkRequest(pr('someone:fix/empty'), asker, repos))).toBe('a job opens a pull request from a fork only from its user\'s own (owner), not someone');
    expect(why(checkRequest(pr('owner:fix/empty'), { ...asker, contribution: false }, repos))).toBe(CONTRIBUTION_OFF);
    expect(checkRequest(pr('fix/empty'), { ...asker, contribution: false }, repos)).toEqual({ ok: true });
  });

  it('on the job\'s fork: issues and reads; its pull request goes on the job\'s repository; nothing on another repository', () => {
    const onFork = { ...asker, fork: 'owner/lib' };
    for (const r of [
      { op: 'issue.create', repo: 'owner/lib', title: 't', body: 'b' }, { op: 'issue.comment', repo: 'owner/lib', number: 1, body: 'b' },
      { op: 'issue.view', repo: 'owner/lib', number: 1 }, { op: 'pr.view', repo: 'owner/lib', number: 1 }, { op: 'repo.view', repo: 'owner/lib' },
    ]) expect(checkRequest(req(r), onFork, repos)).toEqual({ ok: true });
    expect(why(checkRequest(pr('fix/empty', 'owner/lib'), onFork, repos))).toBe('open the pull request on upstream/lib, from the fork: --repo upstream/lib --head owner:<branch>');
    expect(why(checkRequest(req({ op: 'issue.close', repo: 'owner/lib', number: 1 }), onFork, repos))).toMatch(/^on the job's fork owner\/lib a job files, reads and comments on issues/);
    expect(why(checkRequest(req({ op: 'issue.create', repo: 'owner/lib', title: 't', body: 'b' }), asker, repos))).toBe('owner/lib is not one of the repositories the hopper works on, so it does nothing there for a job');
  });

  it('the steps: clone the fork, follow the contributing rules, push there, the pull request upstream; where the issue goes', () => {
    const steps = contributionSteps('upstream/lib', 'owner/lib', 'https://github.com/owner/lib', 'owner', 'upstream/lib');
    expect(steps).toContain('git clone https://github.com/owner/lib.git');
    expect(steps).toContain('CONTRIBUTING.md');
    expect(steps).toContain('PULL_REQUEST_TEMPLATE');
    expect(steps).toContain('CODE_OF_CONDUCT.md');
    expect(steps).toContain('--repo upstream/lib --head owner:<branch>');
    expect(steps).toContain('File an issue, when you need one, on upstream/lib.');
    expect(contributionSteps('upstream/lib', 'owner/lib', 'u', 'owner', 'owner/lib')).toContain('upstream/lib takes no issues: file an issue, when you need one, on owner/lib (--repo owner/lib)');
    expect(contributionSteps('upstream/lib', 'owner/lib', 'u', 'owner', undefined)).toContain('could not be turned on');
  });
});
