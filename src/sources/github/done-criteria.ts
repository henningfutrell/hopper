// The done criteria of a job's conditional skills (issue #1924, design.md "Conditional skills"): when the GitHub done check
// finds the job done by its own open pull request, the hopper checks each criterion itself on that pull request — its head
// commit's checks and their output, and its comments since that commit — and does not trust the job. A criterion not met
// keeps the job not done, said by the pull request's number and the skill, so the assessor sends the job back to fix it.
import { unmetCriteria, type DoneCriterion } from '../../domain/conditional-skills.ts';
import type { Job } from '../../domain/types.ts';
import type { GitHubApi } from './api.ts';
import { ownOpenPullRequests } from './completion.ts';

/** The done criteria of the conditional skills job `jobId` got, by skill; none: no check. */
export type JobDoneCriteria = (jobId: string) => { skill: string; done: DoneCriterion[] }[];

const numberOf = (url: string): number => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);

/**
 * Why the job is not done by its done criteria, or undefined: no criteria, its issue closed (merged, or closed as completed:
 * what the done check found stands), or no open pull request of its own ready for review, or each criterion met on its
 * newest one. An error asking GitHub throws: not known is not done.
 */
export async function doneCriteriaMiss(api: GitHubApi, job: Job, criteria: JobDoneCriteria | undefined): Promise<string | undefined> {
  const skills = criteria?.(job.id) ?? [];
  const { repo, number, url } = job.source ?? {};
  if (skills.length === 0 || !repo || !number) return undefined;
  if ((await api.getIssue(repo, number)).state === 'closed') return undefined;
  const own = (await ownOpenPullRequests(api, job, repo, number)).filter((pr) => !pr.isDraft && !pr.conflicting)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!own) return undefined;
  const pr = numberOf(own.url);
  // Read by its number: its head commit as GitHub has it now.
  const read = await api.pullRequest(repo, pr);
  const ref = read?.headOid ?? read?.headRef ?? own.headOid ?? own.headRef;
  if (!api.checkRuns || !ref) return `the issue ${url ?? `${repo}#${number}`} is open, and PR #${pr}: done criteria of skill ${skills.map((s) => s.skill).join(', ')} not known: its checks cannot be read`;
  const checks = await api.checkRuns(repo, ref);
  const since = read?.headCommittedAt ?? own.headCommittedAt;
  const comments = (await api.listComments(repo, pr)).filter((c) => since === undefined || (c.updatedAt ?? c.createdAt) >= since).map((c) => c.body);
  const unmet = skills.flatMap((s) => {
    const why = unmetCriteria(s.done, { checks, comments });
    return why.length > 0 ? [`PR #${pr}: done criteria of skill ${s.skill} not met: ${why.join('; ')}`] : [];
  });
  return unmet.length > 0 ? `the issue ${url ?? `${repo}#${number}`} is open, and ${unmet.join(', and ')}` : undefined;
}
