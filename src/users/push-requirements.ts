// Push requirements at the push (issue #2555, design.md "Push requirements"): the git proxy asks, for each branch a job's
// push moves, whether the job may push that commit. Yes when the job's newest evaluation of that commit in that repository
// passed; no when it failed. With no evaluation, the commit's tree is read in the user's mirror: no requirements file, the
// push goes on; one, it is refused until an evaluation passes. Git cannot say: the push goes on, as with the shrink guard.
import type { DomainEvent } from '../domain/types.ts';
import type { GitRemote } from '../git-mirror/mirrors.ts';
import type { HoldsRequirements } from '../git-mirror/push-requirements-at.ts';
import type { GitUser } from '../github-proxy/git-broker.ts';

export const PUSH_REQUIREMENTS_EVALUATED = 'push_requirements.evaluated' as const;
/** The script a job runs, as the refusal names it. */
const CHECK = 'sh "$HOPPER_REQUIREMENTS" check';

interface Evaluated { repo: string; head: string; passed: boolean; requirements: { id: string; status: string }[] }

/** The job's newest evaluation of `head` in `repo`, from its evaluations, newest first. */
export function evaluationOf(events: readonly DomainEvent[], repo: string, head: string): Evaluated | undefined {
  return events.map((e) => e.data as unknown as Evaluated).find((d) => d.head === head && d.repo.toLowerCase() === repo.toLowerCase());
}

export function pushRequirementsGate(o: {
  /** The job's `push_requirements.evaluated` events, newest first. */
  evaluations(jobId: string): readonly DomainEvent[];
  holds?: HoldsRequirements;
  remote(repo: string): () => Promise<GitRemote>;
}): NonNullable<GitUser['pushRequirements']> {
  return async (push) => {
    const commit = push.new.slice(0, 12);
    const evaluated = evaluationOf(o.evaluations(push.jobId), push.repo, push.new);
    if (evaluated?.passed) return { ok: true };
    if (evaluated) {
      const failed = evaluated.requirements.filter((q) => q.status === 'failed').map((q) => q.id);
      return { ok: false, reason: `the push requirements failed for ${commit}: ${failed.join(', ')}. Fix what fails, commit, run ${CHECK} again, and push` };
    }
    const holds = o.holds ? await o.holds(push.repo, o.remote(push.repo), { base: push.base, new: push.new, pack: push.pack }).catch(() => undefined) : undefined;
    if (holds !== true) return { ok: true };
    return { ok: false, reason: `${push.repo} has push requirements, and ${commit} has no passing evaluation: run ${CHECK} in the work tree at that commit, fix what fails, and push again` };
  };
}
