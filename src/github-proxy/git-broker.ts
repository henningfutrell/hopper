// The git broker (issue #652, design.md "Git through the hopper"): one git smart-HTTP request of a running job — its
// fetch or its push — done on GitHub with the connection of the job's own user. In order: the job's proxy token (git
// sends it as the password of Basic auth, from the job's credential helper) and its job at work; the repository: a push
// only to the job's own one, and only there when it is one of the user's job repositories; then a push's ref updates,
// read before anything reaches GitHub (`checkPush`). A fetch of a repository the user's jobs do not use goes to GitHub
// without credentials, as anyone's would. A push is an event on the job's timeline (`github_proxy.done`, `.refused`,
// `.failed`, op `git.push`); a fetch is not.
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import type { Job, JobStatus, NewEvent } from '../domain/types.ts';
import { checkPush, gitPath, receivePackCommands, type GitService, type RefUpdate } from './git.ts';
import { parseProxyToken } from './token.ts';
import type { ProxyUser } from './broker.ts';

const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];

/** A user's GitHub connection as git uses it: where GitHub's git is, its token, and the repository's default branch. */
export interface GitConnection {
  /** GitHub's web origin, where its git is (`https://github.com`). */
  url: string;
  token(): Promise<string>;
  renew(refused: string): Promise<string>;
  defaultBranch(repo: string): Promise<string>;
}

/** One user's side: their jobs, and their GitHub connection for git, or why there is none. */
export interface GitUser {
  user: ProxyUser;
  jobRepositories(): string[];
  git(): GitConnection | { problem: string };
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
}

const BASIC = /^Basic\s+(\S+)$/i;

const text = (status: number, message: string, extra: Record<string, string> = {}): GitAnswer =>
  ({ status, headers: { 'content-type': 'text/plain; charset=utf-8', ...extra }, body: Buffer.from(`${message}\n`) });

const UNAUTHORIZED = text(401, 'refused: the token is not a job\'s of this hopper. A job asks with its own HOPPER_TOKEN_FILE', { 'www-authenticate': 'Basic realm="hopper"' });

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A job's own repository: its source's, or for a fork its parent's (issue #548). */
const repoOf = (job: Job): string | undefined => job.source?.repo ?? job.forkOf?.source?.repo;

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

  /** The request on GitHub; a token GitHub refuses is renewed once and the request made again. */
  async function forward(r: GitRequest, at: { repo: string; service: GitService; advertise: boolean }, git: GitConnection, withToken: boolean): Promise<GitAnswer> {
    const url = `${git.url.replace(/\/+$/, '')}/${at.repo}.git/${at.advertise ? `info/refs?service=${at.service}` : at.service}`;
    const send = async (token: string | undefined) => call(url, {
      method: r.method,
      headers: {
        ...(token ? { authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` } : {}),
        ...(r.contentType ? { 'content-type': r.contentType } : {}),
        ...(r.contentEncoding ? { 'content-encoding': r.contentEncoding } : {}),
        ...(r.gitProtocol ? { 'git-protocol': r.gitProtocol } : {}),
        'user-agent': 'git/hopper',
      },
      ...(r.body ? { body: new Uint8Array(r.body) } : {}),
    });
    let token = withToken ? await git.token() : undefined;
    let res = await send(token);
    if (res.status === 401 && token) {
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
      const usedHere = side.jobRepositories().some((x) => same(x, at.repo));
      if (push && !(own && same(own, at.repo))) return refuse(`a job pushes only to its own repository${own ? ` (${own})` : ', and this job has none'}`);
      if (push && !usedHere) return refuse(`${at.repo} is not one of the repositories your jobs use, so the hopper pushes nothing there`);
      const git = side.git();
      if ('problem' in git) {
        if (usedHere) return refuse(git.problem);
        return text(503, `refused: ${git.problem}`);
      }
      let refs: RefUpdate[] = [];
      if (push && !at.advertise) {
        let plain: Buffer;
        try { plain = r.contentEncoding === 'gzip' ? gunzipSync(r.body ?? Buffer.alloc(0)) : r.body ?? Buffer.alloc(0); } catch { return refuse('not a git push'); }
        if (r.contentEncoding && r.contentEncoding !== 'gzip') return refuse(`a push sent as ${r.contentEncoding} is not taken`);
        const read = receivePackCommands(plain);
        if (!read.ok) return refuse(read.reason);
        refs = read.commands;
        let defaultBranch: string | undefined;
        try { defaultBranch = await git.defaultBranch(at.repo); } catch (e) { return refuse(`its default branch could not be read: ${(e as Error).message}`); }
        const allowed = checkPush(refs, { defaultBranch });
        if (!allowed.ok) {
          record('github_proxy.refused', { refs: refs.map((c) => c.ref), reason: allowed.reason });
          return refusedReport(plain, refs, allowed.reason);
        }
      }
      try {
        const answer = await forward(r, at, git, usedHere);
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
