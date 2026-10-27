// Model routing from the command line (issue #2848, part 2, design.md "Model routing"): `hopper usage model-routing` reads
// GET /api/model-routing; `on` and `off` turn it on and off, and `set --file <json>` saves the fields the file names, each
// whole — an admin's POST /ui/api/model-routing. `hopper usage job-budget <job id>` sets a person's job budget on one job
// (POST /ui/api/jobs/:id/budget, an operator's). The daemon checks the setting and answers 400 for a bad one.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const MODEL_ROUTING_USAGE = `  hopper usage model-routing                         model routing: which model a new job runs on, from the class of its
                                                     work, its rules, and the budget of each model choice
  hopper usage model-routing on|off                  turn it on or off
  hopper usage model-routing set --file <json>       change the fields the file names (on, executors, cheap, strong, rules,
                                                     repos, escalate), each whole
  hopper usage job-budget <job id> [--job-tokens <n>] [--job-cost <usd>]
                                                     a job's own budget, over its model's and the token budget's; 0 takes
                                                     that cap off`;

const LINE = 'usage model-routing [on|off|set --file <json>] | usage job-budget <job id> [--job-tokens <n>] [--job-cost <usd>]';

const amount = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  if (!/^\d+(\.\d+)?$/.test(s)) throw usage(LINE);
  return Number(s);
};

function fileBody(file: string): unknown {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (e) { throw new OperatorRefusal(`--file ${file}: ${(e as Error).message}`); }
  try { return JSON.parse(text); } catch (e) { throw new OperatorRefusal(`--file ${file}: not JSON (${(e as Error).message})`); }
}

export function modelRoutingCall(args: string[]): Call {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { file: { type: 'string' }, 'job-tokens': { type: 'string' }, 'job-cost': { type: 'string' } } });
  } catch {
    throw usage(LINE);
  }
  const { values: v, positionals: [what, verb, ...extra] } = parsed;
  if (extra.length > 0) throw usage(LINE);
  if (what === 'job-budget') {
    const jobTokens = amount(v['job-tokens']), jobCostUsd = amount(v['job-cost']);
    if (!verb || v.file !== undefined || (jobTokens === undefined && jobCostUsd === undefined)) throw usage(LINE);
    const body = { ...(jobTokens !== undefined ? { jobTokens } : {}), ...(jobCostUsd !== undefined ? { jobCostUsd } : {}) };
    return { role: 'operator', path: `/ui/api/jobs/${encodeURIComponent(verb)}/budget`, body: async () => body };
  }
  if (what !== 'model-routing' || v['job-tokens'] !== undefined || v['job-cost'] !== undefined) throw usage(LINE);
  if (verb === undefined && v.file === undefined) return { role: 'viewer', path: '/api/model-routing' };
  if ((verb === 'on' || verb === 'off') && v.file === undefined) return { role: 'admin', path: '/ui/api/model-routing', body: async () => ({ on: verb === 'on' }) };
  if (verb !== 'set' || v.file === undefined) throw usage(LINE);
  const file = v.file;
  return { role: 'admin', path: '/ui/api/model-routing', body: async () => fileBody(file) };
}
