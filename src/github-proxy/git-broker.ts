// The git broker (issue #652, design.md "Git through the hopper"): one git smart-HTTP request of a running job — its
// fetch or its push — done on GitHub with the connection of the job's own user. In order: the job's proxy token (git
// sends it as the password of Basic auth, from the job's credential helper) and its job at work; the repository: a push
// only to the job's own one, and only there when it is one of the user's job repositories; then a push's ref updates,
// read before anything reaches GitHub (`checkPush`). A fetch goes to GitHub with the user's connection whatever the
// repository (issue #1015): the job repositories decide intake and where a job pushes, not what it reads, so a job reads
// any repository its user sees; git's fetch (`git-upload-pack`) only reads, and the token never leaves the hopper. A push is an event on the job's timeline (`github_proxy.done`, `.refused`,
// `.failed`, op `git.push`); a fetch is not. The contribution flow (issue #429): a job whose user cannot push to its own
// repository is refused before GitHub refuses it, with what to do; with the user's Contribution on, the job's fork — a
// fork of its own repository in the user's account, as GitHub says — is pushed to and fetched with the user's connection
// as its own repository is, under the same ref check. Each fetch that goes to GitHub is counted for the job and the
// repository (issue #858, `traffic.ts`): git asks for the refs once per fetch or clone, so that ask is the fetch.
// The shrink guard (issue #1096): each ref update of a push to a branch that is there already is judged, with the
// push's pack, by the user's side before anything reaches GitHub; a push that brings in the repository's default branch
// and empties or shrinks a file the branch's own change did not is refused with the files named, as git's own refusal,
// and the refusal (`github_proxy.refused`) carries them (`shrunk`).
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { sourceItemOf, type Job, type JobStatus, type NewEvent } from '../domain/types.ts';
import type { RepoFacts } from './api.ts';
import { checkPush, gitPath, receivePackCommands, type GitService, type RefUpdate } from './git.ts';
import { CONTRIBUTION_OFF } from './policy.ts';
import { parseProxyToken } from './token.ts';
import type { ProxyUser } from './broker.ts';
import type { ShrunkFile } from '../domain/shrink-guard.ts';
import { githubTraffic, type GitHubTraffic } from '../github-limiter/traffic.ts';

const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];

/** A user's GitHub connection as git uses it: where GitHub's git is, its token, its login, and a repository as it sees it. */
export interface GitConnection {
  /** GitHub's web origin, where its git is (`https://github.com`). */
  url: string;
  login: string;
  token(): Promise<string>;
  renew(refused: string): Promise<string>;
  repo(repo: string): Promise<RepoFacts>;
}

/** One user's side: their jobs, their Contribution (issue #429), and their GitHub connection for git, or why there is none. */
export interface GitUser {
  user: ProxyUser;
  jobRepositories(): string[];
  contribution(): boolean;
  git(): GitConnection | { problem: string };
  /**
   * The shrink guard (issue #1096): one ref update of a push, from `old` to `new`, with the push's pack, judged against
   * the base branch `base`. Refused: the files and why. Absent: no guard.
   */
  shrinkGuard?(push: { repo: string; base: string; old: string; new: string; pack: Buffer }): Promise<{ ok: true } | { ok: false; shrunk: ShrunkFile[]; reason: string }>;
}

/** A git request as the route gets it: the path after `/job/git/`, the query's `service`, the headers git sent, the body. */
export interface GitRequest {
  method: string;
  path: string;
  service?: string;
  authorization?: string;
  contentType?: string;
  contentEncoding?: string;
  gitProtocol?: string;
  body?: Buffer;
}

export interface GitAnswer {
  status: number;
  headers: Record<string, string>;
  body: Buffer | Readable;
}

export interface GitProxyOptions {
  user(id: string): GitUser | undefined;
  log(line: string): void;
  newId?: () => string;
  /** GitHub, as git reaches it; tests give the fake's. Default: the global fetch. */
  fetch?: typeof fetch;
  /** Where its fetches are counted; the process's own unless a test gives one. */
  traffic?: GitHubTraffic;
}

const BASIC = /^Basic\s+(\S+)$/i;
const ZERO = /^0+$/;

const text = (status: number, message: string, extra: Record<string, string> = {}): GitAnswer =>
  ({ status, headers: { 'content-type': 'text/plain; charset=utf-8', ...extra }, body: Buffer.from(`${message}\n`) });

const UNAUTHORIZED = text(401, 'refused: the token is not a job\'s of this hopper. A job asks with its own HOPPER_TOKEN_FILE', { 'www-authenticate': 'Basic realm="hopper"' });

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A job's own repository: its source item's (`sourceItemOf`: a fork's or an older follow-on's is its parent's). */
const repoOf = (job: Job): string | undefined => sourceItemOf(job)?.repo;

const pkt = (s: string | Buffer): Buffer => {
  const b = typeof s === 'string' ? Buffer.from(s) : s;
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]);
};

/**
 * git's own answer to a push it refused, as receive-pack writes one: `unpack ok`, then `ng <ref> <reason>` for every ref,
 * in side band 1 when the push asked for a side band. git shows each as `! [remote rejected] … (<reason>)`.
 */
function refusedReport(body: Buffer, commands: readonly RefUpdate[], reason: string): GitAnswer {
  const caps = body.toString('utf8', 4, Math.min(body.length, 4 + parseInt(body.toString('latin1', 0, 4), 16))).split('\0')[1] ?? '';
  const report = Buffer.concat([pkt('unpack ok\n'), ...commands.map((c) => pkt(`ng ${c.ref} ${reason}\n`)), Buffer.from('0000')]);
  const band = /\bside-band(-64k)?\b/.test(caps);
  const out = band ? Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), report])), Buffer.from('0000')]) : report;
  return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' }, body: out };
}

export function createGitProxy(o: GitProxyOptions) {
  const call = o.fetch ?? fetch;
  const newId = o.newId ?? (() => crypto.randomUUID());
  const traffic = o.traffic ?? githubTraffic;

  /** The request on GitHub; a token GitHub refuses is renewed once and the request made again. */
  async function forward(r: GitRequest, at: { repo: string; service: GitService; advertise: boolean }, git: GitConnection): Promise<GitAnswer> {
    const url = `${git.url.replace(/\/+$/, '')}/${at.repo}.git/${at.advertise ? `info/refs?service=${at.service}` : at.service}`;
    const send = async (token: string) => call(url, {
      method: r.method,
      headers: {
        authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
        ...(r.contentType ? { 'content-type': r.contentType } : {}),
        ...(r.contentEncoding ? { 'content-encoding': r.contentEncoding } : {}),
        ...(r.gitProtocol ? { 'git-protocol': r.gitProtocol } : {}),
        'user-agent': 'git/hopper',
      },
      ...(r.body ? { body: new Uint8Array(r.body) } : {}),
    });
    let token = await git.token();
    let res = await send(token);
    if (res.status === 401) {
      await res.body?.cancel();
      token = await git.renew(token);
      res = await send(token);
    }
    const headers: Record<string, string> = {};
    for (const name of ['content-type', 'cache-control', 'expires', 'pragma']) { const v = res.headers.get(name); if (v) headers[name] = v; }
    return { status: res.status, headers, body: res.body ? Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]) : Buffer.alloc(0) };
  }

  return {
    /** One git request of a job. Never throws. */
    async handle(r: GitRequest): Promise<GitAnswer> {
      const basic = BASIC.exec(r.authorization ?? '')?.[1];
      const password = basic ? Buffer.from(basic, 'base64').toString('utf8').split(':').slice(1).join(':') : '';
      const parts = parseProxyToken(password.trim());
      const side = parts ? o.user(parts.userId) : undefined;
      const job = parts && side?.user.holds(parts) ? side.user.job(parts.jobId) : undefined;
      if (!parts || !side || !job) return UNAUTHORIZED;
      if (!AT_WORK.includes(job.status)) {
        o.log(`hopper: git proxy: refused job ${job.id}: it is ${job.status}`);
        return { ...UNAUTHORIZED, body: Buffer.from(`refused: job ${job.id} is ${job.status}, not at work: only a running job asks the hopper\n`) };
      }
      const at = gitPath(r.path, r.service);
      if (!at || (r.method === 'GET') !== at.advertise) return text(404, 'not a git request the hopper takes: a fetch or a push of owner/name.git');
      const push = at.service === 'git-receive-pack';
      const machine = side.user.machineOf(job);
      const requestId = newId();
      const record = (type: 'github_proxy.done' | 'github_proxy.refused' | 'github_proxy.failed', data: Record<string, unknown>): void => {
        const event: NewEvent = { type, jobId: job.id, data: { requestId, ...(machine ? { machine } : {}), own: true, op: 'git.push', repo: at.repo, ...data } };
        side.user.record(event);
      };
      const refuse = (reason: string): GitAnswer => {
        if (push) record('github_proxy.refused', { reason });
        return text(403, `refused: ${reason}`);
      };
      const own = repoOf(job);
      const toOwn = own !== undefined && same(own, at.repo);
      const usedHere = side.jobRepositories().some((x) => same(x, at.repo));
      const git = side.git();
      const contribution = side.contribution();
      // The job's fork (issue #429): read only when it can be one — Contribution on, the user's own, no job repository.
      let facts: RepoFacts | undefined;
      if (!toOwn && own && contribution && !('problem' in git) && same(at.repo.split('/')[0]!, git.login) && !usedHere) {
        try { facts = await git.repo(at.repo); } catch { facts = undefined; }
      }
      const fork = facts !== undefined && facts.fork && [facts.parent, facts.source].some((p) => p !== undefined && same(p, own!));
      if (push && !toOwn && !fork) return refuse(`a job pushes only to its own repository${own ? ` (${own})${contribution ? ', or to its user\'s fork of it' : ''}` : ', and this job has none'}`);
      if (push && toOwn && !usedHere) return refuse(`${at.repo} is not one of the repositories your jobs use, so the hopper pushes nothing there`);
      if ('problem' in git) {
        if (usedHere) return refuse(git.problem);
        return text(503, `refused: ${git.problem}`);
      }
      if (push && toOwn) {
        try { facts = await git.repo(at.repo); } catch (e) { return refuse(`${at.repo} could not be read: ${(e as Error).message}`); }
        if (!facts.canPush) {
          return refuse(contribution
            ? `your user cannot push to ${at.repo}: contribute through a fork: sh "$HOPPER_GH" repo fork --repo ${at.repo}, then push your branch to the fork`
            : `your user cannot push to ${at.repo}, and ${CONTRIBUTION_OFF}`);
        }
      }
      let refs: RefUpdate[] = [];
      if (push && !at.advertise) {
        let plain: Buffer;
        try { plain = r.contentEncoding === 'gzip' ? gunzipSync(r.body ?? Buffer.alloc(0)) : r.body ?? Buffer.alloc(0); } catch { return refuse('not a git push'); }
        if (r.contentEncoding && r.contentEncoding !== 'gzip') return refuse(`a push sent as ${r.contentEncoding} is not taken`);
        const read = receivePackCommands(plain);
        if (!read.ok) return refuse(read.reason);
        refs = read.commands;
        const allowed = checkPush(refs, { defaultBranch: facts!.defaultBranch });
        if (!allowed.ok) {
          record('github_proxy.refused', { refs: refs.map((c) => c.ref), reason: allowed.reason });
          return refusedReport(plain, refs, allowed.reason);
        }
        if (side.shrinkGuard && facts?.defaultBranch) {
          for (const c of refs.filter((x) => !ZERO.test(x.old))) {
            const judged = await side.shrinkGuard({ repo: at.repo, base: facts.defaultBranch, old: c.old, new: c.new, pack: read.pack });
            if (judged.ok) continue;
            record('github_proxy.refused', { refs: refs.map((x) => x.ref), reason: judged.reason, shrunk: judged.shrunk });
            return refusedReport(plain, refs, judged.reason);
          }
        }
      }
      if (!push && at.advertise) traffic.gitFetch(at.repo, job.id);
      try {
        const answer = await forward(r, at, git);
        if (push && !at.advertise) {
          if (answer.status === 200) record('github_proxy.done', { refs: refs.map((c) => c.ref) });
          else record('github_proxy.failed', { refs: refs.map((c) => c.ref), error: `GitHub answered ${answer.status}` });
        }
        return answer;
      } catch (e) {
        const error = (e as Error).message;
        if (push && !at.advertise) record('github_proxy.failed', { refs: refs.map((c) => c.ref), error });
        return text(502, `GitHub could not be reached: ${error}`);
      }
    },
  };
}

export type GitProxy = ReturnType<typeof createGitProxy>;
