// The operator's actions from the command line (issue #374, design.md "Operator actions from the CLI"):
// accept, reject or run a job again, order the queue, set the queue gate, answer, close or dismiss a
// question. Each is the UI's own `POST /ui/api/*` on the running daemon, so the daemon's checks, events and
// runtime (a source told, an answer typed into a waiting pane) apply as they do for a click. The session it
// goes under is minted here, in the database, for the one call, and dropped after it: whoever runs the CLI
// holds the database's credentials, the daemon's own trust, so a session of theirs adds none.
import { parseArgs } from 'node:util';
import { QUEUE_GATE_MODES, type QueueGate, type UiRole, type User } from './domain/types.ts';
import type { InstanceStore } from './domain/ports.ts';
import { SESSION_HEADER } from './http/ui/guard.ts';
import { createUiSessions } from './http/ui/sessions.ts';
import { loadSignInConfig } from './auth/index.ts';

export const OPERATOR_COMMANDS = ['job', 'queue', 'question'] as const;

export const OPERATOR_USAGE = `  hopper job accept <id>                             let a waiting job through the queue gate: it joins the end of the user order
  hopper job reject <id> [--reason <text>]           a waiting job ends rejected, the reason kept on it
  hopper job rerun <id>                              run a failed, finished or rejected job again
  hopper queue order <id>...                         the user order: these waiting jobs, first to last, before every other
  hopper queue gate <mode> [--per-hour <n>|none]     the queue gate: ${QUEUE_GATE_MODES.join(' or ')}; auto-accept at most <n> an hour
  hopper question answer <id> <text>                 answer an open question; the job waiting on it resumes
  hopper question close <id>                         close an open question without answering
  hopper question dismiss <id>                       drop an open question; a job waiting on it is cancelled`;

/** A refusal: the message, exit 2. */
export class OperatorRefusal extends Error {}

export interface OperatorIo {
  env: Record<string, string | undefined>;
  out(text: string): void;
}

interface Call { role: UiRole; path: string; body: (get: Getter) => Promise<unknown> }
type Getter = (path: string) => Promise<unknown>;

/** A session lives this long at most, whatever the sign-in config's session lengths: one call, then it is dropped. */
const SESSION_MS = 5 * 60_000;
/** Who a CLI session is: no realm the sign-in config names, so a reconcile drops it. */
const CLI_IDENTITY = { realm: 'cli', subject: 'operator-cli', name: 'operator CLI', groups: [] };

const usage = (line: string): OperatorRefusal => new OperatorRefusal(`usage: hopper ${line}`);

function jobCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' } } });
  const [verb, id, ...extra] = positionals;
  if (!id || extra.length > 0) throw usage('job accept|reject|rerun <id>');
  const at = `/ui/api/jobs/${encodeURIComponent(id)}`;
  if (verb === 'reject') return { role: 'operator', path: `${at}/reject`, body: async () => (values.reason === undefined ? {} : { reason: values.reason }) };
  if (values.reason !== undefined) throw usage('job reject <id> --reason <text>');
  if (verb === 'rerun') return { role: 'operator', path: `${at}/rerun`, body: async () => ({}) };
  if (verb === 'accept') {
    // As the Queue view's Accept: the accepted waiting jobs in queue order, then this one.
    return { role: 'operator', path: '/ui/api/queue/order', body: async (get) => {
      const { waiting } = await get('/api/queue') as { waiting: { id: string; accepted?: boolean }[] };
      return { jobIds: [...waiting.filter((j) => j.accepted !== false && j.id !== id).map((j) => j.id), id] };
    } };
  }
  throw usage('job accept|reject|rerun <id>');
}

function perHour(raw: string): number | null {
  if (raw === 'none') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new OperatorRefusal(`--per-hour must be a whole number of at least 1, or none; not ${raw}`);
  return n;
}

function queueCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { 'per-hour': { type: 'string' } } });
  const [verb, ...rest] = positionals;
  if (verb === 'order' && values['per-hour'] === undefined) {
    if (rest.length === 0) throw usage('queue order <id>...');
    return { role: 'operator', path: '/ui/api/queue/order', body: async () => ({ jobIds: rest }) };
  }
  if (verb === 'gate' && rest.length === 1) {
    const mode = rest[0]!;
    if (!(QUEUE_GATE_MODES as readonly string[]).includes(mode)) throw new OperatorRefusal(`unknown queue gate ${mode}; one of ${QUEUE_GATE_MODES.join(', ')}`);
    const raw = values['per-hour'];
    const limit = raw === undefined ? undefined : perHour(raw);
    // Without --per-hour the throttle stays as it is.
    return { role: 'admin', path: '/ui/api/queue-gate', body: async (get) => ({
      mode, autoAcceptPerHour: limit !== undefined ? limit : ((await get('/api/queue')) as { gate: QueueGate }).gate.autoAcceptPerHour,
    }) };
  }
  throw usage('queue order <id>... | hopper queue gate <mode> [--per-hour <n>|none]');
}

function questionCall(args: string[]): Call {
  const [verb, id, ...rest] = args;
  if (verb === 'answer') {
    const answer = rest.join(' ').trim();
    if (!id || !answer) throw usage('question answer <id> <text>');
    return { role: 'operator', path: `/ui/api/questions/${encodeURIComponent(id)}/answer`, body: async () => ({ answer }) };
  }
  if ((verb === 'close' || verb === 'dismiss') && id && rest.length === 0) {
    return { role: 'operator', path: `/ui/api/questions/${encodeURIComponent(id)}/${verb}`, body: async () => ({}) };
  }
  throw usage('question answer <id> <text> | close <id> | dismiss <id>');
}

function callOf(command: string, args: string[]): Call {
  if (command === 'job') return jobCall(args);
  if (command === 'queue') return queueCall(args);
  return questionCall(args);
}

/** The daemon's URL: --url, else HOPPER_URL, else this machine's daemon on HOPPER_PORT (default 4790). */
function daemonUrl(raw: string | undefined, env: Record<string, string | undefined>): URL {
  const text = raw ?? env.HOPPER_URL ?? `http://127.0.0.1:${env.HOPPER_PORT || '4790'}`;
  try {
    return new URL(text);
  } catch {
    throw new OperatorRefusal(`--url ${text} is not a URL`);
  }
}

/** Take `--url <url>` and `--user <id>` out of `args`, wherever they are. */
function common(args: string[]): { rest: string[]; url?: string; user?: string } {
  const rest: string[] = [];
  const found: { url?: string; user?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--url' || a === '--user') {
      const v = args[++i];
      if (v === undefined) throw new OperatorRefusal(`${a} needs a value`);
      found[a === '--url' ? 'url' : 'user'] = v;
    } else rest.push(a);
  }
  return { rest, ...found };
}

/**
 * `hopper job|queue|question …`: one operator action on the running daemon, as `userOf` names the user.
 * Prints the daemon's answer as JSON.
 */
export async function runOperatorAction(
  instance: InstanceStore, command: string, args: string[], userOf: (id: string | undefined) => User, io: OperatorIo,
): Promise<void> {
  const { rest, url: rawUrl, user: userId } = common(args);
  const call = callOf(command, rest);
  const url = daemonUrl(rawUrl, io.env);
  const user = userOf(userId);
  // A CLI session is no gateway realm's: no token of one is ever checked for it.
  const signIn = { config: () => loadSignInConfig(instance.signInConfig.read()), checkGateway: async () => ({ ok: false as const, status: 403 as const, error: 'the operator CLI checks no gateway token' }) };
  const sessions = createUiSessions({ repo: instance.uiSessions, clock: { now: () => new Date() }, signIn });
  const session = sessions.create({ role: call.role, identity: CLI_IDENTITY, userId: user.id, lastsMs: SESSION_MS });
  const send = async (path: string, body?: unknown): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetch(new URL(path, url), {
        method: body === undefined ? 'GET' : 'POST',
        headers: { [SESSION_HEADER]: session.token, origin: url.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      throw new Error(`no hopper answers at ${url.origin} (${(e as Error).message}): is the daemon running? --url names it`, { cause: e });
    }
    const text = await res.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    if (res.ok) return parsed;
    const why = (parsed as { error?: string } | undefined)?.error ?? text;
    if (res.status >= 400 && res.status < 500) throw new OperatorRefusal(`refused (${res.status}): ${why}`);
    throw new Error(`the hopper failed (${res.status}): ${why}`);
  };
  try {
    io.out(`${JSON.stringify(await send(call.path, await call.body(send)), null, 2)}\n`);
  } finally {
    sessions.drop(session.token, 'logout');
  }
}
