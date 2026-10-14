// The fake GitHub's GitHub Actions job logs (issue #993, fake-forges.ts): `GET /repos/{repo}/actions/jobs/{job}/logs`
// answers as GitHub does — a redirect to a storage URL that needs no token, which serves the text —, or the status a test
// set for the job (403: the app may not read Actions).

export interface JobLogsForge {
  /** GitHub: the logs of GitHub Actions jobs, by job id: its text, or the status GitHub answers for it. */
  jobLogs?: Map<number, string | number>;
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
