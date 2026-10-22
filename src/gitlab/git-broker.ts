// Git through the hopper for GitLab (issue #1448 part 3, design.md "Jobs through GitLab"): one git smart-HTTP request of a
// running GitLab job — its fetch or its push — done on GitLab with the token of its user's GitLab account; the job's machine
// holds no GitLab token. In order: the job's proxy token (git sends it as the password of Basic auth, from the job's
// credential helper) and its job at work, a job of the GitLab source; the project: a push only to the job's own project, and
// only to a branch of its own work (`checkPush`: never the project's default branch, a release branch, a tag or a delete),
// read from the push's ref updates before anything reaches GitLab. A fetch goes to GitLab whatever the project: GitLab answers
// what the account may read. git's push options (`-o merge_request.create`, …) go to GitLab as git sent them: that is how a
// job opens its merge request. A push is an event on the job's timeline (`gitlab_proxy.done`, `.refused`, `.failed`, op
// `git.push`, `as` the GitLab account); a fetch is not. GitLab refusing the token ends the account only.
import { Readable } from 'node:stream';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { sourceItemOf, type JobStatus, type NewEvent } from '../domain/types.ts';
import { isGitLabItem, isGitLabProject } from '../domain/gitlab-account.ts';
import { checkPush, isProbe, receivePackCommands, refusedReport, parseProxyToken, type GitAnswer, type GitRequest, type GitService, type ProxyUser, type RefUpdate } from '../github-proxy/index.ts';
import type { GitLabAccount } from './account.ts';

/** The route on the hopper's URL a GitLab job's git goes to: `<HOPPER_URL>/job/gitlab-git/<project>.git/…`. */
export const GITLAB_GIT_PATH = '/job/gitlab-git/';

/** A push's body unpacked in zlib's thread pool, not on the event loop. */
const unpack = promisify(gunzip);

const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];
const BASIC = /^Basic\s+(\S+)$/i;

/** One user's side: their jobs and their GitLab account. */
export interface GitLabGitUser {
  user: ProxyUser;
  gitlab: Pick<GitLabAccount, 'git' | 'refused' | 'act'>;
}

export interface GitLabGitProxyOptions {
  user(id: string): GitLabGitUser | undefined;
  log(line: string): void;
  newId?: () => string;
  /** GitLab, as git reaches it; tests give a fake's. Default: the global fetch. */
  fetch?: typeof fetch;
}

const text = (status: number, message: string, extra: Record<string, string> = {}): GitAnswer =>
  ({ status, headers: { 'content-type': 'text/plain; charset=utf-8', ...extra }, body: Buffer.from(`${message}\n`) });

const UNAUTHORIZED = text(401, 'refused: the token is not a job\'s of this hopper. A job asks with its own HOPPER_TOKEN_FILE', { 'www-authenticate': 'Basic realm="hopper"' });

/** A git request's path after `GITLAB_GIT_PATH`: its project (`group/name`, any subgroups) and service; undefined for anything else. */
export function gitlabGitPath(path: string, service: string | undefined): { project: string; service: GitService; advertise: boolean } | undefined {
  const m = /^(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!m || !isGitLabProject(m[1]!) || m[1]!.split('/').some((p) => p === '.' || p === '..' || p.startsWith('.'))) return undefined;
  if (m[2] !== 'info/refs') return { project: m[1]!, service: m[2] as GitService, advertise: false };
  return service === 'git-upload-pack' || service === 'git-receive-pack' ? { project: m[1]!, service, advertise: true } : undefined;
}

export function createGitLabGitProxy(o: GitLabGitProxyOptions) {
  const call = o.fetch ?? fetch;
  const newId = o.newId ?? (() => crypto.randomUUID());

  async function forward(r: GitRequest, at: { project: string; service: GitService; advertise: boolean }, git: { baseUrl: string; token: string }) {
    const url = `${git.baseUrl}/${at.project}.git/${at.advertise ? `info/refs?service=${at.service}` : at.service}`;
    return call(url, {
      method: r.method,
      headers: {
        authorization: `Basic ${Buffer.from(`oauth2:${git.token}`).toString('base64')}`,
        ...(r.contentType ? { 'content-type': r.contentType } : {}),
        ...(r.contentEncoding ? { 'content-encoding': r.contentEncoding } : {}),
        ...(r.gitProtocol ? { 'git-protocol': r.gitProtocol } : {}),
        'user-agent': 'git/hopper',
      },
      ...(r.body ? { body: new Uint8Array(r.body) } : {}),
      redirect: 'manual',
    });
  }

  return {
    /** One git request of a GitLab job. Never throws. */
    async handle(r: GitRequest): Promise<GitAnswer> {
      const basic = BASIC.exec(r.authorization ?? '')?.[1];
      const password = basic ? Buffer.from(basic, 'base64').toString('utf8').split(':').slice(1).join(':') : '';
      const parts = parseProxyToken(password.trim());
      const side = parts ? o.user(parts.userId) : undefined;
      const job = parts && side?.user.holds(parts) ? side.user.job(parts.jobId) : undefined;
      if (!parts || !side || !job) return UNAUTHORIZED;
      if (!AT_WORK.includes(job.status)) {
        o.log(`hopper: GitLab git proxy: refused job ${job.id}: it is ${job.status}`);
        return { ...UNAUTHORIZED, body: Buffer.from(`refused: job ${job.id} is ${job.status}, not at work: only a running job asks the hopper\n`) };
      }
      const source = sourceItemOf(job);
      if (!isGitLabItem(source)) return text(403, 'refused: only a job of a GitLab issue fetches and pushes through the hopper on GitLab');
      const at = gitlabGitPath(r.path, r.service);
      if (!at || (r.method === 'GET') !== at.advertise) return text(404, 'not a git request the hopper takes: a fetch or a push of <project>.git');
      const push = at.service === 'git-receive-pack';
      const machine = side.user.machineOf(job);
      const requestId = newId();
      const git = side.gitlab.git();
      const acting = 'problem' in git ? {} : { as: git.account };
      const record = (type: 'gitlab_proxy.done' | 'gitlab_proxy.refused' | 'gitlab_proxy.failed', data: Record<string, unknown>): void => {
        const event: NewEvent = { type, jobId: job.id, data: { requestId, ...(machine ? { machine } : {}), ...acting, op: 'git.push', project: at.project, ...data } };
        side.user.record(event);
      };
      const refuse = (reason: string): GitAnswer => {
        if (push) record('gitlab_proxy.refused', { reason });
        return text(403, `refused: ${reason}`);
      };
      const own = source?.repo;
      if (push && (own === undefined || own.toLowerCase() !== at.project.toLowerCase())) return refuse(`a job pushes only to its own project (${own ?? 'none'})`);
      if ('problem' in git) return push ? refuse(git.problem) : text(503, `refused: ${git.problem}`);
      let refs: RefUpdate[] = [];
      if (push && !at.advertise) {
        if (r.contentEncoding && r.contentEncoding !== 'gzip') return refuse(`a push sent as ${r.contentEncoding} is not taken`);
        let plain: Buffer;
        try { plain = r.contentEncoding === 'gzip' ? await unpack(r.body ?? Buffer.alloc(0)) : r.body ?? Buffer.alloc(0); } catch { return refuse('not a git push'); }
        // git's probe before a pack it sends chunked, and a shallow clone's push, as the GitHub broker answers them (issue #2481).
        if (isProbe(plain)) return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' }, body: Buffer.alloc(0) };
        const read = receivePackCommands(plain);
        if (!read.ok && read.commands.length > 0) {
          record('gitlab_proxy.refused', { refs: read.commands.map((c) => c.ref), reason: read.reason });
          return refusedReport(plain, read.commands, `refused: ${read.reason}`);
        }
        if (!read.ok) return refuse(read.reason);
        refs = read.commands;
        let defaultBranch: string | undefined;
        try { defaultBranch = await side.gitlab.act((a) => a.defaultBranch(at.project)); } catch (e) { return refuse(`${at.project} could not be read: ${(e as Error).message}`); }
        const allowed = checkPush(refs, defaultBranch ? { defaultBranch } : {});
        if (!allowed.ok) {
          const reason = allowed.reason.replace('pull request', 'merge request'); // GitLab's word
          record('gitlab_proxy.refused', { refs: refs.map((c) => c.ref), reason });
          return refusedReport(plain, refs, reason);
        }
      }
      try {
        const res = await forward(r, at, git);
        if (res.status === 401) {
          await res.body?.cancel();
          const why = 'GitLab refused the token (401): it was revoked, it expired, or it is not a token of this GitLab';
          side.gitlab.refused(why);
          if (push && !at.advertise) record('gitlab_proxy.failed', { refs: refs.map((c) => c.ref), error: why });
          return text(403, `refused: ${why}. A person connects GitLab again with a new token (Sources → GitLab)`);
        }
        if (push && !at.advertise) {
          if (res.status === 200) record('gitlab_proxy.done', { refs: refs.map((c) => c.ref), heads: refs.map((c) => c.new) });
          else record('gitlab_proxy.failed', { refs: refs.map((c) => c.ref), error: `GitLab answered ${res.status}` });
        }
        const headers: Record<string, string> = {};
        for (const name of ['content-type', 'cache-control', 'expires', 'pragma']) { const v = res.headers.get(name); if (v) headers[name] = v; }
        return { status: res.status, headers, body: res.body ? Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]) : Buffer.alloc(0) };
      } catch (e) {
        const error = (e as Error).message;
        if (push && !at.advertise) record('gitlab_proxy.failed', { refs: refs.map((c) => c.ref), error });
        return text(502, `GitLab could not be reached: ${error}`);
      }
    },
  };
}

export type GitLabGitProxy = ReturnType<typeof createGitLabGitProxy>;
