// The token ledger from the command line (issue #2302, design.md "The token ledger"): `hopper usage tokens` reads GET
// /api/usage/tokens — the user's token use and estimated cost by repository, or by the group, split and filters it is given —,
// and with `--job` one job's, GET /api/jobs/:id/tokens. The daemon checks the filters and answers 400 for a bad one.
// `hopper usage budget [set …]` (part 3): the token budget, GET /api/token-budget, or an admin's POST /ui/api/token-budget;
// with the day caps, in all and per repository (part 5). `usage model-routing` and `usage job-budget`: cli-operator-model-routing.ts.
import { parseArgs } from 'node:util';
import { usage, type Call } from './cli-operator-call.ts';
import { MODEL_ROUTING_USAGE, modelRoutingCall } from './cli-operator-model-routing.ts';

export const USAGE_USAGE = `  hopper usage tokens [--repo <owner/repo>] [--since <date>] [--by <group>] [--split <group>]
                                                     token use and estimated cost by job, issue, repo, machine, lane, account, model or day
                                                     (default repo), each group split by a second one with --split, with the top spenders;
                                                     counts only
  hopper usage tokens --job <id>                     one job's token use and estimated cost, per model
  hopper usage budget                                the token budget: the most one job may spend before it is paused, and the
                                                     most the jobs, or each repository's, may spend in a UTC day before none starts
  hopper usage budget set [--job-tokens <n>] [--job-cost <usd>] [--day-tokens <n>] [--day-cost <usd>]
                          [--repo-day-tokens <n>] [--repo-day-cost <usd>]
                                                     change it; 0 turns that cap off
${MODEL_ROUTING_USAGE}`;

const LINE = 'usage tokens [--repo <owner/repo>] [--since <date>] [--by <group>] [--split <group>] | usage tokens --job <id> | usage budget [set [--job-tokens <n>] [--job-cost <usd>] [--day-tokens <n>] [--day-cost <usd>] [--repo-day-tokens <n>] [--repo-day-cost <usd>]]';

/** Each cap's option, and the field it sets. */
const CAPS = [['job-tokens', 'jobTokens'], ['job-cost', 'jobCostUsd'], ['day-tokens', 'dayTokens'], ['day-cost', 'dayCostUsd'], ['repo-day-tokens', 'repoDayTokens'], ['repo-day-cost', 'repoDayCostUsd']] as const;

const amount = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  if (!/^\d+(\.\d+)?$/.test(s)) throw usage(LINE);
  return Number(s);
};

export function usageCall(args: string[]): Call {
  if (args[0] === 'model-routing' || args[0] === 'job-budget') return modelRoutingCall(args);
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { job: { type: 'string' }, repo: { type: 'string' }, since: { type: 'string' }, by: { type: 'string' }, split: { type: 'string' }, ...Object.fromEntries(CAPS.map(([o]) => [o, { type: 'string' as const }])) } });
  } catch {
    throw usage(LINE);
  }
  const { values: v, positionals } = parsed;
  const ledger = v.job !== undefined || v.repo !== undefined || v.since !== undefined || v.by !== undefined || v.split !== undefined;
  const given = v as Record<string, string | undefined>;
  const caps = CAPS.some(([o]) => given[o] !== undefined);
  if (positionals[0] === 'budget' && !ledger) {
    if (positionals.length === 1 && !caps) return { role: 'viewer', path: '/api/token-budget' };
    if (positionals.length !== 2 || positionals[1] !== 'set' || !caps) throw usage(LINE);
    const body = Object.fromEntries(CAPS.flatMap(([o, field]) => { const n = amount(given[o]); return n === undefined ? [] : [[field, n]]; }));
    return { role: 'admin', path: '/ui/api/token-budget', body: async () => body };
  }
  if (caps) throw usage(LINE);
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
