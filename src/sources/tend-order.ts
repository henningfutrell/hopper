// The head of a tending queue as a decider call (issue #796, design.md "Decider calls"): when two or more waiting pull
// requests of one job repository need tending, Jev first (`merge-order`) picks the one rebased and merged next, from the
// rules' order (`tendOrder`), the first 10. Applied — active and sure —, its pick is the head; else the rules' first,
// which a pick not applied is compared with. Choosing an order deletes, sends and publishes nothing: never consequential.
import type { TendDue } from '../domain/tending-queue.ts';
import type { Job, JevFirst, PullRequestSeen } from '../domain/types.ts';

/** At most this many pull requests are options. */
export const MAX_ORDER_OPTIONS = 10;

const INSTRUCTIONS = 'Pick the pull request to rebase and merge next. Each merge moves the base branch, so the others may get '
  + 'merge conflicts again; one is tended at a time. Prefer the one whose merge the others depend on, the smaller change, the one '
  + 'least likely to conflict, the higher priority, and the older one. The options are in the rules\' order.';

const numberOf = (url: string): string => /\/pull\/(\d+)/.exec(url)?.[1] ?? url;

/** The next tend of `repo`: `ordered` in the rules' order, at least one. */
export async function pickHead(jev: JevFirst | undefined, repo: string, ordered: TendDue[], get: (id: string) => Job | undefined): Promise<TendDue> {
  const rules = ordered[0]!;
  if (!jev || ordered.length < 2) return rules;
  const options = ordered.slice(0, MAX_ORDER_OPTIONS);
  const facts = options.map((d) => {
    const job = get(d.jobId);
    const seen = (job?.sourceState?.source as { seen?: PullRequestSeen } | undefined)?.seen;
    return {
      option: d.jobId, pullRequest: Number(numberOf(d.pullRequest)), step: d.step, ...(job?.source?.title ? { title: job.source.title } : {}),
      priority: job?.priority ?? 0, ...(seen?.openedAt ? { openedAt: seen.openedAt } : {}), ...(seen?.base ? { base: seen.base } : {}),
      ...(seen ? { checks: seen.checks } : {}),
    };
  });
  const out = await jev.decide({
    point: 'merge-order', instructions: INSTRUCTIONS, state: { repository: repo, pullRequests: facts },
    options: options.map((d) => ({ id: d.jobId, label: `#${numberOf(d.pullRequest)} ${get(d.jobId)?.source?.title ?? ''}: ${d.step === 'rebase' ? 'rebase' : 'fix the checks'}` })),
    consequential: [], rules: rules.jobId,
  });
  return (out.asked && out.applied && options.find((d) => d.jobId === out.pick)) || rules;
}
