// Push requirements at the push (issue #2555, design.md "Push requirements"): the git proxy asks, for each branch a job's
// push moves, whether the job may push that commit. Yes when the job's newest evaluation of that commit in that repository
// passed; no when it failed. With no evaluation, the commit's tree is read in the user's mirror: a requirements file, the
// push is refused until an evaluation passes; none, the hopper's default requirements are planned against the files the
// commit changes, with the job's own (a direct job's, part 3), and the push is refused only when one applies. Git cannot say: the push goes on, as with the shrink guard.
// The evaluation of a pushed commit is summarized in its pull request's body (part 4): at `pr create`, and after each push.
import { effectiveRequirements, planPush, type PushRequirement } from '../domain/push-requirements.ts';
import { pushRequirementsSummary, withPushRequirementsSummary, type SummarizedEvaluation } from '../domain/push-requirements-summary.ts';
import { workKindOf } from '../domain/skill-library.ts';
import type { UserStore } from '../domain/ports.ts';
import type { DomainEvent, Job, NewEvent } from '../domain/types.ts';
import type { GitRemote } from '../git-mirror/mirrors.ts';
import type { HoldsRequirements } from '../git-mirror/push-requirements-at.ts';
import type { ProxyApi } from '../github-proxy/api.ts';
import type { GitUser } from '../github-proxy/git-broker.ts';
import { maskGitHubTokens } from '../secrets/mask.ts';
import { ownsPullRequest } from './owns-pull-request.ts';

export const PUSH_REQUIREMENTS_EVALUATED = 'push_requirements.evaluated' as const;
/** The script a job runs, as the refusal names it. */
const CHECK = 'sh "$HOPPER_REQUIREMENTS" check';

interface Evaluated extends SummarizedEvaluation { repo: string }

/** The job's newest evaluation of `head` in `repo`, from its evaluations, newest first. */
export function evaluationOf(events: readonly DomainEvent[], repo: string, head: string): Evaluated | undefined {
  return events.map((e) => e.data as unknown as Evaluated).find((d) => d.head === head && d.repo.toLowerCase() === repo.toLowerCase());
}

export function pushRequirementsGate(o: {
  /** The job's `push_requirements.evaluated` events, newest first. */
  evaluations(jobId: string): readonly DomainEvent[];
  /** The hopper's default requirements (Settings → Push requirements), read at each push. */
  defaults(): readonly PushRequirement[];
  job(jobId: string): Pick<Job, 'spec' | 'source'> | undefined;
  /** The job's own push requirements (a direct job's, issue #2555 part 3); undefined: none. */
  override(job: Pick<Job, 'source'>): readonly PushRequirement[] | undefined;
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
    const tree = o.holds ? await o.holds(push.repo, o.remote(push.repo), { base: push.base, new: push.new, pack: push.pack }).catch(() => undefined) : undefined;
    if (!tree) return { ok: true };
    if (tree.file) return { ok: false, reason: `${push.repo} has push requirements, and ${commit} has no passing evaluation: run ${CHECK} in the work tree at that commit, fix what fails, and push again` };
    const job = o.job(push.jobId);
    const defaults = o.defaults();
    const own = job ? o.override(job) ?? [] : [];
    if (!job || defaults.length + own.length === 0) return { ok: true };
    const plan = planPush(effectiveRequirements({ defaults, job: own }), {
      files: tree.files, repo: push.repo, branch: push.branch, base: push.base, kind: workKindOf(job.spec), labels: job.source?.labels ?? [],
    });
    if (plan.matched.length === 0) return { ok: true };
    const whose = [...new Set(plan.matched.map((q) => (q.level === 'job' ? 'the job\'s own' : 'the hopper\'s default')))].join(' and ');
    return { ok: false, reason: `${whose} push requirements apply to ${commit} (${plan.matched.map((q) => q.id).join(', ')}), and it has no passing evaluation: run ${CHECK} in the work tree at that commit, fix what fails, and push again` };
  };
}

export const PUSH_REQUIREMENTS_SUMMARIZED = 'push_requirements.summarized' as const;
const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The job's newest push of `branch` in a repository `inRepo` holds: the repository and the commit it moved the branch to. */
function pushedHead(pushes: readonly DomainEvent[], inRepo: (repo: string) => boolean, branch: string): { repo: string; head: string } | undefined {
  for (const e of pushes) {
    const d = e.data as { op?: unknown; repo?: unknown; refs?: unknown; heads?: unknown };
    if (d.op !== 'git.push' || typeof d.repo !== 'string' || !inRepo(d.repo) || !Array.isArray(d.refs) || !Array.isArray(d.heads)) continue;
    const at = d.refs.indexOf(`refs/heads/${branch}`);
    if (at >= 0 && typeof d.heads[at] === 'string') return { repo: d.repo, head: d.heads[at] };
  }
  return undefined;
}

/**
 * The summary of the job's evaluation of the commit its newest push moved `branch` to (part 4), for its pull request into
 * `repo`; `head` as `pr create` names it (`owner:branch`: a fork's). Undefined: that commit has no evaluation.
 */
export function pushRequirementsSummaryOf(o: { pushes: readonly DomainEvent[]; evaluations: readonly DomainEvent[] }, repo: string, head: string): string | undefined {
  const [owner, branch] = head.includes(':') ? [head.slice(0, head.indexOf(':')), head.slice(head.indexOf(':') + 1)] : [undefined, head];
  const pushed = pushedHead(o.pushes, (r) => (owner === undefined ? sameRepo(r, repo) : sameRepo(r.split('/')[0]!, owner)), branch);
  const evaluated = pushed && evaluationOf(o.evaluations, pushed.repo, pushed.head);
  return evaluated ? pushRequirementsSummary(evaluated) : undefined;
}

/**
 * After a job's push (part 4): for each branch it moved to an evaluated commit, the hopper replaces the summary in the body of
 * the branch's open pull request — only one the job may edit, as `pr edit` would — and records it. Never throws.
 */
export function pushRequirementsSummaries(o: {
  /** The job's `push_requirements.evaluated` events, newest first. */
  evaluations(jobId: string): readonly DomainEvent[];
  job(jobId: string): Job | undefined;
  owns(job: Job, repo: string, number: number): boolean;
  api(repo: string): ProxyApi | { problem: string };
  record(event: NewEvent): void;
  log(line: string): void;
}): (push: { jobId: string; repo: string; refs: readonly { ref: string; new: string }[] }) => Promise<void> {
  return async (push) => {
    const job = o.job(push.jobId);
    const api = o.api(push.repo);
    if (!job || 'problem' in api || !api.pullRequestOf) return;
    const evaluations = o.evaluations(push.jobId);
    for (const c of push.refs.filter((x) => x.ref.startsWith('refs/heads/'))) {
      const evaluated = evaluationOf(evaluations, push.repo, c.new);
      if (!evaluated) continue;
      const branch = c.ref.slice('refs/heads/'.length);
      try {
        const pull = await api.pullRequestOf(push.repo, branch);
        if (!pull || !o.owns(job, push.repo, pull.number)) continue;
        const body = withPushRequirementsSummary(pull.body, maskGitHubTokens(pushRequirementsSummary(evaluated)));
        if (body === pull.body) continue;
        await api.perform({ op: 'pr.edit', repo: push.repo, number: pull.number, body });
        o.record({ type: PUSH_REQUIREMENTS_SUMMARIZED, jobId: job.id, data: { repo: push.repo, number: pull.number, head: c.new } });
      } catch (e) {
        o.log(`hopper: push requirements: the summary on the pull request of ${push.repo} ${branch} was not changed: ${(e as Error).message}`);
      }
    }
  };
}

/** The summaries of one user's jobs (part 4): from the user's store, with the connection of each repository's account. */
export function storeSummaries(store: UserStore, api: (repo: string) => ProxyApi | { problem: string }, log: (line: string) => void) {
  const evaluations = (jobId: string) => store.events.recent(500, [PUSH_REQUIREMENTS_EVALUATED], jobId);
  return {
    of: (job: Job, repo: string, head: string) => pushRequirementsSummaryOf({ pushes: store.events.recent(500, ['github_proxy.done'], job.id), evaluations: evaluations(job.id) }, repo, head),
    pushed: pushRequirementsSummaries({
      evaluations, job: (id) => store.jobs.get(id), owns: (job, repo, number) => ownsPullRequest(store, job, repo, number, 'pr.edit') === true,
      api, record: (e) => { store.events.append(e); }, log,
    }),
  };
}
