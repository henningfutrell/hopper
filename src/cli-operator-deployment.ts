// A job's deployment from the command line (issue #2775 part 2, design.md "Kept delivery tracks"): `hopper deployment --job
// <id>` reads the job's kept delivery track — where its change is, or its deployment record — (GET /api/delivery-tracks);
// with `--expect deploy|none` and an optional `--note` it flips the job's deployment expectation (POST
// /ui/api/delivery-tracks/deploy|no-deploy), refused once its deployment completed. `--list` reads the deployment records
// on their own (GET /api/deployments), filtered by `--repo`, `--target` and `--kind`.
import { parseArgs } from 'node:util';
import { usage, type Call } from './cli-operator-call.ts';

export const DEPLOYMENT_USAGE = `  hopper deployment --job <id> [--expect deploy|none [--note <text>]]
                                                     the job's kept delivery track: the step its change is in and
                                                     what it waits on, or its deployment record; with --expect, flip
                                                     what the job is expected to deploy (refused once its deployment
                                                     completed: that record is final)
  hopper deployment --list [--repo <owner/repo>] [--target <name>] [--kind deploy|none]
                                                     the deployment records, newest first`;

const LINE = 'deployment --job <id> [--expect deploy|none [--note <text>]] | --list [--repo <owner/repo>] [--target <name>] [--kind deploy|none]';

export function deploymentCall(args: string[]): Call {
  let v;
  try {
    ({ values: v } = parseArgs({ args, strict: true, options: { job: { type: 'string' }, expect: { type: 'string' }, note: { type: 'string' }, list: { type: 'boolean' }, repo: { type: 'string' }, target: { type: 'string' }, kind: { type: 'string' } } }));
  } catch {
    throw usage(LINE);
  }
  const filters = (['repo', 'kind', 'target'] as const).filter((k) => v[k] !== undefined);
  if (v.list) {
    if (v.job !== undefined || v.expect !== undefined || v.note !== undefined || filters.some((k) => !v[k])) throw usage(LINE);
    const q = new URLSearchParams(filters.map((k) => [k, v[k]!])).toString();
    return { role: 'viewer', path: `/api/deployments${q ? `?${q}` : ''}` };
  }
  if (!v.job || filters.length > 0 || (v.note !== undefined && v.expect === undefined)) throw usage(LINE);
  if (v.expect === undefined) return { role: 'viewer', path: `/api/delivery-tracks?${new URLSearchParams({ job: v.job }).toString()}` };
  if (v.expect !== 'deploy' && v.expect !== 'none') throw usage(LINE);
  const path = `/ui/api/delivery-tracks/${v.expect === 'none' ? 'no-deploy' : 'deploy'}`;
  const body = { job: v.job, ...(v.note ? { note: v.note } : {}) };
  return { role: 'operator', path, post: async () => ({ path, body }) };
}
