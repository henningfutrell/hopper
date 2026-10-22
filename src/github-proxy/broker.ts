// The GitHub proxy (issue #563, design.md "GitHub through the hopper"): a running job asks the hopper for a
// GitHub operation, and the hopper does it with the GitHub connection of the job's own user (issue #1380) — the job's
// machine holds no GitHub login, and no device code is spent. Each request is, in order: the job's proxy token checked
// (its job at work), the request's shape checked, the asker checked (policy.ts), the rate limits taken (limits.ts), then
// done on GitHub (`github_proxy.done`, `.refused`, `.failed`). Every outcome but a token that names no job is
// an event on the job's timeline, with `as`, the GitHub login that acts for the job; an answer done says it too. A job's bug report
// (`report.bug`, issue #694) is checked and limited the same way, then handed to `report`: Report a bug's own path, with
// the job's own user's connection, whose events (`bug_report.filed`, `.failed`) record it. An issue a job with an issue
// files is a child of that issue (issue #729, issue lineage): its text names the parent, a required one is linked as a
// GitHub sub-issue of it, and the link is recorded on the job's timeline (`job.child_issue_filed`). The contribution flow
// (issue #429): before the check, what it decides on is read from GitHub — whether a repository outside the job
// repositories is the job's fork, and, for `repo.fork`, whether the user can push to the job's own repository.
// A read — a **repo query** (issue #1074) — is answered from the repo-query cache when what it kept answers now
// (repo-query.ts), else read from GitHub and kept; the answer says which (`source`) and, where the work-item ledger holds
// the item, what it says (`ledger`). A write drops what the cache kept of the issue or pull request it changed.
// Where a pull request stands (`pr.status`, issue #1072) is answered from the asking user's records first — the Pull
// requests list and the work-item ledger — (`source: hopper`); only else is it a repo query as above. A wait on its checks
// (`pr.wait`, issue #1072 part 2) is asked as `pr.status`: while the checks of a pull request the hopper follows run, it
// opens a watch on the job's stream (`wait`, pr-waits.ts) and answers 202; the job is told there when they end.
// A poll (issue #1210, polls.ts): the same read of one job again and again is still answered, with a `poll` note that names
// the hopper's wait; for a job on a wait for its own command, the engine is told (`polled`).
// A resend key (issue #1607, sub-issue-links.ts): an issue create or comment sent again with the key it was sent with is
// answered the first answer, from its events (`replayed`), or, while the first is still at GitHub, the same answer as it.
// After a crash (issue #1959 part 2, resend.ts): such a write is recorded `github_proxy.sending` before its call, and its text
// ends with a post key; sent again with no answer recorded, it is looked for on GitHub first (`found`), so it is made once.
import { randomUUID } from 'node:crypto';
import { sourceItemOf, type Job, type JobStatus, type NewEvent } from '../domain/types.ts';
import { isGitLabItem } from '../domain/gitlab-account.ts'; import { isDirectQuery } from '../domain/direct-jobs.ts';
import { postKeySince, withPostKey } from '../domain/post-key.ts';
import { maskGitHubTokens } from '../secrets/mask.ts';
import { ProxyGitHubError, type ProxyApi } from './api.ts';
import type { ProxyLimiter } from './limits.ts';
import { checkRequest, filedNote, PR_OWNED, isRead, proxyRequest, REPORT_OP, ROUTE_LABEL, reportRequest, WAIT_OP, waitRequest, type IssueParent, type ProxyAsker, type ProxyOp, type ProxyRequest, type ReportRequest } from './policy.ts';
import { answersNow, createRepoQueryCache, queryKey, type LedgerView, type RepoQueryCache } from './repo-query.ts';
import { prWaitOver, tendedAnswer, TENDED_WAIT_NOTE, unwatchedWait, withReadChecks, withReadPullRequest, type KnownPullRequest, type PrWaitOver, type PullRequestStatus } from './pr-status.ts';
import { createPollWatch, POLL_READS, polledOn, pollNote, type PollWatch } from './polls.ts';
import type { WaitOn } from '../domain/wait-on.ts';
import { passProxyKillPoint, proxyPostKey } from './resend.ts';
import type { ProxyReplay } from './sub-issue-links.ts';
import { parseProxyToken, type ProxyTokenParts } from './token.ts';

/** The statuses whose jobs may ask: the job's processes are at work on its machine. */
const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];

/** One user's side: their jobs, the check of a token against their link key, and their event log. */
export interface ProxyUser {
  id: string;
  holds(parts: ProxyTokenParts): boolean;
  job(jobId: string): Job | undefined;
  /** The machine the job runs on now; undefined when it holds no lane. */
  machineOf(job: Job): string | undefined;
  record(event: NewEvent): void;
  /** What this user's work-item ledger says of the issue or pull request at `url` (issue #1074); undefined: it holds none. */
  ledger?(url: string): LedgerView | undefined;
  /** What this user's records know of pull request `number` of `repo` (issue #1072). Absent: nothing; GitHub is read. */
  pullRequest?(repo: string, number: number): KnownPullRequest;
  /**
   * Whether `job` may ask `op` of pull request `number` of `repo`: it opened it, it is the job's work item's (issue #1734)
   * or the one it tends (issue #2127), or, for `pr.edit` only, its issue names it (issues #2151, #2227); else why not.
   * Absent: none.
   */
  ownsPullRequest?(job: Job, repo: string, number: number, op: ProxyOp): true | string;
  /** The first answer to the job's request with resend key `key` (issue #1607); undefined: none yet. Absent: none is kept. */
  replay?(jobId: string, key: string): ProxyReplay | undefined;
  /** When the job's request with resend key `key` was first sent, with no answer recorded (issue #1959 part 2); undefined: never. */
  sending?(jobId: string, key: string): string | undefined;
}

/**
 * A user's GitHub connection: the repositories their jobs work on — every connected account's job repositories (issue
 * #1448) —, and its calls; or why it has none. `api` and `login` name a repository: the connected account whose job
 * repositories hold it acts; for any other, or none, the user's first account.
 */
export interface ProxyConnection {
  jobRepositories(): string[];
  api(repo?: string): ProxyApi | { problem: string };
  /** Its user's Contribution (issue #429), read at each request. */
  contribution(): boolean;
  /** The GitHub login of the account that acts for `repo`; undefined: not connected. */
  login(repo?: string): string | undefined;
}

export interface ProxyAnswer { status: number; body: Record<string, unknown> }

export interface GitHubProxy {
  /** One request: `authorization` as the job sent it, `body` its fields. Never throws. */
  handle(authorization: string | undefined, body: unknown): Promise<ProxyAnswer>;
}

export interface GitHubProxyOptions {
  user(id: string): ProxyUser | undefined;
  /** The GitHub connection of user `id`, which acts for their jobs (issue #1380); undefined: no such user. */
  connection(id: string): ProxyConnection | undefined;
  limiter: ProxyLimiter;
  /** A job's bug report, filed with its own user's connection (issue #694); absent: this hopper files none. Never throws. */
  report?(user: ProxyUser, job: Job, req: ReportRequest): Promise<ProxyAnswer>;
  log(line: string): void;
  newId?: () => string;
  /** The repo-query cache (issue #1074); absent: one of its own. */
  cache?: RepoQueryCache;
  /** Now, in ms: when an answer was read. */
  now?: () => number;
  /**
   * Opens a watch on the job's stream for a pull request whose checks run (issue #1072 part 2, `pr wait`), or answers the
   * one open; `seconds`, the most to wait. Absent: no waits, and `pr wait` answers as `pr status`.
   */
  wait?(user: ProxyUser, jobId: string, pr: { repo: string; number: number; status: PullRequestStatus; over?: PrWaitOver }, seconds?: number): { id: string; deadline: string } | undefined;
  /** The poll watch (issue #1210); absent: one of its own. */
  polls?: PollWatch;
  /**
   * A job on a wait for its own command polls (issue #1210): what it polls, how many times in the window, and the answer, as
   * JSON text. Absent: nobody is told. Never throws.
   */
  polled?(user: ProxyUser, job: Job, poll: { on: WaitOn; reads: number; answer: string }): void;
}

const BEARER = /^Bearer\s+(\S+)$/i;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A request that carries a resend key: its job's token and the key; undefined: none. */
const resendOf = (authorization: string | undefined, body: unknown): string | undefined => {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  return (raw.op === 'issue.create' || raw.op === 'issue.comment' || raw.op === 'pr.create') && typeof raw.key === 'string' ? `${authorization ?? ''}\0${raw.key}` : undefined;
};

/**
 * A job's own repository: its source item's (`sourceItemOf`: a fork's or an older follow-on's is its parent's). A GitLab job's
 * (issue #1448 part 3) is a GitLab project, so it has no own repository on GitHub.
 */
const repoOf = (job: Job): string | undefined => { const s = sourceItemOf(job); return isGitLabItem(s) ? undefined : s?.repo; };

export function createGitHubProxy(o: GitHubProxyOptions): GitHubProxy {
  const newId = o.newId ?? (() => randomUUID());
  const cache = o.cache ?? createRepoQueryCache();
  const now = o.now ?? (() => Date.now());
  const polls = o.polls ?? createPollWatch();
  /** The requests with a resend key at GitHub now: the same one sent again meanwhile waits for the same answer. */
  const inflight = new Map<string, Promise<ProxyAnswer>>();
  const proxy = {
    async handle(authorization: string | undefined, body: unknown): Promise<ProxyAnswer> {
      const parts = parseProxyToken(BEARER.exec(authorization ?? '')?.[1] ?? '');
      const user = parts ? o.user(parts.userId) : undefined;
      const job = parts && user?.holds(parts) ? user.job(parts.jobId) : undefined;
      if (!parts || !user || !job) {
        o.log('hopper: GitHub proxy: refused a request whose token is no job\'s');
        return { status: 401, body: { error: 'refused: the token is not a job\'s of this hopper. A job asks with its own HOPPER_TOKEN_FILE' } };
      }
      if (!AT_WORK.includes(job.status)) {
        o.log(`hopper: GitHub proxy: refused job ${job.id}: it is ${job.status}`);
        return { status: 401, body: { error: `refused: job ${job.id} is ${job.status}, not at work: only a running job asks the hopper` } };
      }
      const requestId = newId();
      const machine = user.machineOf(job);
      const connection = o.connection(user.id);
      // `as`: the GitHub identity that acts for the job, its own user's (issue #1380): the account of its repository (issue
      // #1448), or, once the request is read, of the job repository it names.
      let login = connection?.login(repoOf(job));
      let acting: { as?: string } = login ? { as: login } : {};
      // Who asked and from where stay in the hopper: the job's timeline.
      const record = (type: 'github_proxy.done' | 'github_proxy.refused' | 'github_proxy.failed' | 'github_proxy.sending', data: Record<string, unknown>): void => {
        user.record({ type, jobId: job.id, data: { requestId, ...(machine ? { machine } : {}), ...acting, ...data } });
      };
      const refuse = (status: number, reason: string, req?: { op?: string; repo?: string }): ProxyAnswer => {
        record('github_proxy.refused', { ...(req?.op ? { op: req.op } : {}), ...(req?.repo ? { repo: req.repo } : {}), reason });
        return { status, body: { error: `refused: ${reason}`, requestId } };
      };
      const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
      const report = raw.op === REPORT_OP;
      // A wait on a pull request's checks is asked as `pr.status`, and remembers how long it may wait.
      const waitParsed = raw.op === WAIT_OP ? waitRequest.safeParse(body) : undefined;
      const waiting = waitParsed?.success ? { ...(waitParsed.data.timeout !== undefined ? { timeout: waitParsed.data.timeout } : {}), for: waitParsed.data.for ?? 'checks' } : undefined;
      const parsed = report ? reportRequest.safeParse(body)
        : waitParsed?.success ? proxyRequest.safeParse({ op: 'pr.status', repo: waitParsed.data.repo, number: waitParsed.data.number })
          : waitParsed ?? proxyRequest.safeParse(body);
      if (!parsed.success) {
        const why = parsed.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ');
        return refuse(400, `not a request the hopper takes (${why}). sh "$HOPPER_GH" help`, { ...(typeof raw.op === 'string' ? { op: raw.op } : {}), ...(typeof raw.repo === 'string' ? { repo: raw.repo } : {}) });
      }
      if (parsed.data.op === REPORT_OP) {
        if (!o.report) return refuse(503, 'this hopper files no bug reports', parsed.data);
        const over = o.limiter.take(REPORT_OP, `${user.id}/${job.id}`, machine === undefined ? undefined : `${user.id}/${machine}`);
        if (over) return refuse(429, over, parsed.data);
        const answer = await o.report(user, job, parsed.data);
        return { status: answer.status, body: { ...answer.body, requestId } };
      }
      const req = parsed.data;
      if (!connection) return refuse(503, 'the job\'s user has no GitHub connection', req);
      const issue = job.source?.number;
      const jobRepo = repoOf(job);
      const contribution = connection.contribution();
      // The account that acts (issue #1448): the one of the repository the request names, when it is a job repository; else
      // the one of the job's own repository — its fork, a repo query elsewhere.
      const actingRepo = connection.jobRepositories().some((r) => same(r, req.repo)) ? req.repo : jobRepo;
      login = connection.login(actingRepo);
      acting = login ? { as: login } : {};
      const api = connection.api(actingRepo);
      // What the contribution flow decides on, read from GitHub only when it can matter (issue #429).
      const facts: Pick<ProxyAsker, 'fork' | 'canPush'> = {};
      const maybeFork = contribution && jobRepo !== undefined && login !== undefined && same(req.repo.split('/')[0]!, login)
        && !connection.jobRepositories().some((r) => same(r, req.repo));
      const forking = req.op === 'repo.fork' && contribution && jobRepo !== undefined && same(jobRepo, req.repo);
      if ((maybeFork || forking) && !('problem' in api)) {
        try {
          const read = await api.repo(req.repo);
          if (maybeFork && read.fork && [read.parent, read.source].some((p) => p !== undefined && same(p, jobRepo!))) facts.fork = req.repo;
          if (forking) facts.canPush = read.canPush;
        } catch (e) {
          record('github_proxy.failed', { op: req.op, repo: req.repo, error: (e as Error).message });
          return { status: 502, body: { error: (e as Error).message, requestId } };
        }
      }
      const owned = PR_OWNED.includes(req.op) && 'number' in req ? user.ownsPullRequest?.(job, req.repo, req.number, req.op) ?? false : undefined;
      const owns = owned === undefined ? {} : { ownsPullRequest: owned === true, ...(typeof owned === 'string' ? { notOwned: owned } : {}) };
      const asker: ProxyAsker = {
        jobId: job.id, contribution, ...(login ? { login } : {}), ...facts, ...owns, ...(isDirectQuery(job) ? { lookOnly: true } : {}),
        ...(jobRepo ? { repo: jobRepo } : {}), ...(issue !== undefined ? { issue } : {}),
      };
      // No connection of the job's own user (issue #1380): refused with how to connect, before the repositories it would
      // name. Only where a pull request stands may still come from the hopper's own records.
      if ('problem' in api && req.op !== 'pr.status') return refuse(503, api.problem, req);
      const allowed = checkRequest(req, asker, connection.jobRepositories());
      if (!allowed.ok) return refuse(403, allowed.reason, req);
      const resendKey = 'key' in req ? req.key : undefined;
      const replay = resendKey !== undefined ? user.replay?.(job.id, resendKey) : undefined;
      if (replay) return replayed(req, replay, resendKey!, acting, record);
      // Where a pull request stands (issue #1072): the hopper's records first; it costs GitHub nothing, so no limit.
      const knownPr = req.op === 'pr.status' ? user.pullRequest?.(req.repo, req.number) ?? {} : undefined;
      const prItem = knownPr?.item ? { item: knownPr.item } : {};
      /** A read of one pull request or issue asked again and again (issue #1210): how many times, and its note; nothing for a `pr wait`. */
      const pollOf = (): { reads: number; note: string } | undefined => {
        if (waiting || !isRead(req.op) || !('number' in req)) return undefined;
        const reads = polls.read(job.id, `${req.op}\0${req.repo.toLowerCase()}\0${req.number}`, now());
        return reads >= POLL_READS ? { reads, note: pollNote(req.op, req.repo, req.number, reads) } : undefined;
      };
      /** The engine is told of a job on a wait for its own command that polls, with the answer. */
      const tellPolled = (poll: { reads: number } | undefined, answer: object): void => {
        if (!poll || !o.polled || !('number' in req) || job.status !== 'waiting_on' || !job.wait?.ownCommand) return;
        try {
          o.polled(user, job, { on: polledOn(req.op, req.repo, req.number), reads: poll.reads, answer: JSON.stringify(answer) });
        } catch (e) {
          o.log(`hopper: GitHub proxy: telling the engine that job ${job.id} polls failed: ${(e as Error).message}`);
        }
      };
      // A failing answer from the records is read again on GitHub (issue #2321): a push since the follow's last read replaced
      // the head, or a newer run superseded the failed one, and a job acts on failed checks. Refused by the limits, or failed
      // on GitHub: the records' answer.
      // A tended pull request's answer is read again whole (issue #2497): the records are from before its tend job's push.
      const readAgain = async (k: PullRequestStatus): Promise<PullRequestStatus> => {
        const tended = tendedAnswer(k);
        if (k.state !== 'open' || (!tended && k.checks !== 'failing') || 'problem' in api) return k;
        const apply = (result: Record<string, unknown>) => (tended ? withReadPullRequest(k, result) : withReadChecks(k, result));
        const key = queryKey(req);
        const kept = cache.get(key);
        if (kept && answersNow(req.op, kept, now(), undefined)) return apply(kept.result);
        if (o.limiter.take(req.op, `${user.id}/${job.id}`, machine === undefined ? undefined : `${user.id}/${machine}`)) return k;
        try {
          const result = await api.perform(req);
          cache.put(key, result, now());
          return apply(result);
        } catch (e) {
          o.log(`hopper: GitHub proxy: reading ${req.repo}#${'number' in req ? req.number : ''} again failed: ${(e as Error).message}`);
          return k;
        }
      };
      if (knownPr?.known && req.op === 'pr.status') {
        const known = await readAgain(knownPr.known);
        const at = now();
        // Measured from the records (issue #2497): a change the read shows of a tended pull request has come already.
        const over: PrWaitOver = waiting?.for === 'mergeable' ? { for: 'mergeable', from: knownPr.known.mergeable } : { for: 'checks' };
        // `pr wait` while what it waits for has not come: a watch, and the job is told on its stream; else answered now.
        const settled = prWaitOver(known, over);
        // No checks (issue #2322): no event tells the hopper when they start, so no watch; the job waits with HOPPER_WAITING.
        // Tended (issue #2497): no follow sees it change, so no watch either.
        const tended = tendedAnswer(knownPr.known);
        const watches = !settled && !tended && (over.for === 'mergeable' || known.checks !== 'none');
        const w = waiting && o.wait && watches ? o.wait(user, job.id, { repo: req.repo, number: req.number, status: known, ...(over.for === 'mergeable' ? { over } : {}) }, waiting.timeout) : undefined;
        const wait = !waiting ? {} : w ? { wait: 'open', waitId: w.id, until: w.deadline, waitSeconds: Math.max(0, Math.round((Date.parse(w.deadline) - at) / 1000)) }
          : over.for === 'checks' && !settled ? unwatchedWait(req.repo, req.number, known as unknown as Record<string, unknown>, over.for)
            : settled ? { wait: 'settled' } : { wait: 'none', ...(tended ? { note: TENDED_WAIT_NOTE } : {}) };
        const poll = pollOf();
        record('github_proxy.done', { op: req.op, repo: req.repo, number: known.number, url: known.url, source: 'hopper', ...(waiting ? { wait: w ? w.id : wait.wait } : {}), ...(poll ? { poll: poll.reads } : {}) });
        tellPolled(poll, known);
        return { status: w ? 202 : 200, body: { ok: true, op: req.op, repo: req.repo, requestId, ...known, source: 'hopper', readAt: new Date(at).toISOString(), ...wait, ...(poll ? { poll: poll.note } : {}) } };
      }
      if ('problem' in api) return refuse(503, api.problem, req);
      const over = o.limiter.take(req.op, `${user.id}/${job.id}`, machine === undefined ? undefined : `${user.id}/${machine}`);
      if (over) return refuse(429, over, req);
      // An issue says the hopper filed it, for which job (issue #597: mask tokens). A follow-up is never labelled or
      // assigned, so a person triages it; a required child is routed (issue #1510): labelled and assigned to the job's
      // user, so a source lists it as a request card, which a person approves (it is never of a trusted origin).
      const maskRequest = (r: ProxyRequest): ProxyRequest => {
        if (r.op === 'issue.create' || r.op === 'pr.create') return { ...r, title: maskGitHubTokens(r.title), body: maskGitHubTokens(r.body) };
        if (r.op === 'pr.edit') return { ...r, ...(r.title !== undefined ? { title: maskGitHubTokens(r.title) } : {}), ...(r.body !== undefined ? { body: maskGitHubTokens(r.body) } : {}) };
        if (r.op === 'issue.comment') return { ...r, body: maskGitHubTokens(r.body) };
        return r;
      };
      const masked = maskRequest(req);
      const parent: IssueParent | undefined = masked.op === 'issue.create' && jobRepo && issue !== undefined ? { repo: jobRepo, number: issue, required: masked.required === true } : undefined;
      // A write with a resend key ends with its post key (issue #1959 part 2): what a look-up after a crash finds it by.
      const postKey = resendKey !== undefined ? proxyPostKey(job.source?.key ?? job.id, resendKey) : undefined;
      const keyed = (text: string): string => (postKey ? withPostKey(text, postKey) : text);
      const sent: ProxyRequest = masked.op === 'issue.create' ? { ...masked, body: keyed(`${masked.body}${filedNote(job.id, requestId, parent)}`) }
        : masked.op === 'issue.comment' || masked.op === 'pr.create' ? { ...masked, body: keyed(masked.body) } : masked;
      // A repo query (issue #1074): what the cache kept, when it answers now; the ledger's word on the item beside it.
      const read = isRead(req.op);
      const key = queryKey(req);
      const ledgerOf = (url: unknown): LedgerView | undefined => (typeof url === 'string' ? user.ledger?.(url) : undefined);
      const answered = (result: Record<string, unknown>, source: 'github' | 'cache', at: number): ProxyAnswer => {
        const ledger = ledgerOf(result.url);
        const poll = pollOf();
        record('github_proxy.done', { op: req.op, repo: req.repo, ...(result.number !== undefined ? { number: result.number } : {}), url: result.url, source, ...(poll ? { poll: poll.reads } : {}) });
        const seen = req.op === 'repo.view' ? { contribution } : {};
        // `pr wait` on a pull request the hopper does not follow: nothing would tell it when the checks end (issue #1731).
        const wait = waiting && 'number' in req ? unwatchedWait(req.repo, req.number, result, waiting.for) : {};
        tellPolled(poll, result);
        return { status: 200, body: { ok: true, op: req.op, repo: req.repo, requestId, ...acting, ...result, ...prItem, ...seen, source, readAt: new Date(at).toISOString(), ...(ledger ? { ledger } : {}), ...wait, ...(poll ? { poll: poll.note } : {}) } };
      };
      if (read) {
        const kept = cache.get(key);
        if (kept && answersNow(req.op, kept, now(), ledgerOf(kept.result.url))) return answered(kept.result, 'cache', kept.at);
      }
      try {
        const routeTo = parent?.required && login ? { labels: [ROUTE_LABEL], assignees: [login] } : undefined;
        const filed = parent?.required ? { subIssueOf: parent, ...routeTo } : undefined;
        // Sent before with no answer recorded (a hopper killed meanwhile): what GitHub made then is looked for first.
        const since = postKey ? user.sending?.(job.id, resendKey!) : undefined;
        if (postKey) record('github_proxy.sending', { op: req.op, repo: req.repo, ...('number' in req ? { number: req.number } : {}), key: resendKey });
        if (!read) passProxyKillPoint(req.op, 'before-send');
        const found = since && postKey && login ? await api.find?.(sent, postKey, postKeySince(since), login, filed) : undefined;
        const result = found ?? await api.perform(sent, filed);
        if (!read) passProxyKillPoint(req.op, 'after-send');
        if (read) {
          const at = now();
          cache.put(key, result, at);
          return answered(result, 'github', at);
        }
        if ('number' in req) cache.forget(req.repo, req.number);
        const was = found ? { found: true } : {};
        record('github_proxy.done', { op: req.op, repo: req.repo, ...(result.number !== undefined ? { number: result.number } : {}), url: result.url, ...(typeof result.fork === 'string' ? { fork: result.fork } : {}), ...(resendKey ? { key: resendKey } : {}), ...was });
        if (!parent) return { status: 200, body: { ok: true, op: req.op, repo: req.repo, requestId, ...acting, ...result, ...was } };
        const { subIssue, subIssueError, unassigned } = result as { subIssue?: boolean; subIssueError?: string; unassigned?: string[] };
        user.record({ type: 'job.child_issue_filed', jobId: job.id, data: {
          requestId, parent: { repo: parent.repo, number: parent.number }, child: { repo: req.repo, number: result.number, url: result.url }, required: parent.required,
          ...(subIssue !== undefined ? { subIssue } : {}), ...(subIssueError ? { subIssueError } : {}), ...(routeTo ? { routed: true } : {}),
          ...(unassigned ? { unassigned } : {}),
        } });
        // A routed child: the job is told the `on:` line that wakes it when the child closes.
        const routed = routeTo ? { routed: true, waitOn: `issue ${req.repo}#${String(result.number)}` } : {};
        // A link GitHub refused is kept, and tried again until it is made (issue #1607).
        const later = parent.required && subIssue === false ? { subIssueLater: true } : {};
        return { status: 200, body: { ok: true, op: req.op, repo: req.repo, requestId, ...acting, ...result, parent: `${parent.repo}#${parent.number}`, required: parent.required, ...later, ...routed, ...was } };
      } catch (e) {
        const status = e instanceof ProxyGitHubError ? e.status : undefined;
        const error = (e as Error).message;
        record('github_proxy.failed', { op: req.op, repo: req.repo, error });
        return { status: 502, body: { error, ...(status ? { githubStatus: status } : {}), requestId } };
      }
    },
  };
  return {
    handle(authorization, body) {
      const k = resendOf(authorization, body);
      if (k === undefined) return proxy.handle(authorization, body);
      const running = inflight.get(k);
      if (running) return running;
      const answer = proxy.handle(authorization, body).finally(() => inflight.delete(k));
      inflight.set(k, answer);
      return answer;
    },
  };
}

/** The first answer to a request sent again with its resend key (issue #1607), recorded as done again; nothing reaches GitHub. */
function replayed(
  req: ProxyRequest, replay: ProxyReplay, key: string, acting: { as?: string },
  record: (type: 'github_proxy.done', data: Record<string, unknown>) => void,
): ProxyAnswer {
  record('github_proxy.done', { op: req.op, repo: req.repo, ...(replay.number !== undefined ? { number: replay.number } : {}), url: replay.url, key, replayed: true });
  const c = replay.child;
  const lineage = !c ? {} : {
    parent: `${c.parent.repo}#${c.parent.number}`, required: c.required, ...(c.subIssue !== undefined ? { subIssue: c.subIssue } : {}),
    ...(c.required && c.subIssue === false ? { subIssueLater: true } : {}), ...(c.routed ? { routed: true, waitOn: `issue ${req.repo}#${String(replay.number)}` } : {}),
  };
  return { status: 200, body: { ok: true, op: req.op, repo: req.repo, requestId: replay.requestId, ...acting, ...(replay.number !== undefined ? { number: replay.number } : {}), url: replay.url, ...lineage, replayed: true } };
}
