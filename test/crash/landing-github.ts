// The landing batches' GitHub for the crash harness (issue #1954, design.md "The crash harness" part 8): a node:http fake
// of the REST and GraphQL calls of `src/landing-batches/github.ts`, in the test process, so what it holds outlives the
// hopper that called it. One repository: a linear landing branch of merge commits, the tested branch, `canary` and
// `stable`; pull requests (a second open one from one head into one base is refused, as GitHub does), issues, check runs
// that fail on the shas the test names, GitHub's revert (a new pull request each time it is asked) and its merge of a
// branch into another. Every write is counted, in order, so a test knows what a clean run writes.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readBody, send } from '../support/fake-http.ts';

export const LANDING_REPO = 'owner/hopper-sandbox';

/** A 40-character sha made from `of`, as GitHub's are. */
export const shaOf = (of: string): string => createHash('sha1').update(of).digest('hex');

export interface LandingCommit { sha: string; message: string }
export interface LandingPull {
  number: number; head: string; base: string; title: string; body: string; headSha: string;
  state: 'open' | 'closed'; merged: boolean; mergeSha?: string;
}
export interface LandingIssue { number: number; title: string; labels: string[]; assignees: string[] }

export interface LandingGitHub {
  url: string;
  /** The landing branch's commits, oldest first: its tip is the last. */
  commits: LandingCommit[];
  branches: Map<string, string>;
  pulls: Map<number, LandingPull>;
  issues: LandingIssue[];
  /** The shas whose check runs fail; every other sha's pass. */
  failing: Set<string>;
  /** The heads whose pull requests have merge conflicts with their base. */
  conflicting: Set<string>;
  /** What GitHub's merge of a branch into another does. */
  mergeInto: 'merged' | 'conflict';
  /** The bug reports the search finds. */
  reports: number[];
  /** Each write asked, in order, as the landing batches' GitHub names it (`openPullRequest`, `merge`, …), refused or not. */
  writes: string[];
  close(): Promise<void>;
}

/** The landing branch, `main`, and the tested branch, `dev`. */
export const LANDING = 'main';
export const TESTED = 'dev';

export async function createLandingGitHub(o: { commits: LandingCommit[]; merged: { number: number; sha: string }[] }): Promise<LandingGitHub> {
  const base = shaOf('base');
  const g: Omit<LandingGitHub, 'url' | 'close'> = {
    commits: [...o.commits], branches: new Map([[LANDING, o.commits.at(-1)?.sha ?? base], [TESTED, base], ['stable', base], ['canary', base]]),
    pulls: new Map(o.merged.map((m) => [m.number, {
      number: m.number, head: `issue-${m.number}`, base: LANDING, title: `Change ${m.number}`, body: `Closes #${m.number - 10}`,
      headSha: shaOf(`head-${m.number}`), state: 'closed' as const, merged: true, mergeSha: m.sha,
    }])),
    issues: [], failing: new Set(), conflicting: new Set(), mergeInto: 'merged', reports: [], writes: [],
  };
  let next = 100;
  const html = (n: number): string => `https://github.com/${LANDING_REPO}/pull/${n}`;
  const pullJson = (p: LandingPull) => ({
    number: p.number, node_id: `PR_${p.number}`, html_url: html(p.number), title: p.title, body: p.body, state: p.state, merged: p.merged,
    mergeable: !g.conflicting.has(p.head), head: { ref: p.head, sha: p.headSha }, base: { ref: p.base }, merge_commit_sha: p.mergeSha ?? null,
  });
  /** The commits of the landing branch after `from` (a branch or a sha) up to `to` (a sha). */
  const between = (from: string, to: string): LandingCommit[] => {
    const at = g.branches.get(from) ?? from;
    const start = g.commits.findIndex((c) => c.sha === at) + 1;
    const end = g.commits.findIndex((c) => c.sha === to);
    return end < start ? [] : g.commits.slice(start, end + 1);
  };
  const open = (p: Omit<LandingPull, 'number' | 'state' | 'merged'>): LandingPull => {
    const pull: LandingPull = { ...p, number: next++, state: 'open', merged: false };
    g.pulls.set(pull.number, pull);
    return pull;
  };
  /** A merge onto `branch`: the landing branch takes a merge commit; any other branch moves to the head. */
  const land = (branch: string, n: number, head: string): string => {
    if (branch !== LANDING) { g.branches.set(branch, head); return shaOf(`merge-${n}`); }
    const c = { sha: shaOf(`landed-${n}`), message: `Merge pull request #${n} from owner/${g.pulls.get(n)?.head ?? 'x'}` };
    g.commits.push(c);
    g.branches.set(LANDING, c.sha);
    return c.sha;
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://fake');
    const path = decodeURIComponent(u.pathname.replace(/^\/api\/v3(?=\/)/, ''));
    const q = Object.fromEntries(u.searchParams);
    const body = await readBody(req);
    const route = `${req.method} ${path}`;
    const write = (what: string): void => { g.writes.push(what); };
    const repo = `/repos/${LANDING_REPO}`;
    let m: RegExpExecArray | null;
    if (route === 'POST /graphql' && !String(body.query).includes('revertPullRequest')) return send(res, 200, { errors: [{ message: 'not in this fake' }] });
    if (route === 'POST /graphql') {
      // GitHub's revertPullRequest: a new pull request into the reverted one's base, each time it is asked.
      const v = body.variables as { id: string; title: string; body: string };
      const of = g.pulls.get(Number(v.id.replace('PR_', '')))!;
      write('revert');
      const r = open({ head: `revert-${of.number}-${next}`, base: of.base, title: v.title, body: v.body, headSha: shaOf(`revert-${of.number}-${next}`) });
      return send(res, 200, { data: { revertPullRequest: { revertPullRequest: { number: r.number, url: html(r.number) } } } });
    }
    if (route === 'GET /search/issues') return send(res, 200, { items: g.reports.map((number) => ({ number })) });
    if (!path.startsWith(`${repo}/`)) return send(res, 404, { message: 'Not Found' });
    const rest = `${req.method} ${path.slice(repo.length)}`;
    if ((m = /^GET \/git\/ref\/heads\/(.+)$/.exec(rest))) {
      const sha = g.branches.get(m[1]!);
      return sha ? send(res, 200, { object: { sha } }) : send(res, 404, { message: 'Not Found' });
    }
    if (rest === 'POST /git/refs') {
      const name = String(body.ref).replace('refs/heads/', '');
      if (g.branches.has(name)) return send(res, 422, { message: 'Reference already exists' });
      write('createBranch');
      g.branches.set(name, String(body.sha));
      return send(res, 201, { ref: body.ref });
    }
    if ((m = /^PATCH \/git\/refs\/heads\/(.+)$/.exec(rest))) {
      write(body.force === false ? 'fastForward' : 'createBranch');
      g.branches.set(m[1]!, String(body.sha));
      return send(res, 200, {});
    }
    if ((m = /^DELETE \/git\/refs\/heads\/(.+)$/.exec(rest))) {
      write('deleteBranch');
      if (!g.branches.delete(m[1]!)) return send(res, 422, { message: 'Reference does not exist' });
      // GitHub closes the open pull requests from a branch it removes.
      for (const p of g.pulls.values()) if (p.state === 'open' && p.head === m[1]) p.state = 'closed';
      return send(res, 204, undefined);
    }
    if ((m = /^GET \/compare\/(.+)\.\.\.(.+)$/.exec(rest))) {
      const [from, to] = [m[1]!, g.branches.get(m[2]!) ?? m[2]!];
      // `stable` and `canary` are apart from the landing branch: one commit ahead, or none.
      if (from === 'stable') return send(res, 200, { ahead_by: g.branches.get('stable') === to ? 0 : 1, commits: [] });
      const commits = between(from, to);
      return send(res, 200, { ahead_by: commits.length, commits: commits.map((c, i) => ({ sha: c.sha, parents: [{ sha: commits[i - 1]?.sha ?? 'base' }], commit: { message: c.message } })) });
    }
    if (rest === 'POST /pulls') {
      const p = { head: String(body.head), base: String(body.base), title: String(body.title), body: String(body.body) };
      if ([...g.pulls.values()].some((x) => x.state === 'open' && x.head === p.head && x.base === p.base)) return send(res, 422, { message: `A pull request already exists for owner:${p.head}.` });
      write('openPullRequest');
      return send(res, 201, pullJson(open({ ...p, headSha: g.branches.get(p.head) ?? shaOf(p.head) })));
    }
    if (rest === 'GET /pulls') return send(res, 200, [...g.pulls.values()].filter((p) => p.state === 'open' && (!q.base || p.base === q.base)).map(pullJson));
    if ((m = /^(GET|PATCH) \/pulls\/(\d+)$/.exec(rest))) {
      const p = g.pulls.get(Number(m[2]));
      if (!p) return send(res, 404, { message: 'Not Found' });
      if (m[1] === 'PATCH') {
        if (body.state === 'closed') { write('close'); p.state = 'closed'; }
        if (typeof body.base === 'string') { write('retarget'); p.base = body.base; }
      }
      return send(res, 200, pullJson(p));
    }
    if ((m = /^PUT \/pulls\/(\d+)\/merge$/.exec(rest))) {
      const p = g.pulls.get(Number(m[1]))!;
      if (p.state !== 'open') return send(res, 405, { message: 'Pull Request is not mergeable' });
      write('merge');
      Object.assign(p, { state: 'closed', merged: true, mergeSha: land(p.base, p.number, p.headSha) });
      return send(res, 200, { sha: p.mergeSha, merged: true });
    }
    if ((m = /^GET \/commits\/([0-9a-f]+)\/check-runs$/.exec(rest))) {
      return send(res, 200, { total_count: 1, check_runs: [{ id: 7, name: 'test', status: 'completed', conclusion: g.failing.has(m[1]!) ? 'failure' : 'success' }] });
    }
    if ((m = /^GET \/commits\/([0-9a-f]+)\/pulls$/.exec(rest))) {
      return send(res, 200, [...g.pulls.values()].filter((p) => p.merged && p.mergeSha === m![1]).map((p) => ({ number: p.number, merge_commit_sha: p.mergeSha, merged_at: '2026-10-19T00:00:00Z' })));
    }
    if (rest === 'POST /merges') {
      write('mergeInto');
      if (g.mergeInto === 'conflict') return send(res, 409, { message: 'Merge conflict' });
      const sha = shaOf(`back-merge-${String(body.base)}`);
      g.branches.set(String(body.base), sha);
      return send(res, 201, { sha });
    }
    if (/^GET \/actions\/jobs\/\d+\/logs$/.test(rest)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('FAIL test/a.test.ts');
      return;
    }
    if (rest === 'POST /issues') {
      write('fileIssue');
      const i: LandingIssue = { number: 900 + g.issues.length + 1, title: String(body.title), labels: body.labels as string[], assignees: body.assignees as string[] };
      g.issues.push(i);
      return send(res, 201, { number: i.number, html_url: `https://github.com/${LANDING_REPO}/issues/${i.number}`, assignees: i.assignees.map((login) => ({ login })) });
    }
    if (rest === 'GET /issues') {
      const found = g.issues.filter((i) => !q.labels || i.labels.includes(q.labels));
      return send(res, 200, found.map((i) => ({ number: i.number, title: i.title, html_url: `https://github.com/${LANDING_REPO}/issues/${i.number}` })));
    }
    if (/^POST \/issues\/\d+\/comments$/.test(rest)) { write('comment'); return send(res, 201, {}); }
    return send(res, 404, { message: 'Not Found' });
  }

  const server = createServer((req, res) => { handle(req, res).catch((e: unknown) => send(res, 500, { message: String(e) })); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return Object.assign(g, {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  });
}
