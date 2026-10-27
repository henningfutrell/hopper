// Planned work from the command line (issue #2861, design.md "Planned work"): `hopper plan list` reads GET
// /api/planned-work/plans, `hopper plan show <plan>` GET /api/planned-work, and `hopper plan export <plan> --format csv|json`
// GET /api/planned-work/export — the same routes the Planned work tab reads, so the CLI, the API and the UI answer the same
// data, roll-up and export. The CSV is printed as the daemon answers it. `hopper plan import <issue> [--sync github|off]`
// keeps a plan from an issue's sub-issues (POST /ui/api/planned-work/import). The daemon checks the plan and answers 404
// for one the plan store does not keep.
import { parseArgs } from 'node:util';
import { usage, type Call } from './cli-operator-call.ts';

export const PLAN_USAGE = `  hopper plan list                                   the work plans the plan store keeps, each rolled up
  hopper plan show <plan>                            one work plan (owner/name#number or its issue URL): its plan pieces,
                                                     plan tasks, jobs, statuses and plan artifacts
  hopper plan export <plan> --format csv|json        the work plan as CSV (a row per plan task) or as nested JSON, as the
                                                     Planned work tab saves it
  hopper plan import <issue> [--sync github|off]     keep the work plan of an issue's sub-issues in the plan store`;

const LINE = 'plan list | plan show <plan> | plan export <plan> --format csv|json | plan import <issue> [--sync github|off]';

export function planCall(args: string[]): Call {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { format: { type: 'string' }, sync: { type: 'string' } } });
  } catch {
    throw usage(LINE);
  }
  const { values: v, positionals: [verb, plan, ...rest] } = parsed;
  if (rest.length > 0) throw usage(LINE);
  if (verb === 'list' && plan === undefined && v.format === undefined && v.sync === undefined) return { role: 'viewer', path: '/api/planned-work/plans' };
  if (!plan) throw usage(LINE);
  if (verb === 'show' && v.format === undefined && v.sync === undefined) return { role: 'viewer', path: `/api/planned-work?plan=${encodeURIComponent(plan)}` };
  if (verb === 'export' && (v.format === 'csv' || v.format === 'json') && v.sync === undefined) {
    return { role: 'viewer', path: `/api/planned-work/export?plan=${encodeURIComponent(plan)}&format=${v.format}`, raw: v.format === 'csv' };
  }
  if (verb === 'import' && v.format === undefined && (v.sync === undefined || v.sync === 'github' || v.sync === 'off')) {
    return { role: 'operator', path: '/ui/api/planned-work/import', body: async () => ({ issue: plan, ...(v.sync ? { sync: v.sync } : {}) }) };
  }
  throw usage(LINE);
}
