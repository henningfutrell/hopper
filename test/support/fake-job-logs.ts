// The fake GitHub's GitHub Actions job logs (issue #993, fake-forges.ts): `GET /repos/{repo}/actions/jobs/{job}/logs`
// answers as GitHub does — a redirect to a storage URL that needs no token, which serves the text —, or the status a test
// set for the job (403: the app may not read Actions). Its workflow runs and their jobs (issue #2318):
// `GET /repos/{repo}/actions/runs` (by `branch` and `event`), `…/actions/runs/{run}` and `…/actions/runs/{run}/jobs`.

export interface JobLogsForge {
  /** GitHub: the logs of GitHub Actions jobs, by job id: its text, or the status GitHub answers for it. */
  jobLogs?: Map<number, string | number>;
  /** GitHub: the workflow runs of each repository (`repo`), newest last, each with its jobs. */
  workflowRuns?: FakeRun[];
}

/** A workflow run as GitHub's REST API answers it, the repository it is in, and its jobs. */
export interface FakeRun {
  repo: string; id: number; name: string; event: string; head_branch: string; head_sha: string; status: string; conclusion: string | null;
  run_number: number; created_at: string; jobs: { id: number; name: string; status: string; conclusion: string | null; html_url?: string }[];
}

type Answer = { status: number; body?: unknown; location?: string; text?: string };

/** The storage URL's answer: the log's text. */
export function jobLogBlobRoute(forge: JobLogsForge | undefined, method: string, path: string): Answer | undefined {
  const m = /^\/job-logs\/(\d+)$/.exec(path);
  const text = m ? forge?.jobLogs?.get(Number(m[1])) : undefined;
  return method === 'GET' && typeof text === 'string' ? { status: 200, text } : undefined;
}

/** The REST answer: a redirect to the log's storage URL, or GitHub's refusal. */
export function jobLogsRoute(forge: JobLogsForge | undefined, base: string, method: string, rest: string): Answer | undefined {
  const m = /^actions\/jobs\/(\d+)\/logs$/.exec(rest);
  if (method !== 'GET' || !m) return undefined;
  const log = forge?.jobLogs?.get(Number(m[1]));
  if (log === undefined) return { status: 404, body: { message: 'Not Found' } };
  if (typeof log === 'number') return { status: log, body: { message: log === 403 ? 'Resource not accessible by integration' : 'refused' } };
  return { status: 302, location: `${base}/job-logs/${m[1]}` };
}

/** The REST answers of a repository's workflow runs: its list, newest first, a run, and a run's jobs. */
export function runsRoute(forge: JobLogsForge | undefined, base: string, method: string, repo: string, rest: string, query: Record<string, string>): Answer | undefined {
  if (method !== 'GET' || !/^actions\/runs(\/\d+(\/jobs)?)?$/.test(rest)) return undefined;
  const all = (forge?.workflowRuns ?? []).filter((r) => r.repo === repo);
  const restRun = (r: FakeRun) => ({
    id: r.id, name: r.name, event: r.event, head_branch: r.head_branch, head_sha: r.head_sha, status: r.status, conclusion: r.conclusion,
    run_number: r.run_number, created_at: r.created_at, html_url: `${base}/${repo}/actions/runs/${r.id}`,
  });
  if (rest === 'actions/runs') {
    const runs = all.filter((r) => (!query.branch || r.head_branch === query.branch) && (!query.event || r.event === query.event)).reverse();
    return { status: 200, body: { total_count: runs.length, workflow_runs: runs.map(restRun) } };
  }
  const run = all.find((r) => r.id === Number(rest.split('/')[2]));
  if (!run) return { status: 404, body: { message: 'Not Found' } };
  return rest.endsWith('/jobs') ? { status: 200, body: { total_count: run.jobs.length, jobs: run.jobs } } : { status: 200, body: restRun(run) };
}
