// The done criteria of a GitLab job's conditional skills (issue #1924 part 4, design.md "Conditional skills"), as the GitHub
// source checks them on a pull request (`src/sources/github/done-criteria.ts`): on the job's ready merge request, its head
// pipeline's jobs are the checks — each job's status, and the log of each finished job a `plan-destroy` criterion names —, its
// notes since its head commit are the comments, and its changed files decide whether a paths skill applies. The done check
// (`notComplete`, completion.ts) and yolo mode's merge (follow.ts) read them; the words are the GitHub source's, by `MR !N`.
import { mergeHolds, nameMatches, pathsApply, unmetCriteria, type CheckFact } from '../domain/conditional-skills.ts';
import type { ChecksState } from '../domain/pull-requests.ts';
import type { Job } from '../domain/types.ts';
import { holdText, missText, type JobAllowedDeletes, type JobDoneCriteria, type Unmet } from '../sources/github/done-criteria.ts';
import type { GitLabApi, GitLabMergeRequest } from './api.ts';

/** The done criteria of a GitLab job's conditional skills, and the deletes its issue allows (the GitLab source's options). */
export interface GitLabDoneCriteria { criteria: JobDoneCriteria; allowedDeletes?: JobAllowedDeletes }

/** A pipeline job's status as a check: `success` passing; `failed`, `canceled` failing; `skipped` unknown; any other pending. */
export function jobState(status: string): ChecksState {
  if (status === 'success') return 'passing';
  if (status === 'failed' || status === 'canceled') return 'failing';
  return status === 'skipped' ? 'unknown' : 'pending';
}

const FINISHED = new Set(['success', 'failed', 'canceled']);

/** The done criteria of `all` on merge request `m` of `project` now. An error asking GitLab throws: not known is not done. */
async function unmetOn(api: GitLabApi, project: string, m: GitLabMergeRequest, all: ReturnType<JobDoneCriteria>, allowed: string[]): Promise<Unmet> {
  const changed = await api.mergeRequestFiles(project, m.iid);
  const pr = { files: changed.files, ...(changed.cut ? { filesCut: true as const } : {}) };
  const skills = all.filter((s) => pathsApply(s.paths, pr));
  if (skills.length === 0) return 'none';
  const holds = skills.flatMap((s) => mergeHolds(s.done, pr).map((why) => ({ skill: s.skill, why })));
  const checked = skills.filter((s) => s.done.some((c) => c.kind !== 'person-merges'));
  if (checked.length === 0) return { known: true, misses: [], holds };
  // No head pipeline: no check ran. A log is read only for a finished job a plan criterion names.
  const jobs = m.pipelineId === undefined ? [] : await api.pipelineJobs(project, m.pipelineId);
  const plans = checked.flatMap((s) => s.done.flatMap((c) => (c.kind === 'plan-destroy' ? [c.checks ?? '*'] : [])));
  const checks: CheckFact[] = await Promise.all(jobs.map(async (j) => ({
    name: j.name, state: jobState(j.status),
    ...(FINISHED.has(j.status) && plans.some((p) => nameMatches(p, j.name)) ? { text: await api.jobLog(project, j.id) } : {}),
  })));
  const since = m.sha ? await api.commitTime(project, m.sha) : undefined;
  const comments = (await api.mergeRequestNotes(project, m.iid)).filter((n) => since === undefined || n.at >= since).map((n) => n.body);
  const misses = checked.flatMap((s) => {
    const why = unmetCriteria(s.done, { checks, comments, allowed });
    return why.length > 0 ? [{ skill: s.skill, why: why.join('; ') }] : [];
  });
  return { known: true, misses, holds };
}

/** Why the job is not done by its done criteria on its ready merge request `m`, in the done check's words; undefined: met, or none. */
export async function mergeRequestMiss(api: GitLabApi, job: Job, issueUrl: string, m: GitLabMergeRequest, done: GitLabDoneCriteria | undefined): Promise<string | undefined> {
  const all = done?.criteria(job.id) ?? [];
  const project = job.source?.repo;
  if (all.length === 0 || !project) return undefined;
  return missText(issueUrl, `MR !${m.iid}`, await unmetOn(api, project, m, all, done?.allowedDeletes?.(job.id) ?? []));
}

/** Why the hopper does not merge merge request `m` itself (yolo mode): a criterion not met, or a `person-merges` one; undefined: none. */
export async function mergeRequestHold(api: GitLabApi, job: Job, m: GitLabMergeRequest, done: GitLabDoneCriteria | undefined): Promise<string | undefined> {
  const all = done?.criteria(job.id) ?? [];
  const project = job.source?.repo;
  if (all.length === 0 || !project) return undefined;
  return holdText(await unmetOn(api, project, m, all, done?.allowedDeletes?.(job.id) ?? []));
}
