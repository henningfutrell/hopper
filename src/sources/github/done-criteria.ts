// The done criteria of a job's conditional skills (issue #1924, design.md "Conditional skills"): when the GitHub done check
// finds the job done by its own open pull request, the hopper checks each criterion itself on that pull request — its head
// commit's checks and their output, and its comments since that commit — and does not trust the job. A criterion not met
// keeps the job not done, said by the pull request's number and the skill, so the assessor sends the job back to fix it.
// A skill a paths rule gave is checked only when the pull request changes a file its paths match (part 2), and a plan's delete
// of an address the job's issue allows does not count.
import { pathsApply, unmetCriteria, type DoneCriterion } from '../../domain/conditional-skills.ts';
import type { Job } from '../../domain/types.ts';
import type { GitHubApi } from './api.ts';
import { ownOpenPullRequests } from './completion.ts';

/** The done criteria of the conditional skills job `jobId` got, by skill, with its paths (absent: always); none: no check. */
export type JobDoneCriteria = (jobId: string) => { skill: string; done: DoneCriterion[]; paths?: string[] }[];
/** The deletes job `jobId`'s issue allows by resource address, from the text it runs; none: []. */
export type JobAllowedDeletes = (jobId: string) => string[];

const numberOf = (url: string): number => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);

/**
 * Why the job is not done by its done criteria, or undefined: no criteria, its issue closed (merged, or closed as completed:
 * what the done check found stands), or no open pull request of its own ready for review, or each criterion met on its
 * newest one. An error asking GitHub throws: not known is not done.
 */
export async function doneCriteriaMiss(api: GitHubApi, job: Job, criteria: JobDoneCriteria | undefined, allowedDeletes?: JobAllowedDeletes): Promise<string | undefined> {
  const all = criteria?.(job.id) ?? [];
  const { repo, number, url } = job.source ?? {};
  if (all.length === 0 || !repo || !number) return undefined;
  if ((await api.getIssue(repo, number)).state === 'closed') return undefined;
  const own = (await ownOpenPullRequests(api, job, repo, number)).filter((pr) => !pr.isDraft && !pr.conflicting)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!own) return undefined;
  const pr = numberOf(own.url);
  // Read by its number: its head commit as GitHub has it now.
  const read = await api.pullRequest(repo, pr);
  // Its changed files, as the hopper's mirror says: a skill a paths rule gave applies when one matches.
  const skills = all.filter((s) => pathsApply(s.paths, read ?? {}));
  if (skills.length === 0) return undefined;
  const ref = read?.headOid ?? read?.headRef ?? own.headOid ?? own.headRef;
  if (!api.checkRuns || !ref) return `the issue ${url ?? `${repo}#${number}`} is open, and PR #${pr}: done criteria of skill ${skills.map((s) => s.skill).join(', ')} not known: its checks cannot be read`;
  const checks = await api.checkRuns(repo, ref);
  const since = read?.headCommittedAt ?? own.headCommittedAt;
  const comments = (await api.listComments(repo, pr)).filter((c) => since === undefined || (c.updatedAt ?? c.createdAt) >= since).map((c) => c.body);
  const allowed = allowedDeletes?.(job.id) ?? [];
  const unmet = skills.flatMap((s) => {
    const why = unmetCriteria(s.done, { checks, comments, allowed });
    return why.length > 0 ? [`PR #${pr}: done criteria of skill ${s.skill} not met: ${why.join('; ')}`] : [];
  });
  return unmet.length > 0 ? `the issue ${url ?? `${repo}#${number}`} is open, and ${unmet.join(', and ')}` : undefined;
}
