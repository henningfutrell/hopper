// Grades from the command line (issue #2845, design.md "Grades"): `hopper grades` reads GET /api/grades — the user's grades
// rolled up by executor, or by the group and filters it is given —, and with `--job` one job's, GET /api/jobs/:id/grade.
// `hopper grades set <job> <1-5> [--note <text>]` gives the job a user grade through POST /ui/api/jobs/:id/grade. The
// daemon checks the filters and answers 400 for a bad one.
import { parseArgs } from 'node:util';
import { usage, type Call } from './cli-operator-call.ts';

export const GRADES_USAGE = `  hopper grades [--by <group>] [--repo <owner/repo>] [--since <date>]
                                                     the automatic and user grades of ended jobs by executor, model, repo,
                                                     kind or machine (default executor), with the jobs
  hopper grades --job <id>                           one job's grades: the automatic grade's breakdown, the user grade and its history
  hopper grades set <job> <1-5> [--note <text>]      give a job a user grade; a second one edits it`;

const LINE = 'grades [--by <group>] [--repo <owner/repo>] [--since <date>] | grades --job <id> | grades set <job> <1-5> [--note <text>]';

export function gradesCall(args: string[]): Call {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { job: { type: 'string' }, by: { type: 'string' }, repo: { type: 'string' }, since: { type: 'string' }, note: { type: 'string' } } });
  } catch {
    throw usage(LINE);
  }
  const { values: v, positionals } = parsed;
  const filters = v.by !== undefined || v.repo !== undefined || v.since !== undefined;
  if (positionals[0] === 'set') {
    const [, job, score] = positionals;
    if (positionals.length !== 3 || !job || !/^[1-5]$/.test(score ?? '') || filters || v.job !== undefined) throw usage(LINE);
    const body = { score: Number(score), ...(v.note !== undefined ? { note: v.note } : {}) };
    return { role: 'operator', path: `/ui/api/jobs/${encodeURIComponent(job)}/grade`, body: async () => body };
  }
  if (positionals.length > 0 || v.note !== undefined) throw usage(LINE);
  if (v.job !== undefined) {
    if (filters || !v.job) throw usage(LINE);
    return { role: 'viewer', path: `/api/jobs/${encodeURIComponent(v.job)}/grade` };
  }
  const p = new URLSearchParams();
  for (const k of ['by', 'repo', 'since'] as const) if (v[k] !== undefined) p.set(k, v[k]);
  const q = p.toString();
  return { role: 'viewer', path: q ? `/api/grades?${q}` : '/api/grades' };
}
