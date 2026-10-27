// Repository memory from the command line (issue #2847, design.md "Repository memory"): `hopper memory list` lists the
// memory entries (GET /api/repo-memory), `add` adds one, `edit` changes one, and `approve`, `disable`, `enable` and
// `remove` act on one — each POST /ui/api/repo-memory, as on the API. The settings are the config record `repo-memory`.
import { parseArgs } from 'node:util';
import type { RepoMemoryView } from './domain/repo-memory.ts';
import { usage, type Call } from './cli-operator-call.ts';

export const MEMORY_USAGE = `  hopper memory list [--repo <owner/name>]           the memory entries jobs learned, of one repository or of all, newest change first
  hopper memory add --repo <owner/name> --kind convention|fix [--area <path>] --text <text>
                                                     add an entry: approved at once, and offered to the next job of the repository
  hopper memory edit <id> [--kind convention|fix] [--area <path>|--no-area] [--text <text>]
                                                     change an entry: its age is renewed and a flag cleared
  hopper memory approve|disable|enable|remove <id>   approve a proposed, flagged or expired entry; take it out of use or back; remove it`;

const LINE = 'memory list [--repo <owner/name>] | memory add --repo <owner/name> --kind <kind> [--area <path>] --text <text> | memory edit <id> [--kind <kind>] [--area <path>|--no-area] [--text <text>] | memory approve|disable|enable|remove <id>';

const ACTS = ['approve', 'disable', 'enable', 'remove'] as const;

export function memoryCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    repo: { type: 'string' }, kind: { type: 'string' }, area: { type: 'string' }, 'no-area': { type: 'boolean' }, text: { type: 'string' },
  } });
  const [verb, id, ...extra] = positionals;
  const { repo, kind, area, text } = values;
  const noArea = values['no-area'] === true;
  if (extra.length > 0) throw usage(LINE);
  if (verb === 'list' && id === undefined && !kind && area === undefined && !noArea && text === undefined) {
    return { role: 'viewer', path: `/api/repo-memory${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`, pick: (v) => (v as RepoMemoryView).entries };
  }
  if (verb === 'add' && id === undefined && repo && kind && text !== undefined && !noArea) {
    return { role: 'admin', path: '/ui/api/repo-memory', body: async () => ({ action: 'add', repo, kind, ...(area !== undefined ? { area } : {}), text }) };
  }
  if (verb === 'edit' && id && !repo && !(noArea && area !== undefined) && (kind || area !== undefined || noArea || text !== undefined)) {
    return { role: 'admin', path: '/ui/api/repo-memory', body: async () => ({ action: 'edit', id, ...(kind ? { kind } : {}), ...(noArea ? { area: null } : area !== undefined ? { area } : {}), ...(text !== undefined ? { text } : {}) }) };
  }
  const act = ACTS.find((a) => a === verb);
  if (!act || !id || Object.keys(values).length > 0) throw usage(LINE);
  return { role: 'admin', path: '/ui/api/repo-memory', body: async () => ({ action: act, id }) };
}
