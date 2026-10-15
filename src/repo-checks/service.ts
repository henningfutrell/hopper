// Repositories with no checks (issue #677, design.md "Repositories with no checks"): one user's job repositories, each
// with what GitHub shows of its checks, and the "Add PR checks" job recommended for one with none. Each repository's last
// read is kept in the database (issue #1250, `RepoChecksRead`), and the list answers only from it: a list never reads
// GitHub. GitHub is read in the background, on Refresh (`refresh`) or on the schedule (`tick`, every `TICK_MS`, for each
// repository whose `nextAt` passed: `FRESH_MS` after a read, a backoff from `RETRY_MS` that doubles with each failure in
// a row, at most `MAX_RETRY_MS`, and never before GitHub's rate limit lets it). One read per repository at a time: a
// Refresh while one runs joins it. Each read is conditional (conditional.ts), with the answers kept from the read before.
// `one` reads GitHub now (the CLI's `hopper repo checks <repo>`).
// Queuing files the job as the person's own issue, with the hopper label, assigned to their connected account, once:
// an open issue of that title is answered instead (`repo_checks.job_queued`). A dismissal is the user's setting
// (`repo_checks.dismissed`). Each read also reads the repository's setup (issue #652, design.md "Repository setup").
import {
  addChecksJob, repoChecksState, repoSetup, type NewEvent, type RepoChecks, type RepoChecksQueued, type RepoChecksReadRepository, type RepoChecksView,
} from '../domain/types.ts';
import { conditionalAnswers } from './conditional.ts';
import { REPO_ROUTE, type RepoChecksGitHub } from './github.ts';

/** The schedule reads a repository again once its read is this old: 30 minutes. */
export const FRESH_MS = 30 * 60_000;
/** After a failed read, the schedule reads it again this much later, doubled with each failure in a row. */
export const RETRY_MS = 60_000;
/** The longest backoff: as long as a read stays fresh. */
export const MAX_RETRY_MS = FRESH_MS;
/** How often the schedule looks for a repository to read. */
export const TICK_MS = 60_000;
/** The label of the job's issue: the job sources' default label, so a source takes it as any other job. */
export const JOB_LABEL = 'hopper';

/** Why an act was refused: `status` as the HTTP edge answers it. */
export class RepoChecksRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'RepoChecksRefused';
    this.status = status;
  }
}

export interface RepoChecksOptions {
  /** The person's GitHub and the login of their connected account, or why there is none. */
  github(): { api: RepoChecksGitHub; login: string } | { problem: string };
  /** The job repositories, as chosen. */
  repos(): string[];
  /** Each repository's last read, kept in the database. */
  reads: RepoChecksReadRepository;
  yolo(repo: string): boolean;
  dismissed(): string[];
  setDismissed(repos: string[]): void;
  record(event: NewEvent): void;
  now(): number;
  log(line: string): void;
  tickMs?: number;
}

export interface RepoChecksService {
  /** What the database holds: never reads GitHub. */
  list(): RepoChecksView;
  /** One job repository, read from GitHub now; 404 when it is no job repository. */
  one(repo: string): Promise<RepoChecks>;
  /** Reads `repo`, or every job repository, from GitHub in the background: `view` at once, `done` once read. */
  refresh(repo?: string): { view: RepoChecksView; done: Promise<void> };
  /** The schedule's pass: reads each job repository whose `nextAt` passed. */
  tick(): Promise<void>;
  queue(repo: string, by: string): Promise<RepoChecksQueued>;
  dismiss(repo: string, dismissed: boolean, by: string): RepoChecks;
  start(): void;
  stop(): Promise<void>;
}

const key = (repo: string): string => repo.toLowerCase();

/** The backoff after `failures` failed reads in a row. */
const backoff = (failures: number): number => Math.min(RETRY_MS * 2 ** Math.max(0, failures - 1), MAX_RETRY_MS);

export function createRepoChecks(o: RepoChecksOptions): RepoChecksService {
  const reading = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let pass: Promise<void> | undefined;

  const jobRepo = (repo: string): string => {
    const name = o.repos().find((r) => key(r) === key(repo));
    if (!name) throw new RepoChecksRefused(404, `${repo} is no job repository: choose it in Sources first`);
    return name;
  };

  function entry(repo: string): RepoChecks {
    const r = o.reads.get(key(repo));
    const dismissed = o.dismissed().includes(key(repo));
    const state = r?.found ? repoChecksState(r.found) : 'unknown';
    return {
      repo, state, yolo: o.yolo(repo), dismissed, setup: repoSetup(r?.found?.setup),
      ...(r?.found ? { found: r.found } : {}),
      ...(r ? { checkedAt: r.at } : {}),
      ...(reading.has(key(repo)) ? { reading: true as const } : {}),
      ...(r?.error ? { error: r.error } : {}),
      ...(state === 'no checks' && !dismissed ? { recommendation: { title: addChecksJob(repo).title, ...(r?.queued ? { queued: r.queued } : {}) } } : {}),
    };
  }

  const view = (): RepoChecksView => ({ repos: o.repos().map(entry) });

  async function readNow(repo: string): Promise<void> {
    const before = o.reads.get(key(repo));
    const at = o.now();
    const iso = (t: number) => new Date(t).toISOString();
    const failed = (error: string, retryAt?: number) => {
      const failures = (before?.failures ?? 0) + 1;
      // What was read before stays, as of when it was read, with the reason this read failed: an unknown state is said
      // only for a repository never read.
      o.reads.put({
        ...(before ?? { etags: {} }), repo: key(repo), at: before?.found ? before.at : iso(at), failures, error,
        nextAt: iso(Math.max(at + backoff(failures), retryAt ?? 0)),
      });
    };
    const gh = o.github();
    if ('problem' in gh) { failed(gh.problem); return; }
    const answers = conditionalAnswers(before?.etags, REPO_ROUTE);
    try {
      const found = await gh.api.found(repo, answers);
      const queued = repoChecksState(found) === 'no checks'
        ? await gh.api.openIssue(repo, JOB_LABEL, addChecksJob(repo).title, answers).catch((e: unknown) => { o.log(`repo checks: ${(e as Error).message}`); return undefined; })
        : undefined;
      o.reads.put({ repo: key(repo), at: iso(at), nextAt: iso(at + FRESH_MS), failures: 0, found, ...(queued ? { queued } : {}), etags: answers.kept() });
    } catch (e) {
      failed((e as Error).message, (e as { retryAt?: number }).retryAt);
    }
  }

  /** One read per repository at a time. */
  const read = (repo: string): Promise<void> => {
    const k = key(repo);
    const now = reading.get(k);
    if (now) return now;
    const p = readNow(repo).catch((e: unknown) => { o.log(`repo checks: ${(e as Error).message}`); }).finally(() => reading.delete(k));
    reading.set(k, p);
    return p;
  };

  const due = (repo: string): boolean => {
    const r = o.reads.get(key(repo));
    return !r || Date.parse(r.nextAt) <= o.now();
  };

  const tick = (): Promise<void> => {
    pass ??= Promise.all(o.repos().filter(due).map(read)).then(() => undefined).finally(() => { pass = undefined; });
    return pass;
  };

  return {
    list: view,
    async one(repo) {
      const name = jobRepo(repo);
      await read(name);
      return entry(name);
    },
    refresh(repo) {
      const repos = repo === undefined ? o.repos() : [jobRepo(repo)];
      const done = Promise.all(repos.map(read)).then(() => undefined);
      return { view: view(), done };
    },
    tick,
    async queue(repo, by) {
      const name = jobRepo(repo);
      const gh = o.github();
      if ('problem' in gh) throw new RepoChecksRefused(503, gh.problem);
      if (!o.reads.get(key(name))?.found) await read(name);
      const now = entry(name);
      if (now.state !== 'no checks') {
        throw new RepoChecksRefused(409, now.state === 'checks' ? `${name} has checks: no job is needed` : `the checks of ${name} are not known: ${now.error ?? 'not read yet'}`);
      }
      const job = addChecksJob(name);
      let queued: RepoChecksQueued;
      try {
        const open = await gh.api.openIssue(name, JOB_LABEL, job.title);
        queued = open
          ? { kind: 'exists', ...open }
          : { kind: 'filed', ...(await gh.api.file(name, { ...job, labels: [JOB_LABEL], assignees: [gh.login] })) };
      } catch (e) {
        throw new RepoChecksRefused(502, (e as Error).message);
      }
      const r = o.reads.get(key(name));
      if (r) o.reads.put({ ...r, queued: { number: queued.number, url: queued.url } });
      o.record({ type: 'repo_checks.job_queued', data: { repo: key(name), number: queued.number, url: queued.url, existing: queued.kind === 'exists', by } });
      return queued;
    },
    dismiss(repo, dismissed, by) {
      const name = jobRepo(repo);
      const before = o.dismissed();
      const after = dismissed ? [...new Set([...before, key(name)])].sort() : before.filter((r) => r !== key(name));
      if (after.length !== before.length) {
        o.setDismissed(after);
        o.record({ type: 'repo_checks.dismissed', data: { repo: key(name), dismissed, by } });
      }
      return entry(name);
    },
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, o.tickMs ?? TICK_MS);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await pass;
      await Promise.all(reading.values());
    },
  };
}
