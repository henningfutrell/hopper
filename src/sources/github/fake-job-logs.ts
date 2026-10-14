// The in-memory GitHub's GitHub Actions job logs (issue #993, fake.ts): the text a test set for a job, or the error GitHub
// answers for it; never set: GitHub has none (404).
import { GitHubApiError, type GitHubApi } from './api.ts';

type FakeJobLogMethods = Required<Pick<GitHubApi, 'jobLog'>> & {
  setJobLog(repo: string, jobId: number, log: string | Error): void;
};

export function fakeJobLogs(enter: (method: 'jobLog', args: unknown[]) => void): FakeJobLogMethods {
  const logs = new Map<string, string | Error>();
  return {
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
