// A CI miss of a push requirement (issue #2555 part 5, design.md "Push requirements"): when the follow sees a job's open pull
// request with failed checks on a head commit the job evaluated, a failed check that a check of a requirement that applied
// stands for is recorded as `push_requirements.ci_missed`, once for each pull request and head commit.
import { ciMissOf, type EvaluatedPush } from '../domain/push-requirement-metrics.ts';
import type { UserStore } from '../domain/ports.ts';
import { pullRequestRepo, type PullRequestSeen } from '../domain/types.ts';

export function recordCiMiss(store: Pick<UserStore, 'jobs' | 'events'>, jobId: string, pullRequest: string, seen: PullRequestSeen | undefined): void {
  const head = seen?.failedHead, repo = store.jobs.get(jobId)?.source?.repo;
  if (!head || !repo || !seen.failedChecks?.length) return;
  const events = store.events.recent(100, ['push_requirements.evaluated', 'push_requirements.ci_missed'], jobId);
  if (events.some((e) => e.type === 'push_requirements.ci_missed' && e.data.pullRequest === pullRequest && e.data.head === head)) return;
  const at = pullRequestRepo(pullRequest, repo).toLowerCase();
  const evaluation = events.map((e) => (e.type === 'push_requirements.evaluated' ? e.data as unknown as EvaluatedPush : undefined))
    .find((d) => d !== undefined && d.head === head && d.repo.toLowerCase() === at);
  const miss = evaluation && ciMissOf(evaluation, seen.failedChecks.map((c) => c.name));
  if (!miss) return;
  store.events.append({ type: 'push_requirements.ci_missed', jobId, data: { repo: evaluation.repo, pullRequest, head, ...miss } });
}
