// Merge now and Close PR from the command line (issue #677, design.md "PR waiting"): `hopper pr merge|close <n>` finds the
// card of pull request <n> on the Pull requests list (GET /api/pull-requests) and acts on it as the card's buttons do,
// on the same route. `--repo` picks one when two repositories have a pull request of that number. `hopper prs` reads the
// list (issue #637); `hopper yolo <repo> on|off|default` sets one repository's yolo mode. `hopper pr tend <n>` is Tend again
// (issue #1010), on a pull request the hopper gave up on.
import { parseArgs } from 'node:util';
import type { PullRequestsView } from './domain/types.ts';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const PR_USAGE = `  hopper pr merge <n> [--repo <owner/repo>]          Merge now: merge waiting pull request <n>, whatever yolo mode and its checks say
  hopper pr close <n> [--repo <owner/repo>]          Close PR: close waiting pull request <n> without a merge
  hopper pr tend <n> [--repo <owner/repo>]           Tend again: the hopper gave up on pull request <n>; a new job takes the same step`;

const LINE = 'pr merge|close|tend <n> [--repo <owner/repo>]';

export function prCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { repo: { type: 'string' } } });
  const [verb, raw, ...extra] = positionals;
  if ((verb !== 'merge' && verb !== 'close' && verb !== 'tend') || !raw || !/^\d+$/.test(raw) || extra.length > 0) throw usage(LINE);
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

const YOLO_OF: Record<string, boolean | null> = { on: true, off: false, default: null };

export function prsCall(args: string[]): Call {
  if (args.length > 0) throw usage('prs');
  return { role: 'viewer', path: '/api/pull-requests' };
}

export function yoloCall(args: string[]): Call {
  const [repo, mode, ...extra] = args;
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo) || mode === undefined || !(mode in YOLO_OF) || extra.length > 0) throw usage('yolo <owner/repo> on|off|default');
  return { role: 'admin', path: '/ui/api/yolo-mode', body: async () => ({ repos: { [repo]: YOLO_OF[mode] } }) };
}
