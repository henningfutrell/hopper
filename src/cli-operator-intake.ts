// Request cards from the command line (issue #2220, design.md "Operator actions from the CLI"): `hopper intake list` reads
// the open request cards of every job source's last sync (GET /api/sources); `hopper intake approve|decline <key>` is the
// Intake page's Approve and Decline, on the same route (`POST /ui/api/sources/:name/intake`) with the hash of the text the
// last sync read, so the daemon's hash check, Access and events apply as they do for a click. `--as <person>` only names
// who decided, in the CLI's own session; it gives no permission of theirs.
import { parseArgs } from 'node:util';
import type { IntakeActionResult, IntakeOutcome } from './domain/intake.ts';
import type { SourceStatus } from './domain/sources.ts';
import { OperatorRefusal, usage, type Call, type Getter } from './cli-operator-call.ts';

export const INTAKE_USAGE = `  hopper intake list                                 the open request cards: each one's source, key, hash, and why it is a request
  hopper intake approve <key> [--source <name>] [--hash <sha256>] [--as <person>]
                                                     Approve: the card's text as the last sync read it (or as --hash names it) starts a job
  hopper intake decline <key> --close|--open [--source <name>] [--hash <sha256>] [--as <person>]
                                                     Decline: the issue loses the source's label; --close also closes it as not planned`;

const LINE = 'intake list | approve <key> [--source <name>] [--hash <sha256>] [--as <person>] | decline <key> --close|--open [--source <name>] [--hash <sha256>] [--as <person>]';

interface Card { source: string; key: string; title: string; repo?: string; hash: string; author: string; why: string[]; reopened?: true }

/** The open request cards of the sources' last sync, as the CLI lists them. */
function cardsOf(sources: readonly SourceStatus[]): Card[] {
  return sources.flatMap((s) => (Array.isArray(s.detail.intake) ? s.detail.intake as IntakeOutcome[] : [])
    .filter((x) => x.action === 'approve' && x.request !== undefined)
    .map((x) => ({
      source: s.name, key: x.key, title: x.title, ...(x.repo ? { repo: x.repo } : {}), hash: x.request!.hash, author: x.request!.author, why: x.request!.why,
      ...(x.request!.reopened ? { reopened: true as const } : {}),
    })));
}

const cards = async (get: Getter): Promise<Card[]> => cardsOf(((await get('/api/sources')) as { sources: SourceStatus[] }).sources);

/** `hopper intake …`; `as`: who decided, for the CLI's session. */
export function intakeCall(args: string[]): Call {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: { source: { type: 'string' }, hash: { type: 'string' }, as: { type: 'string' }, close: { type: 'boolean' }, open: { type: 'boolean' } },
  });
  const [verb, key, ...extra] = positionals;
  const named = values.source !== undefined || values.hash !== undefined || values.as !== undefined || values.close || values.open;
  if (verb === 'list' && !key && !named) return { role: 'viewer', path: '/api/sources', pick: (v) => cardsOf((v as { sources: SourceStatus[] }).sources) };
  if ((verb !== 'approve' && verb !== 'decline') || !key || extra.length > 0) throw usage(LINE);
  if (verb === 'approve' && (values.close || values.open)) throw usage(LINE);
  if (verb === 'decline' && values.close === values.open) throw usage('intake decline <key> --close|--open: name one');
  if (values.hash !== undefined && !/^[0-9a-f]{64}$/.test(values.hash)) throw new OperatorRefusal(`--hash ${values.hash}: a SHA-256, hex, as intake list gives it`);
  if (values.as !== undefined && !values.as.trim()) throw new OperatorRefusal('--as needs a name');
  return {
    role: 'operator', path: '/ui/api/sources/:name/intake',
    ...(values.as !== undefined ? { as: values.as.trim() } : {}),
    post: async (get) => {
      const found = (await cards(get)).filter((c) => c.key === key && (values.source === undefined || c.source === values.source));
      if (found.length === 0) throw new OperatorRefusal(`no open request card ${key}${values.source ? ` in ${values.source}` : ''}: hopper intake list lists them`);
      if (found.length > 1) throw new OperatorRefusal(`request card ${key} waits in ${found.map((c) => c.source).join(' and ')}: name one with --source`);
      const c = found[0]!;
      return {
        path: `/ui/api/sources/${encodeURIComponent(c.source)}/intake`,
        body: { kind: verb, keys: [key], hash: values.hash ?? c.hash, ...(verb === 'decline' ? { choice: values.close ? 'close' : 'open' } : {}) },
      };
    },
    // A key the daemon did not do (the text changed since the hash, or it is no card now) is not done: exit 2.
    exit: (answer) => (Object.keys((answer as IntakeActionResult).failed ?? {}).length > 0 ? 2 : 0),
  };
}
