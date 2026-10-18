// Issue #1734: who may edit or close a pull request through the hopper, and the request it takes. The whole path through
// the daemon is test/integration/github-proxy-pr-edit.test.ts.
import { describe, expect, it } from 'vitest';
import { checkRequest, proxyRequest, type ProxyRequest } from '../../src/github-proxy/index.ts';

describe('a pull request edit or close (issue #1734)', () => {
  const repos = ['octo/tools'];
  const edit: ProxyRequest = { op: 'pr.edit', repo: 'octo/tools', number: 8, body: 'b' };
  const close: ProxyRequest = { op: 'pr.close', repo: 'octo/tools', number: 8 };

  it('takes a title, a body or both; never neither, and nothing else', () => {
    expect(proxyRequest.parse({ op: 'pr.edit', repo: 'o/r', number: '8', title: 't' })).toEqual({ op: 'pr.edit', repo: 'o/r', number: 8, title: 't' });
    expect(proxyRequest.parse({ op: 'pr.edit', repo: 'o/r', number: '8', body: 'b' })).toEqual({ op: 'pr.edit', repo: 'o/r', number: 8, body: 'b' });
    expect(proxyRequest.safeParse({ op: 'pr.edit', repo: 'o/r', number: 8 }).success).toBe(false);
    expect(proxyRequest.safeParse({ op: 'pr.edit', repo: 'o/r', number: 8, body: 'b', base: 'main' }).success).toBe(false);
    expect(proxyRequest.safeParse({ op: 'pr.close', repo: 'o/r', number: 8, comment: 'x' }).success).toBe(false);
  });

  it('a job edits or closes only a pull request it opened or its work item\'s, on any repository (issue #1806)', () => {
    const owns = { jobId: 'j', repo: 'octo/tools', ownsPullRequest: true };
    expect(checkRequest(edit, owns, repos)).toEqual({ ok: true });
    expect(checkRequest(close, owns, repos)).toEqual({ ok: true });
    for (const req of [edit, close]) {
      expect(checkRequest(req, { jobId: 'j', repo: 'octo/tools' }, repos))
        .toEqual({ ok: false, reason: 'a job edits or closes only a pull request it opened, or the pull request of its own work item: not octo/tools#8' });
      expect(checkRequest({ ...req, repo: 'else/where' }, owns, repos)).toEqual({ ok: true });
      expect(checkRequest({ ...req, repo: 'else/where' }, { jobId: 'j', repo: 'octo/tools' }, repos)).toMatchObject({ ok: false });
    }
  });
});

describe('a job writes no comment command (issue #655, part 21)', () => {
  it('refuses a comment whose first line is /hopper run, research or propose', () => {
    const asker = { jobId: 'j', repo: 'octo/tools' };
    for (const body of ['/hopper run', '  /hopper research\nwhy', '/Hopper PROPOSE']) {
      expect(checkRequest({ op: 'issue.comment', repo: 'octo/tools', number: 8, body }, asker, ['octo/tools']))
        .toEqual({ ok: false, reason: 'a job writes no comment command (/hopper run, research or propose): only a person nominates an issue' });
    }
    expect(checkRequest({ op: 'issue.comment', repo: 'octo/tools', number: 8, body: 'Ran `/hopper run` here.' }, asker, ['octo/tools'])).toEqual({ ok: true });
  });
});
