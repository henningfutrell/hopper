// Search from the command line (issue #945, design.md "Search"): `hopper search <words>…` with the filters reads
// GET /api/search, `--suggest` the type-ahead, `--index` the index's state, and `--reindex` asks for the backfill
// (POST /ui/api/search/reindex), on the routes the UI and an agent use. The daemon checks the filters and answers 400 for
// a bad one; every hit is decided by Access for the CLI's user, as in the UI.
import { parseArgs } from 'node:util';
import { usage, type Call } from './cli-operator-call.ts';

export const SEARCH_USAGE = `  hopper search [<words>...] [--type <type>]... [--status <status>]... [--label <label>]... [--repo <owner/repo>]...
               [--from <ISO time>] [--to <ISO time>] [--limit <n>] [--offset <n>]
                                                     search the jobs: their words, the hits with the matched words marked, the facet counts
  hopper search --suggest <words>                    job titles whose words start with these, for type-ahead
  hopper search --index                              the index's state: ok, degraded or not set up, the updates waiting, the backfill
  hopper search --reindex                            build the index again from the database, in the background`;

const LINE = 'search [<words>...] [--type|--status|--label|--repo <v>]... [--from|--to <ISO time>] [--limit|--offset <n>] | --suggest <words> | --index | --reindex';

const many = { type: 'string', multiple: true } as const;

export function searchCall(args: string[]): Call {
  let parsed;
  try {
    parsed = parseArgs({
      args, allowPositionals: true, strict: true,
      options: { type: many, status: many, label: many, repo: many, from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'string' }, offset: { type: 'string' },
        suggest: { type: 'boolean' }, index: { type: 'boolean' }, reindex: { type: 'boolean' } },
    });
  } catch {
    throw usage(LINE);
  }
  const { values: v, positionals } = parsed;
  const words = positionals.join(' ');
  const filtered = ['type', 'status', 'label', 'repo', 'from', 'to', 'limit', 'offset'].some((k) => v[k as keyof typeof v] !== undefined);
  const modes = [v.suggest, v.index, v.reindex].filter(Boolean).length;
  if (modes > 1 || (modes === 1 && filtered)) throw usage(LINE);
  if (v.index) { if (words) throw usage(LINE); return { role: 'viewer', path: '/api/search/status' }; }
  if (v.reindex) { if (words) throw usage(LINE); return { role: 'operator', path: '/ui/api/search/reindex', body: async () => ({}) }; }
  if (v.suggest) {
    if (!words) throw usage(LINE);
    return { role: 'viewer', path: `/api/search/suggest?${new URLSearchParams({ q: words })}` };
  }
  const p = new URLSearchParams();
  if (words) p.set('q', words);
  for (const k of ['type', 'status', 'label', 'repo'] as const) for (const x of v[k] ?? []) p.append(k, x);
  for (const k of ['from', 'to', 'limit', 'offset'] as const) if (v[k] !== undefined) p.set(k, v[k]);
  const q = p.toString();
  return { role: 'viewer', path: q ? `/api/search?${q}` : '/api/search' };
}
