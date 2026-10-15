// The in-memory GitHub's GitHub Actions job logs (issue #993, fake.ts): the text a test set for a job, or the error GitHub
// answers for it; never set: GitHub has none (404). And its reruns (issue #1230): each job run again, or the error a test set.
import { GitHubApiError, type GitHubApi } from './api.ts';

type FakeJobLogMethods = Required<Pick<GitHubApi, 'jobLog' | 'rerunJob'>> & {
  setJobLog(repo: string, jobId: number, log: string | Error): void;
  /** The Actions jobs run again, `owner/name#job`, oldest first. */
  reruns: string[];
  /** What GitHub answers a rerun of any job: an error, or undefined to run it. */
  setRerunError(error: Error | undefined): void;
};

export function fakeJobLogs(enter: (method: 'jobLog' | 'rerunJob', args: unknown[]) => void): FakeJobLogMethods {
  const logs = new Map<string, string | Error>();
  const reruns: string[] = [];
  let rerunError: Error | undefined;
  return {
    reruns,
    async rerunJob(repo, jobId) {
      enter('rerunJob', [repo, jobId]);
      if (rerunError) throw rerunError;
      reruns.push(`${repo}#${jobId}`);
    },
    setRerunError(error) { rerunError = error; },
    async jobLog(repo, jobId) {
      enter('jobLog', [repo, jobId]);
      const log = logs.get(`${repo}#${jobId}`);
      if (log === undefined) throw new GitHubApiError(`gh: Not Found (HTTP 404): ${repo}/actions/jobs/${jobId}/logs`, true, 404);
      if (log instanceof Error) throw log;
      return log;
    },
    setJobLog(repo, jobId, log) { logs.set(`${repo}#${jobId}`, log); },
  };
}
