// The done criteria of a job's conditional skills (issue #1924, design.md "Conditional skills"): when the GitHub done check
// finds the job done by its own open pull request, the hopper checks each criterion itself on that pull request — its head
// commit's checks and their output, and its comments since that commit — and does not trust the job. A criterion not met
// keeps the job not done, said by the pull request's number and the skill, so the assessor sends the job back to fix it.
// A skill a paths rule gave is checked only when the pull request changes a file its paths match (part 2), and a plan's delete
// of an address the job's issue allows does not count. Yolo mode asks the same before its own merge (part 3,
// `doneCriteriaHold`), and a `person-merges` criterion that applies holds that merge for a person. A pull request that ships
// a part is checked the same way before the job ends partly done (part 4, `partCriteriaMiss`).
import { mergeHolds, pathsApply, unmetCriteria, type DoneCriterion } from '../../domain/conditional-skills.ts';
import type { Job } from '../../domain/types.ts';
import type { GitHubApi } from './api.ts';
import { ownOpenPullRequests, partPullRequest } from './completion.ts';
import { pullRequestRepo } from '../../domain/pull-requests.ts';

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
  return missText(url ?? `${repo}#${number}`, `PR #${pr}`, await unmetOn(api, pullRequestRepo(own.url, repo), pr, all, allowedDeletes?.(job.id) ?? [], own));
}

/**
 * Why the job's open pull request that ships a part (`partPullRequest`) does not meet its done criteria, in the done check's
 * words, or undefined: no criteria, no such pull request, a merged one (yolo mode read them before its merge, or a person
 * merged it), or each criterion met. An error asking GitHub throws.
 */
export async function partCriteriaMiss(api: GitHubApi, job: Job, criteria: JobDoneCriteria | undefined, allowedDeletes?: JobAllowedDeletes): Promise<string | undefined> {
  const all = criteria?.(job.id) ?? [];
  const { repo, number, url } = job.source ?? {};
  if (all.length === 0 || !repo || !number) return undefined;
  const part = await partPullRequest(api, job);
  if (part?.state !== 'open') return undefined;
  return missText(url ?? `${repo}#${number}`, `PR #${numberOf(part.url)}`, await unmetOn(api, pullRequestRepo(part.url, repo), numberOf(part.url), all, allowedDeletes?.(job.id) ?? []));
}

/** The done check's words for `unmet` on `change` (`PR #4`, a GitLab merge request `MR !4`) of issue `issue`; undefined: met. */
export function missText(issue: string, change: string, unmet: Unmet): string | undefined {
  if (unmet === 'none') return undefined;
  if (unmet.known === false) return `the issue ${issue} is open, and ${change}: done criteria of skill ${unmet.skills.join(', ')} not known: its checks cannot be read`;
  return unmet.misses.length > 0 ? `the issue ${issue} is open, and ${unmet.misses.map((m) => `${change}: done criteria of skill ${m.skill} not met: ${m.why}`).join(', and ')}` : undefined;
}

/** Why the hopper does not merge it itself, by `unmet`: each miss and each merge hold; undefined: none. */
export function holdText(unmet: Unmet): string | undefined {
  if (unmet === 'none') return undefined;
  if (unmet.known === false) return `done criteria of skill ${unmet.skills.join(', ')} not known: its checks cannot be read`;
  const why = [...unmet.misses.map((m) => `done criteria of skill ${m.skill} not met: ${m.why}`), ...unmet.holds.map((h) => `done criteria of skill ${h.skill}: ${h.why}`)];
  return why.length > 0 ? why.join('; and ') : undefined;
}

/** The done criteria on one pull request or merge request: none apply, not known, or each skill's misses and merge holds. */
export type Unmet = 'none' | { known: false; skills: string[] } | { known: true; misses: { skill: string; why: string }[]; holds: { skill: string; why: string }[] };

/**
 * The done criteria of `all` on pull request `pr` of `repo` now: 'none', when no skill applies to the files it changes; not
 * known, when its checks cannot be read; else each skill's misses and its merge holds (`person-merges`).
 */
async function unmetOn(api: GitHubApi, repo: string, pr: number, all: ReturnType<JobDoneCriteria>, allowed: string[], listed?: { headOid?: string; headRef?: string; headCommittedAt?: string }): Promise<Unmet> {
  // Read by its number: its head commit as GitHub has it now.
  const read = await api.pullRequest(repo, pr);
  // Its changed files, as the hopper's mirror says: a skill a paths rule gave applies when one matches.
  const skills = all.filter((s) => pathsApply(s.paths, read ?? {}));
  if (skills.length === 0) return 'none';
  const holds = skills.flatMap((s) => mergeHolds(s.done, read ?? {}).map((why) => ({ skill: s.skill, why })));
  const checked = skills.filter((s) => s.done.some((c) => c.kind !== 'person-merges'));
  if (checked.length === 0) return { known: true, misses: [], holds };
  const ref = read?.headOid ?? read?.headRef ?? listed?.headOid ?? listed?.headRef;
  if (!api.checkRuns || !ref) return { known: false, skills: checked.map((s) => s.skill) };
  const checks = await api.checkRuns(repo, ref);
  const since = read?.headCommittedAt ?? listed?.headCommittedAt;
  const comments = (await api.listComments(repo, pr)).filter((c) => since === undefined || (c.updatedAt ?? c.createdAt) >= since).map((c) => c.body);
  const misses = checked.flatMap((s) => {
    const why = unmetCriteria(s.done, { checks, comments, allowed });
    return why.length > 0 ? [{ skill: s.skill, why: why.join('; ') }] : [];
  });
  return { known: true, misses, holds };
}

/**
 * Why the hopper does not merge job `job`'s pull request `url` itself (part 3, yolo mode), or undefined: a done criterion of
 * its conditional skills not met on it now, or not known, or a `person-merges` criterion that applies. Asked just before the
 * hopper's own merge, never before a person's Merge now. An error asking GitHub throws.
 */
export async function doneCriteriaHold(api: GitHubApi, job: Job, repo: string, url: string, criteria: JobDoneCriteria | undefined, allowedDeletes?: JobAllowedDeletes): Promise<string | undefined> {
  const all = criteria?.(job.id) ?? [];
  if (all.length === 0) return undefined;
  return holdText(await unmetOn(api, repo, numberOf(url), all, allowedDeletes?.(job.id) ?? []));
}
