// The git broker (issue #652, design.md "Git through the hopper"): one git smart-HTTP request of a running job — its
// fetch or its push — done on GitHub with the connection of the job's own user. In order: the job's proxy token (git
// sends it as the password of Basic auth, from the job's credential helper) and its job at work; the repository: a push
// to any repository the user can push to, as GitHub says (issue #1806: the job's own one, another job repository, or a
// repository the hopper does not work on — no hopper rule but the user's own write access), else refused with why; then
// a push's ref updates, read before anything reaches GitHub (`checkPush`). A fetch goes to GitHub with the user's connection whatever the
// repository (issue #1015): the job repositories decide intake and where a job pushes, not what it reads, so a job reads
// any repository its user sees; git's fetch (`git-upload-pack`) only reads, and the token never leaves the hopper. A push is an event on the job's timeline (`github_proxy.done`, `.refused`,
// `.failed`, op `git.push`); a fetch is not. The contribution flow (issue #429): a job whose user cannot push to its own
// repository is refused before GitHub refuses it, with what to do; with the user's Contribution on, the job's fork — a
// fork of its own repository in the user's account, as GitHub says — is pushed to and fetched with the user's connection
// as its own repository is, under the same ref check. Each fetch that goes to GitHub is counted for the job and the
// repository (issue #858, `traffic.ts`): git asks for the refs once per fetch or clone, so that ask is the fetch.
// The shrink guard (issue #1096): each ref update of a push to a branch that is there already is judged, with the
// push's pack, by the user's side before anything reaches GitHub; a push that brings in the branch's base — its open pull
// request's base, else the repository's landing branch, else its default branch (issue #1147) — and empties or shrinks a file the branch's own change did not is refused with the files named, as git's own refusal,
// and the refusal (`github_proxy.refused`) carries them (`shrunk`).
// Direct push (issue #1806): with it on for the repository, a person's setting, a push may go straight to the target branch
// — the landing branch, else the default branch — but only as a fast-forward, as the user's mirror reads it with the push's
// pack; a push the hopper cannot check is refused, never taken. The push's event names those refs (`direct`).
// A push kept as a saga (issue #1806, push-saga.ts): a push sent to GitHub is a `git-push` saga first, so a hopper that stops
// before its event is recorded leaves the record to the next one.
// A refusal says why (issue #2042): git shows nothing of an error answer's body to a push's pack (the POST), only "HTTP 403",
// so a refusal there — the hopper's (`refused: …`) or GitHub's error answer (`GitHub refused the push (HTTP n): …`) — is
// answered as git's own refusal, an `ng` line per ref. GitHub's error answer to a push's ref advertisement is plain text,
// which git shows as a `remote:` line.
// Push requirements (issue #2555): a branch a push moves to a commit with no passing evaluation, where requirements apply, is refused.
// A push git sends otherwise is answered so too (issue #2481): one from a shallow clone, refused with its ref updates read past
// its `shallow` lines; git's probe (a flush packet) before a pack over its post buffer is taken, and the chunked pack is checked.
import { Readable } from 'node:stream';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { sourceItemOf, type Job, type JobStatus, type NewEvent } from '../domain/types.ts';
import { isGitLabItem } from '../domain/gitlab-account.ts'; import { isDirectQuery, LOOK_ONLY } from '../domain/direct-jobs.ts';
import type { RepoFacts } from './api.ts';
import { checkPush, gitPath, isProbe, receivePackCommands, type GitService, type RefUpdate } from './git.ts';
import { CONTRIBUTION_OFF } from './policy.ts';
import { parseProxyToken } from './token.ts';
import type { ProxyUser } from './broker.ts';
import type { ShrunkFile } from '../domain/shrink-guard.ts';
import type { GitPushes } from './push-saga.ts';
import { passProxyKillPoint } from './resend.ts';
import { githubTraffic, type GitHubTraffic } from '../github-limiter/traffic.ts';

/** A push's body unpacked in zlib's thread pool, not on the event loop (issue #1154). */
const unpack = promisify(gunzip);

const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];

/** A user's GitHub connection as git uses it: where GitHub's git is, its token, its login, and a repository as it sees it. */
export interface GitConnection {
  /** GitHub's web origin, where its git is (`https://github.com`). */
  url: string;
  login: string;
  token(): Promise<string>;
  renew(refused: string): Promise<string>;
  repo(repo: string): Promise<RepoFacts>;
  /** The base branch of the open pull request from `branch` of `repo`; undefined: none (issue #1147). */
  pullRequestBase(repo: string, branch: string): Promise<string | undefined>;
}

/** One user's side: their jobs, their Contribution (issue #429), and their GitHub connection for git, or why there is none. */
export interface GitUser {
  user: ProxyUser;
  /** Every connected account's job repositories (issue #1448). */
  jobRepositories(): string[];
  contribution(): boolean;
  /** The repository's landing branch while it has landing batches (issue #1073); undefined: it has none. */
  landingBranch?(repo: string): string | undefined;
  /** The connection of the account that acts for `repo` (issue #1448): the one whose job repositories hold it; else the first. */
  git(repo?: string): GitConnection | { problem: string };
  /**
   * The shrink guard (issue #1096): one ref update of a push, from `old` to `new`, with the push's pack, judged against
   * the base branch `base`. Refused: the files and why. Absent: no guard.
   */
  shrinkGuard?(push: { repo: string; base: string; old: string; new: string; pack: Buffer }): Promise<{ ok: true } | { ok: false; shrunk: ShrunkFile[]; reason: string }>;
  /**
   * Push requirements (issue #2555): whether the job may push `new` to `branch` of `repo`, whose base is `base`: a passing
   * evaluation of that commit, or no requirement applies to it. Refused: why, and what to do. Absent: none.
   */
  pushRequirements?(push: { jobId: string; repo: string; branch: string; base: string; new: string; pack: Buffer }): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** After a push GitHub took (issue #2555 part 4: the push requirements summary on the pull request). Never throws. Absent: nothing. */
  pushed?(push: { jobId: string; repo: string; refs: readonly { ref: string; new: string }[] }): Promise<void>;
  /** Direct push (issue #1806): whether a job may push straight to `repo`'s target branch. Absent: never. */
  directPush?(repo: string): boolean;
  /** Whether a push from `old` to `new`, with its pack, is a fast-forward (issue #1806); undefined: git cannot say. Absent: no direct push is taken. */
  fastForward?(push: { repo: string; old: string; new: string; pack: Buffer }): Promise<boolean | undefined>;
  /** Whether the job's log holds an event of request `requestId` (issue #1806, a push kept as a saga). Absent: none. */
  recorded?(jobId: string, requestId: string): boolean;
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
  /** Where each push is kept as a saga before it reaches GitHub (issue #1806). Absent: a push is kept nowhere. */
  pushes?: GitPushes;
}

const BASIC = /^Basic\s+(\S+)$/i;
const ZERO = /^0+$/;

const text = (status: number, message: string, extra: Record<string, string> = {}): GitAnswer =>
  ({ status, headers: { 'content-type': 'text/plain; charset=utf-8', ...extra }, body: Buffer.from(`${message}\n`) });

const UNAUTHORIZED = text(401, 'refused: the token is not a job\'s of this hopper. A job asks with its own HOPPER_TOKEN_FILE', { 'www-authenticate': 'Basic realm="hopper"' });

/** GitHub's error answer to a push, as one line: its status and the start of its text (issue #2042). */
async function githubRefusal(answer: GitAnswer): Promise<string> {
  const chunks: Buffer[] = [];
  try {
    if (Buffer.isBuffer(answer.body)) chunks.push(answer.body);
    else for await (const c of answer.body) chunks.push(Buffer.from(c as Buffer));
  } catch { /* the text is a help only: the status still says it */ }
  const said = Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 500);
  return `GitHub refused the push (HTTP ${answer.status})${said ? `: ${said}` : ''}`;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * A job's own repository: its source item's (`sourceItemOf`: a fork's or an older follow-on's is its parent's). A GitLab job's
 * (issue #1448 part 3) is a GitLab project, so it has no own repository on GitHub.
 */
const repoOf = (job: Job): string | undefined => { const s = sourceItemOf(job); return isGitLabItem(s) ? undefined : s?.repo; };

/**
 * The base a branch merges into (issue #1147): its open pull request's, else the landing branch, else the default branch. A
 * pull request GitHub cannot say of is none: the push is not held up by the read. The shrink guard's, and push requirements' (issue #2555).
 */
export async function baseBranchOf(side: GitUser, git: GitConnection, repo: string, branch: string, defaultBranch: string): Promise<string> {
  const pull = await git.pullRequestBase(repo, branch).catch(() => undefined);
  return pull ?? side.landingBranch?.(repo) ?? defaultBranch;
}

const pkt = (s: string | Buffer): Buffer => {
  const b = typeof s === 'string' ? Buffer.from(s) : s;
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]);
};

/** The capabilities of a push: after the NUL of its first ref update, which a shallow clone's `shallow` lines come before. */
function capabilitiesOf(body: Buffer): string {
  for (let at = 0; at + 4 <= body.length;) {
    const size = parseInt(body.toString('latin1', at, at + 4), 16);
    if (!(size >= 4) || at + size > body.length) return '';
    const line = body.toString('utf8', at + 4, at + size);
    if (line.includes('\0')) return line.split('\0')[1] ?? '';
    at += size;
  }
  return '';
}

/**
 * git's own answer to a push it refused, as receive-pack writes one: `unpack ok`, then `ng <ref> <reason>` for every ref,
 * in side band 1 when the push asked for a side band. git shows each as `! [remote rejected] … (<reason>)`.
 */
export function refusedReport(body: Buffer, commands: readonly RefUpdate[], reason: string): GitAnswer {
  const caps = capabilitiesOf(body);
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
      const own = repoOf(job);
      const usedHere = side.jobRepositories().some((x) => same(x, at.repo));
      // `as`: the GitHub identity that acts for the job, its own user's (issue #1380): the account of the job repository it
      // fetches or pushes (issue #1448); for any other repository — its fork, one the hopper does not work on (issue #1806) — the
      // account of the job's own repository.
      const git = side.git(usedHere ? at.repo : own);
      const acting = 'problem' in git ? {} : { as: git.login };
      const record = (type: 'github_proxy.done' | 'github_proxy.refused' | 'github_proxy.failed', data: Record<string, unknown>): void => {
        const event: NewEvent = { type, jobId: job.id, data: { requestId, ...(machine ? { machine } : {}), ...acting, op: 'git.push', repo: at.repo, ...data } };
        side.user.record(event);
      };
      // A push's pack, read before any check (issue #2042), so a refusal of it is git's own, with the reason.
      const pack = push && !at.advertise;
      let plain: Buffer | undefined;
      if (pack && (!r.contentEncoding || r.contentEncoding === 'gzip')) {
        try { plain = r.contentEncoding === 'gzip' ? await unpack(r.body ?? Buffer.alloc(0)) : r.body ?? Buffer.alloc(0); } catch { plain = undefined; }
      }
      // git's probe before a pack it sends chunked (issue #2481): taken, so the pack comes; the pack is checked and recorded.
      if (plain && isProbe(plain)) return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' }, body: Buffer.alloc(0) };
      const read = plain ? receivePackCommands(plain) : undefined;
      const refuse = (reason: string): GitAnswer => {
        if (push) record('github_proxy.refused', { reason, ...(read && read.commands.length > 0 ? { refs: read.commands.map((c) => c.ref) } : {}) });
        return plain && read && read.commands.length > 0 ? refusedReport(plain, read.commands, `refused: ${reason}`) : text(403, `refused: ${reason}`);
      };
      if (push && isDirectQuery(job)) return refuse(LOOK_ONLY); // issue #2184: a direct query's job pushes nothing
      const toOwn = own !== undefined && same(own, at.repo);
      const contribution = side.contribution();
      // The job's fork (issue #429): read only when it can be one — Contribution on, the user's own, no job repository.
      let facts: RepoFacts | undefined;
      if (!toOwn && own && contribution && !('problem' in git) && same(at.repo.split('/')[0]!, git.login) && !usedHere) {
        try { facts = await git.repo(at.repo); } catch { facts = undefined; }
      }
      const fork = facts !== undefined && facts.fork && [facts.parent, facts.source].some((p) => p !== undefined && same(p, own!));
      if ('problem' in git) {
        if (push || usedHere) return refuse(git.problem);
        return text(503, `refused: ${git.problem}`);
      }
      if (push && !fork) {
        try { facts = await git.repo(at.repo); } catch (e) { return refuse(`${at.repo} could not be read: ${(e as Error).message}`); }
        if (!facts.canPush && !toOwn) return refuse(`your user cannot push to ${at.repo}: GitHub gives its connection no write access there`);
        if (!facts.canPush) {
          return refuse(contribution
            ? `your user cannot push to ${at.repo}: contribute through a fork: sh "$HOPPER_GH" repo fork --repo ${at.repo}, then push your branch to the fork`
            : `your user cannot push to ${at.repo}, and ${CONTRIBUTION_OFF}`);
        }
      }
      let refs: RefUpdate[] = [];
      let direct: RefUpdate[] = [];
      if (pack) {
        if (r.contentEncoding && r.contentEncoding !== 'gzip') return refuse(`a push sent as ${r.contentEncoding} is not taken`);
        if (!plain || !read) return refuse('not a git push');
        if (!read.ok) return refuse(read.reason);
        refs = read.commands;
        const target = side.directPush?.(at.repo) ? side.landingBranch?.(at.repo) ?? facts!.defaultBranch : undefined;
        const allowed = checkPush(refs, { defaultBranch: facts!.defaultBranch, ...(target ? { direct: target } : {}) });
        if (!allowed.ok) {
          record('github_proxy.refused', { refs: refs.map((c) => c.ref), reason: allowed.reason });
          return refusedReport(plain, refs, allowed.reason);
        }
        direct = target ? refs.filter((c) => same(c.ref, `refs/heads/${target}`)) : [];
        for (const c of direct.filter((x) => !ZERO.test(x.old))) {
          const ff = side.fastForward ? await side.fastForward({ repo: at.repo, old: c.old, new: c.new, pack: read.pack }).catch(() => undefined) : undefined;
          if (ff === true) continue;
          const reason = ff === false
            ? `a job pushes to ${target} only a fast-forward: fetch it, put your commits on top, and push again`
            : `the hopper could not check that the push to ${target} is a fast-forward: push a new branch and open a pull request`;
          record('github_proxy.refused', { refs: refs.map((x) => x.ref), reason });
          return refusedReport(plain, refs, reason);
        }
        const baseOf = (ref: string): Promise<string> => baseBranchOf(side, git, at.repo, ref.replace(/^refs\/heads\//, ''), facts!.defaultBranch);
        if (side.shrinkGuard && facts?.defaultBranch) {
          for (const c of refs.filter((x) => !ZERO.test(x.old))) {
            const judged = await side.shrinkGuard({ repo: at.repo, base: await baseOf(c.ref), old: c.old, new: c.new, pack: read.pack });
            if (judged.ok) continue;
            record('github_proxy.refused', { refs: refs.map((x) => x.ref), reason: judged.reason, shrunk: judged.shrunk });
            return refusedReport(plain, refs, judged.reason);
          }
        }
        // Push requirements (issue #2555): each branch the push moves needs a passing evaluation of its new head.
        for (const c of side.pushRequirements ? refs.filter((x) => !ZERO.test(x.new) && x.ref.startsWith('refs/heads/')) : []) {
          const judged = await side.pushRequirements!({ jobId: job.id, repo: at.repo, branch: c.ref.slice('refs/heads/'.length), base: await baseOf(c.ref), new: c.new, pack: read.pack });
          if (judged.ok) continue;
          record('github_proxy.refused', { refs: refs.map((x) => x.ref), reason: judged.reason });
          return refusedReport(plain, refs, judged.reason);
        }
      }
      if (!push && at.advertise) traffic.gitFetch(at.repo, job.id);
      const sends = pack;
      const kept = sends ? o.pushes?.begin(parts.userId, { jobId: job.id, requestId, repo: at.repo, refs, ...(direct.length > 0 ? { direct: direct.map((c) => c.ref) } : {}), ...(machine ? { machine } : {}), ...acting, via: usedHere ? at.repo : own }) : undefined;
      try {
        // The crash harness's kill points (issue #1954): the saga kept and nothing sent; GitHub answered and nothing recorded.
        if (sends) passProxyKillPoint('git.push', 'before-send');
        const answer = await forward(r, at, git);
        if (sends) {
          passProxyKillPoint('git.push', 'after-send');
          if (answer.status === 200) {
            record('github_proxy.done', { refs: refs.map((c) => c.ref), heads: refs.map((c) => c.new), ...(direct.length > 0 ? { direct: direct.map((c) => c.ref) } : {}) });
            void side.pushed?.({ jobId: job.id, repo: at.repo, refs: refs.filter((c) => !ZERO.test(c.new)) });
          } else {
            const error = await githubRefusal(answer);
            record('github_proxy.failed', { refs: refs.map((c) => c.ref), error });
            return refusedReport(plain!, refs, error);
          }
        }
        if (push && answer.status >= 400) return text(answer.status, await githubRefusal(answer));
        return answer;
      } catch (e) {
        const error = (e as Error).message;
        if (sends) record('github_proxy.failed', { refs: refs.map((c) => c.ref), error });
        return text(502, `GitHub could not be reached: ${error}`);
      } finally {
        kept?.settled();
      }
    },
  };
}

export type GitProxy = ReturnType<typeof createGitProxy>;
