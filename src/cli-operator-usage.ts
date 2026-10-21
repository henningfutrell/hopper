// The token ledger from the command line (issue #2302, design.md "The token ledger"): `hopper usage tokens` reads GET
// /api/usage/tokens — the user's token use and estimated cost by repository, or by the group, split and filters it is given —,
// and with `--job` one job's, GET /api/jobs/:id/tokens. The daemon checks the filters and answers 400 for a bad one.
import { parseArgs } from 'node:util';
import { usage, type Call } from './cli-operator-call.ts';

export const USAGE_USAGE = `  hopper usage tokens [--repo <owner/repo>] [--since <date>] [--by <group>] [--split <group>]
                                                     token use and estimated cost by job, issue, repo, machine, lane, account, model or day
                                                     (default repo), each group split by a second one with --split, with the top spenders;
                                                     counts only
  hopper usage tokens --job <id>                     one job's token use and estimated cost, per model`;

const LINE = 'usage tokens [--repo <owner/repo>] [--since <date>] [--by <group>] [--split <group>] | usage tokens --job <id>';

export function usageCall(args: string[]): Call {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { job: { type: 'string' }, repo: { type: 'string' }, since: { type: 'string' }, by: { type: 'string' }, split: { type: 'string' } } });
  } catch {
    throw usage(LINE);
  }
  const { values: v, positionals } = parsed;
  if (positionals.length !== 1 || positionals[0] !== 'tokens') throw usage(LINE);
  if (v.job !== undefined) {
    if (v.repo !== undefined || v.since !== undefined || v.by !== undefined || v.split !== undefined || !v.job) throw usage(LINE);
    return { role: 'viewer', path: `/api/jobs/${encodeURIComponent(v.job)}/tokens` };
  }
  const p = new URLSearchParams();
  for (const k of ['by', 'split', 'repo', 'since'] as const) if (v[k] !== undefined) p.set(k, v[k]);
  const q = p.toString();
  return { role: 'viewer', path: q ? `/api/usage/tokens?${q}` : '/api/usage/tokens' };
}
