// Failed checks run again once (issue #1230, design.md "Own PR checks red"): before a job is sent back to fix the red checks
// of its own pull request, the GitHub source runs each failed check that is a GitHub Actions job again, through the port, so
// a flaky check costs no code change. A check that is no Actions job, or that GitHub refuses to run again (no Actions write
// permission, the run too old), is said so; a transient error throws, to be asked again.
import { actionsJobOf, type ChecksRerun, type FailedCheck } from '../../domain/types.ts';
import { GitHubApiError, type GitHubApi } from './api.ts';

export async function rerunChecks(api: Pick<GitHubApi, 'rerunJob'>, failed: readonly FailedCheck[]): Promise<ChecksRerun> {
  const rerun: string[] = [];
  const refused: string[] = [];
  for (const c of failed) {
    const job = actionsJobOf(c.url);
    if (!job || !api.rerunJob) { refused.push(`${c.name}: not a GitHub Actions job`); continue; }
    try {
      await api.rerunJob(job.repo, job.jobId);
      rerun.push(c.name);
    } catch (e) {
      if (!(e instanceof GitHubApiError && e.permanent)) throw e;
      refused.push(`${c.name}: ${e.status === 403 ? 'GitHub refused it: the hopper\'s GitHub App needs the Actions write permission' : e.message}`);
    }
  }
  return { rerun, ...(refused.length > 0 ? { refused: refused.join('; ') } : {}) };
}
