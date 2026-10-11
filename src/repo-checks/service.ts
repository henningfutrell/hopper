// Repositories with no checks (issue #677, design.md "Repositories with no checks"): one user's job repositories, each
// with what GitHub shows of its checks, and the "Add PR checks" job recommended for one with none. The list never waits
// on GitHub: it answers what was read last and reads a repository again in the background once that is older than
// `FRESH_MS` (`RETRY_MS` after a failure), so the Pull requests page shows it at its next poll. `one` reads GitHub now.
// Queuing files the job as the person's own issue, with the hopper label, assigned to their connected account, once:
// an open issue of that title is answered instead (`repo_checks.job_queued`). A dismissal is the user's setting
// (`repo_checks.dismissed`). Kept in memory, per user: what is read is GitHub's, and is read again after a restart.
import { addChecksJob, repoChecksState, type NewEvent, type RepoChecks, type RepoChecksFound, type RepoChecksQueued, type RepoChecksView } from '../domain/types.ts';
import type { RepoChecksGitHub } from './github.ts';

/** A repository's checks are read again once this old. */
export const FRESH_MS = 10 * 60_000;
/** After a failed read, a repository is read again once this old. */
export const RETRY_MS = 60_000;
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
  yolo(repo: string): boolean;
  dismissed(): string[];
  setDismissed(repos: string[]): void;
  record(event: NewEvent): void;
  now(): number;
  log(line: string): void;
}

export interface RepoChecksService {
  list(): RepoChecksView;
  /** One job repository, read from GitHub now; 404 when it is no job repository. */
  one(repo: string): Promise<RepoChecks>;
  queue(repo: string, by: string): Promise<RepoChecksQueued>;
  dismiss(repo: string, dismissed: boolean, by: string): RepoChecks;
}

interface Read { at: number; found?: RepoChecksFound; error?: string; queued?: { number: number; url: string } }

const key = (repo: string): string => repo.toLowerCase();

export function createRepoChecks(o: RepoChecksOptions): RepoChecksService {
  const reads = new Map<string, Read>();
  const reading = new Map<string, Promise<void>>();

  const jobRepo = (repo: string): string => {
    const name = o.repos().find((r) => key(r) === key(repo));
    if (!name) throw new RepoChecksRefused(404, `${repo} is no job repository: choose it in Sources first`);
    return name;
  };

  function entry(repo: string): RepoChecks {
    const r = reads.get(key(repo));
    const dismissed = o.dismissed().includes(key(repo));
    const state = r?.found ? repoChecksState(r.found) : 'unknown';
    return {
      repo, state, yolo: o.yolo(repo), dismissed,
      ...(r?.found ? { found: r.found } : {}),
      ...(r ? { checkedAt: new Date(r.at).toISOString() } : {}),
      ...(r?.error ? { error: r.error } : {}),
      ...(state === 'no checks' && !dismissed ? { recommendation: { title: addChecksJob(repo).title, ...(r?.queued ? { queued: r.queued } : {}) } } : {}),
    };
  }

  async function readNow(repo: string): Promise<void> {
    const gh = o.github();
    if ('problem' in gh) { reads.set(key(repo), { at: o.now(), error: gh.problem }); return; }
    try {
      const found = await gh.api.found(repo);
      const queued = repoChecksState(found) === 'no checks'
        ? await gh.api.openIssue(repo, JOB_LABEL, addChecksJob(repo).title).catch((e: unknown) => { o.log(`repo checks: ${(e as Error).message}`); return undefined; })
        : undefined;
      reads.set(key(repo), { at: o.now(), found, ...(queued ? { queued } : {}) });
    } catch (e) {
      reads.set(key(repo), { at: o.now(), error: (e as Error).message });
    }
  }

  /** One read per repository at a time. */
  const read = (repo: string): Promise<void> => {
    const k = key(repo);
    const now = reading.get(k);
    if (now) return now;
    const p = readNow(repo).finally(() => reading.delete(k));
    reading.set(k, p);
    return p;
  };

  const stale = (repo: string): boolean => {
    const r = reads.get(key(repo));
    return !r || o.now() - r.at >= (r.error ? RETRY_MS : FRESH_MS);
  };

  return {
    list() {
      const repos = o.repos();
      for (const r of repos.filter(stale)) void read(r);
      return { repos: repos.map(entry) };
    },
    async one(repo) {
      const name = jobRepo(repo);
      await read(name);
      return entry(name);
    },
    async queue(repo, by) {
      const name = jobRepo(repo);
      const gh = o.github();
      if ('problem' in gh) throw new RepoChecksRefused(503, gh.problem);
      if (!reads.get(key(name))?.found) await read(name);
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
      const r = reads.get(key(name));
      if (r) r.queued = { number: queued.number, url: queued.url };
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
  };
}
