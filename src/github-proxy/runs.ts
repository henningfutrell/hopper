// The GitHub Actions reads of the GitHub proxy (api.ts): a failed check's full log (issue #993), and a repository's
// workflow runs and a run's jobs (issue #2318) — repo queries, as a pull request's checks, for a job that must read a run
// no pull request names (a branch's push runs, for example). Each job's id is its `check log` job.
import { MAX_JOB_LOG_CHARS } from '../domain/check-logs.ts';
import { paginate, splitRepo, type Request } from '../sources/github/http/http.ts';
import { jobLog } from '../sources/github/http/rest.ts';
import type { ProxyResult } from './api.ts';

/**
 * A failed check's full log (issue #993): its end when it is longer than `MAX_JOB_LOG_CHARS`, where the failure is. Read
 * through the shared rate limiter as every call; its link is the check run's page, which GitHub names by the job's id.
 */
export async function checkLog(req: Request, token: string, webOrigin: string, repo: string, job: number): Promise<ProxyResult> {
  const log = await jobLog(req, token, repo, job);
  const truncated = log.length > MAX_JOB_LOG_CHARS;
  return { number: job, url: `${webOrigin}/${repo}/runs/${job}`, log: truncated ? log.slice(-MAX_JOB_LOG_CHARS) : log, ...(truncated ? { truncated: true } : {}) };
}

/** How many runs `run list` answers at most: the newest, as GitHub lists them. `total` says how many match. */
export const RUN_LIST_MAX = 50;

interface RestRun { id: number; name?: string | null; event: string; head_branch?: string | null; head_sha: string; status?: string | null; conclusion?: string | null; run_number: number; run_attempt?: number; created_at: string; html_url: string }
interface RestJob { id: number; name: string; status: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null; html_url?: string | null }

const runOf = (r: RestRun) => ({
  id: r.id, name: r.name ?? '', event: r.event, branch: r.head_branch ?? '', headSha: r.head_sha, status: r.status ?? '', conclusion: r.conclusion ?? null,
  runNumber: r.run_number, ...(r.run_attempt !== undefined ? { runAttempt: r.run_attempt } : {}), createdAt: r.created_at, url: r.html_url,
});

/** The newest runs of `repo`, of `branch` and `event` when named. */
export async function listRuns(req: Request, token: string, webOrigin: string, r: { repo: string; branch?: string; event?: string }) {
  const filter = { ...(r.branch ? { branch: r.branch } : {}), ...(r.event ? { event: r.event } : {}) };
  const d = (await req('GET /repos/{owner}/{repo}/actions/runs', { ...splitRepo(r.repo), ...filter, per_page: RUN_LIST_MAX, headers: { authorization: `token ${token}` } })).data as { total_count?: number; workflow_runs?: RestRun[] };
  const runs = (d.workflow_runs ?? []).map(runOf);
  return { url: `${webOrigin}/${r.repo}/actions`, total: d.total_count ?? runs.length, runs };
}

/** One run, and its jobs (the latest attempt's, as GitHub lists them unless asked otherwise). */
export async function viewRun(req: Request, token: string, webOrigin: string, r: { repo: string; number: number }) {
  const at = { ...splitRepo(r.repo), run_id: r.number };
  const run = runOf((await req('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { ...at, headers: { authorization: `token ${token}` } })).data as RestRun);
  const jobs = await paginate<RestJob>(req, 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', { ...at, per_page: 100 }, `token ${token}`, (d) => (d as { jobs: RestJob[] }).jobs);
  return {
    ...run, number: run.id, url: `${webOrigin}/${r.repo}/actions/runs/${run.id}`,
    jobs: jobs.map((j) => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion, ...(j.started_at ? { startedAt: j.started_at } : {}), ...(j.completed_at ? { completedAt: j.completed_at } : {}), ...(j.html_url ? { url: j.html_url } : {}) })),
  };
}
