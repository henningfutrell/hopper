// Merge now and Close PR from the command line (issue #677, design.md "PR waiting"): `hopper pr merge|close <n>` finds the
// card of pull request <n> on the Pull requests list (GET /api/pull-requests) and acts on it as the card's buttons do,
// on the same route. `--repo` picks one when two repositories have a pull request of that number.
import { parseArgs } from 'node:util';
import type { PullRequestsView } from './domain/types.ts';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const PR_USAGE = `  hopper pr merge <n> [--repo <owner/repo>]          Merge now: merge waiting pull request <n>, whatever yolo mode and its checks say
  hopper pr close <n> [--repo <owner/repo>]          Close PR: close waiting pull request <n> without a merge`;

const LINE = 'pr merge|close <n> [--repo <owner/repo>]';

export function prCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { repo: { type: 'string' } } });
  const [verb, raw, ...extra] = positionals;
  if ((verb !== 'merge' && verb !== 'close') || !raw || !/^\d+$/.test(raw) || extra.length > 0) throw usage(LINE);
  const number = Number(raw);
  const repo = values.repo?.toLowerCase();
  return {
    role: 'operator', path: `/ui/api/pull-requests/${verb}`,
    body: async (get) => {
      const view = (await get('/api/pull-requests')) as PullRequestsView;
      const cards = view.repos.flatMap((r) => r.pullRequests)
        .filter((c) => c.state === 'open' && c.pullRequest?.number === number && (repo === undefined || c.repo.toLowerCase() === repo));
      if (cards.length === 0) throw new OperatorRefusal(`no waiting pull request #${number}${values.repo ? ` in ${values.repo}` : ''}: hopper prs lists them`);
      if (cards.length > 1) throw new OperatorRefusal(`pull request #${number} waits in ${cards.map((c) => c.repo).join(' and ')}: name one with --repo`);
      return { jobId: cards[0]!.jobId };
    },
  };
}
