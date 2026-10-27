// Grades from the command line (issue #2845, design.md "Grades"): `hopper grades` reads GET /api/grades — the user's grades
// rolled up by executor, or by the group and filters it is given —, and with `--job` one job's, GET /api/jobs/:id/grade.
// `hopper grades set <job> <1-5> [--note <text>]` gives the job a user grade through POST /ui/api/jobs/:id/grade. Part 5,
// item grades: `--items` reads GET /api/grades/items, `--item <issue URL>` GET /api/grades/item, and `set` with an issue URL
// in place of a job grades the work item through POST /ui/api/grades/item. The daemon checks the filters and answers 400
// for a bad one.
import { parseArgs } from 'node:util';
import { usage, type Call } from './cli-operator-call.ts';

export const GRADES_USAGE = `  hopper grades [--items] [--by <group>] [--repo <owner/repo>] [--since <date>]
                                                     the automatic and user grades of ended jobs (--items: of ended
                                                     work items) by executor, model, repo, kind or machine (default
                                                     executor), with the jobs or the items
  hopper grades --job <id> | --item <issue URL>      one job's or work item's grades: the automatic grade's breakdown,
                                                     the user grade and its history
  hopper grades set <job | issue URL> <1-5> [--note <text>]
                                                     give a job or a work item a user grade; a second one edits it`;

const LINE = 'grades [--items] [--by <group>] [--repo <owner/repo>] [--since <date>] | grades --job <id> | grades --item <issue URL> | grades set <job | issue URL> <1-5> [--note <text>]';

/** An item's source key is its issue's URL; a job id never is one. */
const isItem = (s: string): boolean => /^https?:\/\//.test(s);

export function gradesCall(args: string[]): Call {
  let parsed;
  try {
    parsed = parseArgs({
      args, allowPositionals: true, strict: true,
      options: { job: { type: 'string' }, item: { type: 'string' }, items: { type: 'boolean' }, by: { type: 'string' }, repo: { type: 'string' }, since: { type: 'string' }, note: { type: 'string' } },
    });
  } catch {
    throw usage(LINE);
  }
  const { values: v, positionals } = parsed;
  const filters = v.by !== undefined || v.repo !== undefined || v.since !== undefined;
  const one = (v.job !== undefined ? 1 : 0) + (v.item !== undefined ? 1 : 0) + (v.items ? 1 : 0);
  if (positionals[0] === 'set') {
    const [, target, score] = positionals;
    if (positionals.length !== 3 || !target || !/^[1-5]$/.test(score ?? '') || filters || one > 0) throw usage(LINE);
    const note = v.note !== undefined ? { note: v.note } : {};
    if (isItem(target)) return { role: 'operator', path: '/ui/api/grades/item', body: async () => ({ key: target, score: Number(score), ...note }) };
    return { role: 'operator', path: `/ui/api/jobs/${encodeURIComponent(target)}/grade`, body: async () => ({ score: Number(score), ...note }) };
  }
  if (positionals.length > 0 || v.note !== undefined || one > 1) throw usage(LINE);
  if (v.job !== undefined || v.item !== undefined) {
    if (filters || !(v.job ?? v.item)) throw usage(LINE);
    return v.job !== undefined
      ? { role: 'viewer', path: `/api/jobs/${encodeURIComponent(v.job)}/grade` }
      : { role: 'viewer', path: `/api/grades/item?key=${encodeURIComponent(v.item!)}` };
  }
  const p = new URLSearchParams();
  for (const k of ['by', 'repo', 'since'] as const) if (v[k] !== undefined) p.set(k, v[k]);
  const q = p.toString();
  const base = v.items ? '/api/grades/items' : '/api/grades';
  return { role: 'viewer', path: q ? `${base}?${q}` : base };
}
