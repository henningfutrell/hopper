// Failed checks' logs (issue #993, design.md "Failed checks' logs"): before a `fix_checks` tend, the GitHub source reads the
// log of each failed check that is a GitHub Actions job, through the port — so through the shared rate limiter, counted in
// the GitHub rate budget (issue #985) — and puts its excerpt on the check; one GitHub refuses gets why. A finished job's
// log does not change, so each is read once per run: kept in memory, at most `MAX_KEPT_LOGS`, the oldest dropped first. A
// transient failure is not kept, so the next tend asks again.
import { actionsJobOf, logExcerpt, whyNoLog, type FailedCheck } from '../../domain/types.ts';
import { GitHubApiError, type GitHubApi } from './api.ts';

/** The most logs' excerpts a source keeps. */
export const MAX_KEPT_LOGS = 50;

export interface CheckLogs {
  /** `failed`, each GitHub Actions job's check with its log's excerpt (`log`) or why it could not be read (`logError`). Never throws. */
  read(failed: readonly FailedCheck[]): Promise<FailedCheck[]>;
}

type Read = Pick<FailedCheck, 'log' | 'logError'>;

/** The adapter's own words before GitHub's (`log of Actions job 42 of owner/name: …`): the job knows which log it asked. */
const ASKED = /^log of Actions job \d+ of \S+: /;

export function createCheckLogs(api: Pick<GitHubApi, 'jobLog'>): CheckLogs {
  const kept = new Map<string, Read>();
  const keep = (key: string, r: Read) => {
    kept.set(key, r);
    for (const oldest of kept.keys()) {
      if (kept.size <= MAX_KEPT_LOGS) break;
      kept.delete(oldest);
    }
  };

  async function readOne(c: FailedCheck): Promise<FailedCheck> {
    const job = actionsJobOf(c.url);
    if (!job || !api.jobLog) return c;
    const key = `${job.repo.toLowerCase()}#${job.jobId}`;
    let r = kept.get(key);
    if (!r) {
      try {
        r = { log: logExcerpt(await api.jobLog(job.repo, job.jobId)) };
        keep(key, r);
      } catch (e) {
        const err = e as { status?: unknown; message?: unknown };
        const message = (typeof err.message === 'string' ? err.message : String(e)).replace(ASKED, '');
        r = { logError: whyNoLog(typeof err.status === 'number' ? err.status : undefined, message) };
        if (e instanceof GitHubApiError && e.permanent) keep(key, r);
      }
    }
    return { ...c, ...r };
  }

  return { read: (failed) => Promise.all(failed.map(readOne)) };
}
