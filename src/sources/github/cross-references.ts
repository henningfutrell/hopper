// Cross-reference detection in the GitHub source (issue #430, design.md "Cross-references"): the cross-references of a job's
// issue —
// each pull request or commit, of its repository or another, that GitHub confirms closes it, with the closing keyword its
// text used (`confirmedCrossReferences`). One GraphQL call (`GitHubApi.crossReferences`).
import { confirmedCrossReferences, type CrossReference } from '../../domain/cross-references.ts';
import type { Job } from '../../domain/types.ts';
import type { GitHubApi } from './api.ts';

/** The cross-references of the job's issue; none for a job of no GitHub issue, which asks nothing. An error asking GitHub throws. */
export async function crossReferencesOfJob(api: Pick<GitHubApi, 'crossReferences'>, job: Job): Promise<CrossReference[]> {
  const { repo, number } = job.source ?? {};
  if (!repo || !number) return [];
  return confirmedCrossReferences({ repo, number }, await api.crossReferences(repo, number));
}
