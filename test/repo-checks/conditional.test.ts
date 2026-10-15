// Issue #1250: a GET of a repository's checks is sent with the ETag of the answer kept for it (If-None-Match); GitHub's
// 304 is answered from what was kept, and what is kept is what the store keeps with the read, so it survives a restart.
import { describe, expect, it } from 'vitest';
import { conditionalAnswers } from '../../src/repo-checks/conditional.ts';

type Sent = { route: string; params: Record<string, unknown> };

function fakeGitHub(answer: (s: Sent) => { data: unknown; etag?: string } | { status: number }) {
  const sent: Sent[] = [];
  const req = async (route: string, params: Record<string, unknown>) => {
    const s = { route, params };
    sent.push(s);
    const a = answer(s);
    if ('status' in a) throw Object.assign(new Error(`status ${a.status}`), { status: a.status });
    return { data: a.data, headers: a.etag ? { etag: a.etag } : {} };
  };
  return { sent, req };
}

const headersOf = (s: Sent) => s.params.headers as Record<string, string>;

describe('conditionalAnswers', () => {
  it('keeps an answer with its ETag, sends it back, and answers a 304 from what was kept', async () => {
    const first = fakeGitHub(() => ({ data: { default_branch: 'dev' }, etag: '"a"' }));
    const one = conditionalAnswers();
    expect(await one.get(first.req, 'GET /repos/{owner}/{repo}', { owner: 'o', repo: 'r', headers: { authorization: 'token t1' } })).toEqual({ default_branch: 'dev' });
    expect(headersOf(first.sent[0]!)['if-none-match']).toBeUndefined();
    const kept = one.kept();

    // A new read, after a restart and with a renewed token: the same answer's key.
    const second = fakeGitHub(() => ({ status: 304 }));
    const two = conditionalAnswers(JSON.parse(JSON.stringify(kept)));
    expect(await two.get(second.req, 'GET /repos/{owner}/{repo}', { owner: 'o', repo: 'r', headers: { authorization: 'token t2' } })).toEqual({ default_branch: 'dev' });
    expect(headersOf(second.sent[0]!)).toEqual({ authorization: 'token t2', 'if-none-match': '"a"' });
    expect(two.kept()).toEqual(kept);
  });

  it('a changed answer replaces the one kept; an answer not asked again is dropped', async () => {
    const one = conditionalAnswers({ 'GET /a {}': { etag: '"old"', data: 1 }, 'GET /gone {}': { etag: '"g"', data: 0 } });
    const gh = fakeGitHub(() => ({ data: 2, etag: '"new"' }));
    expect(await one.get(gh.req, 'GET /a', {})).toBe(2);
    expect(one.kept()).toEqual({ 'GET /a {}': { etag: '"new"', data: 2 } });
  });

  it('any other refusal is thrown, and nothing is kept for it', async () => {
    const one = conditionalAnswers({ 'GET /a {}': { etag: '"old"', data: 1 } });
    const gh = fakeGitHub(() => ({ status: 404 }));
    await expect(one.get(gh.req, 'GET /a', {})).rejects.toMatchObject({ status: 404 });
    expect(one.kept()).toEqual({});
  });
});
