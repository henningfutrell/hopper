// The operator's actions from the command line (issue #374, design.md "Operator actions from the CLI"):
// accept, reject or run a job again, order the queue, set the queue gate, answer, close or dismiss a
// question; and the Failures actions (issue #623): list, release or resolve a problem, list or resolve a hand-off,
// list or run a failure again; the Pull requests list, yolo mode per repository and the done-check backfill (issue #637);
// the auto-park timeouts (issue #650); the TypeSafe API key, read from stdin, never an argument (issue #657).
// the proposals (issue #651): list them, show one's paths, select paths to continue with, ask for more, steer, reject all;
// the artifacts (issue #673): list, get, share, revoke, remove.
// Each is the UI's own `POST /ui/api/*` on the running daemon, so the daemon's checks, events and
// runtime (a source told, an answer typed into a waiting pane) apply as they do for a click. The session it
// goes under is minted here, in the database, for the one call, and dropped after it: whoever runs the CLI
// holds the database's credentials, the daemon's own trust, so a session of theirs adds none.
import { parseArgs } from 'node:util';
import { HANDOFF_RESOLUTIONS, QUEUE_GATE_MODES, type FailuresView, type QueueGate, type ReviewItemView, type UiRole, type User } from './domain/types.ts';
import type { InstanceStore } from './domain/ports.ts';
import { SESSION_HEADER } from './http/ui/guard.ts';
import { CLI_REALM, createUiSessions } from './http/ui/sessions.ts';
import { loadSignInConfig } from './auth/index.ts';

export const OPERATOR_COMMANDS = ['job', 'queue', 'question', 'problem', 'handoff', 'failure', 'prs', 'yolo', 'backfill', 'auto-park', 'proposal', 'typesafe-key', 'artifact'] as const;

export const OPERATOR_USAGE = `  hopper job accept <id>                             let a waiting job through the queue gate: it joins the end of the user order
  hopper job reject <id> [--reason <text>]           a waiting job ends rejected, the reason kept on it
  hopper job rerun <id>                              run a failed, finished or rejected job again; it runs its item's approved text
  hopper job keep-original <id>                      a job held because its item changed: it runs the original text
  hopper job accept-new-text <id>                    a job held because its item changed: it runs the new text (the owner only, as Access decides)
  hopper queue order <id>...                         the user order: these waiting jobs, first to last, before every other
  hopper queue gate <mode> [--per-hour <n>|none]     the queue gate: ${QUEUE_GATE_MODES.join(' or ')}; auto-accept at most <n> an hour
  hopper question answer <id> <text>                 answer an open question; the job waiting on it resumes
  hopper question close <id>                         close an open question without answering
  hopper question dismiss <id>                       drop an open question; a job waiting on it is cancelled
  hopper problem list                                the open problems, each with its jobs and the jobs it holds
  hopper problem release <id>                        a problem's held jobs run again now; the problem stays open
  hopper problem resolve <id> [--note <text>]        resolve a problem: its held jobs run again, new jobs are no longer held
  hopper handoff list                                the open hand-offs (Needs a person)
  hopper handoff continue <id> [--note <text>]       Continue: the job goes on, told the note
  hopper handoff fixed <id> [--note <text>]          Run again: a new job of its item runs, told the note
  hopper handoff done-by-hand <id> [--note <text>] [--link <url>]
                                                     Done: its job ends finished; the link is the work (a pull request)
  hopper handoff wont-do <id> --note <why>           Won't do: no more work on it; the note says why
  hopper failure list                                the open failures
  hopper failure retry <id>                          run a failure's job again
  hopper prs                                         the Pull requests list: each waiting pull request, its state and its repository's yolo mode
  hopper yolo <owner/repo> on|off|default            yolo mode for one repository: the hopper merges its ready pull requests; default follows every repository's
  hopper backfill done-check                         judge again each done-check failure waiting on a person: done, PR waiting, or it stays
  hopper auto-park                                   the auto-park timeouts: minutes a question waits on a person before its job parks by itself
  hopper auto-park set [--minutes <n>] [--high-priority-minutes <n>]
                                                     change them; 0 turns auto-park off, for jobs that are not high priority or for high-priority jobs
  hopper proposal list                               the open proposals, each with its paths in short
  hopper proposal paths <id>                         one proposal's newest version: its problem, its paths, the recommendation
  hopper proposal select <id> <path>... [--path-note <path>=<text>]... [--note <text>]
                                                     Continue with selected: each path continues as its own follow-on job
  hopper proposal accept <id> [--note <text>]        accept a proposal of zero paths (no change is needed, or no viable path)
  hopper proposal more-paths <id> [--note <text>] [--select <path>]...
                                                     Ask for more paths; the paths named stay selected for the next version
  hopper proposal steer <id> --note <text>           Steer: the note goes back to the job
  hopper proposal reject <id> --note <why>           Reject all: the job ends with the rejection
  hopper typesafe-key                                the TypeSafe API key Jev asks with: set or not, its last 4 characters, when; never the key
  hopper typesafe-key set                            set it from stdin (never as an argument): checked once against TypeSafe, then kept in the vault
  hopper typesafe-key remove                         remove it: Jev is off until a key is set
  hopper artifact list                               the user's artifacts, newest first, each with its shares and link
  hopper artifact get <id>                           one artifact: its details, shares and link
  hopper artifact share <id> --with <name> | --public [--hours <n>]
                                                     share it with another user, or make a public link (said once)
  hopper artifact revoke <id> <share>                end a share: the user no longer sees it, or the link stops at once
  hopper artifact rm <id>                            remove it and every share of it
  Each prints the daemon's answer as JSON (--json is accepted and changes nothing).`;

/** A refusal: the message, exit 2. */
export class OperatorRefusal extends Error {}

export interface OperatorIo {
  env: Record<string, string | undefined>;
  /** All of stdin: the TypeSafe API key for `typesafe-key set`. */
  stdin(): string;
  out(text: string): void;
}

/** A POST of `body`, or, without one, a GET whose answer `pick` narrows. */
interface Call { role: UiRole; path: string; body?: (get: Getter) => Promise<unknown>; pick?: (answer: unknown) => unknown }
type Getter = (path: string) => Promise<unknown>;

/** A session lives this long at most, whatever the sign-in config's session lengths: one call, then it is dropped. */
const SESSION_MS = 5 * 60_000;
/** Who a CLI session is: no realm the sign-in config names, so a reconcile drops it. */
const CLI_IDENTITY = { realm: CLI_REALM, subject: 'operator-cli', name: 'operator CLI', groups: [] };

const usage = (line: string): OperatorRefusal => new OperatorRefusal(`usage: hopper ${line}`);

function jobCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' } } });
  const [verb, id, ...extra] = positionals;
  if (!id || extra.length > 0) throw usage('job accept|reject|rerun|keep-original|accept-new-text <id>');
  const at = `/ui/api/jobs/${encodeURIComponent(id)}`;
  if (verb === 'reject') return { role: 'operator', path: `${at}/reject`, body: async () => (values.reason === undefined ? {} : { reason: values.reason }) };
  if (values.reason !== undefined) throw usage('job reject <id> --reason <text>');
  // Run again, and the two ways on for a job held because its item changed (issue #662): each its own route.
  if (verb === 'rerun' || verb === 'keep-original' || verb === 'accept-new-text') return { role: 'operator', path: `${at}/${verb}`, body: async () => ({}) };
  if (verb === 'accept') {
    // As the Queue view's Accept: the accepted waiting jobs in queue order, then this one.
    return { role: 'operator', path: '/ui/api/queue/order', body: async (get) => {
      const { waiting } = await get('/api/queue') as { waiting: { id: string; accepted?: boolean }[] };
      return { jobIds: [...waiting.filter((j) => j.accepted !== false && j.id !== id).map((j) => j.id), id] };
    } };
  }
  throw usage('job accept|reject|rerun|keep-original|accept-new-text <id>');
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

/** A list from the Failures view (`GET /api/failures`): what `pick` takes of it. */
const failuresList = (pick: (v: FailuresView) => unknown): Call => ({ role: 'viewer', path: '/api/failures', pick: (v) => pick(v as FailuresView) });
const noted = (args: string[]) => parseArgs({ args, allowPositionals: true, options: { note: { type: 'string' }, link: { type: 'string' } } });

function problemCall(args: string[]): Call {
  const { values, positionals } = noted(args);
  const [verb, id, ...extra] = positionals;
  if (verb === 'list' && !id) return failuresList((v) => v.problems.filter((p) => p.status === 'open'));
  if (!id || extra.length > 0 || values.link !== undefined) throw usage('problem list | release <id> | resolve <id> [--note <text>]');
  const at = `/ui/api/failures/problems/${encodeURIComponent(id)}`;
  if (verb === 'release' && values.note === undefined) return { role: 'operator', path: `${at}/release`, body: async () => ({}) };
  if (verb === 'resolve') return { role: 'operator', path: `${at}/resolve`, body: async () => (values.note === undefined ? {} : { note: values.note }) };
  throw usage('problem list | release <id> | resolve <id> [--note <text>]');
}

/** The CLI's verb for each hand-off resolution (issue #551): its name, with dashes. */
const RESOLUTION_OF = new Map(HANDOFF_RESOLUTIONS.map((r) => [r.replaceAll('_', '-'), r]));
const HANDOFF_USAGE = 'handoff list | continue <id> [--note <text>] | fixed <id> [--note <text>] | done-by-hand <id> [--note <text>] [--link <url>] | wont-do <id> --note <why>';

function handoffCall(args: string[]): Call {
  const { values, positionals } = noted(args);
  const [verb, id, ...extra] = positionals;
  if (verb === 'list' && !id) return failuresList((v) => v.handoffs.filter((h) => h.status === 'open'));
  const action = verb === undefined ? undefined : RESOLUTION_OF.get(verb);
  if (!action || !id || extra.length > 0) throw usage(HANDOFF_USAGE);
  const { link } = values;
  if (link !== undefined && action !== 'done_by_hand') throw usage('handoff done-by-hand <id> [--note <text>] [--link <url>]: only done-by-hand takes --link');
  if (action === 'wont_do' && !values.note?.trim()) throw usage('handoff wont-do <id> --note <why>');
  return {
    role: 'operator', path: `/ui/api/failures/handoffs/${encodeURIComponent(id)}/resolve`,
    body: async () => ({ action, ...(values.note === undefined ? {} : { note: values.note }), ...(link === undefined ? {} : { link }) }),
  };
}

function failureCall(args: string[]): Call {
  const [verb, id, ...extra] = args;
  if (verb === 'list' && !id) return failuresList((v) => v.recent);
  if (verb === 'retry' && id && extra.length === 0) return { role: 'operator', path: `/ui/api/failures/${encodeURIComponent(id)}/retry`, body: async () => ({}) };
  throw usage('failure list | retry <id>');
}

const YOLO_OF: Record<string, boolean | null> = { on: true, off: false, default: null };

function prsCall(args: string[]): Call {
  if (args.length > 0) throw usage('prs');
  return { role: 'viewer', path: '/api/pull-requests' };
}

function yoloCall(args: string[]): Call {
  const [repo, mode, ...extra] = args;
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo) || mode === undefined || !(mode in YOLO_OF) || extra.length > 0) throw usage('yolo <owner/repo> on|off|default');
  return { role: 'admin', path: '/ui/api/yolo-mode', body: async () => ({ repos: { [repo]: YOLO_OF[mode] } }) };
}

function backfillCall(args: string[]): Call {
  if (args.length !== 1 || args[0] !== 'done-check') throw usage('backfill done-check');
  return { role: 'operator', path: '/ui/api/backfill/done-check', body: async () => ({}) };
}

const AUTO_PARK_SET = 'auto-park set [--minutes <n>] [--high-priority-minutes <n>]';
const AUTO_PARK_USAGE = `auto-park | hopper ${AUTO_PARK_SET}`;

function minutesOf(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) throw new OperatorRefusal(`--${flag} must be a number of minutes; not ${raw}`);
  return n;
}

function autoParkCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { minutes: { type: 'string' }, 'high-priority-minutes': { type: 'string' } } });
  const [verb, ...extra] = positionals;
  const minutes = minutesOf('minutes', values.minutes);
  const highPriorityMinutes = minutesOf('high-priority-minutes', values['high-priority-minutes']);
  if (verb === undefined && minutes === undefined && highPriorityMinutes === undefined) return { role: 'viewer', path: '/api/auto-park' };
  if (verb !== 'set' || extra.length > 0) throw usage(AUTO_PARK_USAGE);
  if (minutes === undefined && highPriorityMinutes === undefined) throw usage(AUTO_PARK_SET);
  return { role: 'admin', path: '/ui/api/auto-park', body: async () => ({ ...(minutes === undefined ? {} : { minutes }), ...(highPriorityMinutes === undefined ? {} : { highPriorityMinutes }) }) };
}

/** A proposal's paths in short, as the CLI lists them (issue #651). */
function pathsBrief(p: ReviewItemView) {
  const v = p.versions.at(-1)!;
  const set = v.paths ?? { paths: [] };
  return {
    id: p.id, jobId: p.jobId, status: p.status, stage: p.stage, version: v.number, title: p.source?.title, tldr: v.sections.tldr, problem: v.sections.problem,
    paths: set.paths.map((x) => ({
      id: x.id, title: x.title, summary: x.summary, tradeoffs: x.tradeoffs, creates: x.creates,
      ...(x.recommended ? { recommended: true } : {}), ...(x.addedBy ? { addedBy: x.addedBy } : {}), ...(x.notViable ? { notViable: x.notViable } : {}),
    })),
    ...(set.recommendation ? { recommendation: set.recommendation } : {}), ...(set.none !== undefined ? { none: set.none } : {}),
    ...(p.selection ? { selection: p.selection } : {}), ...(p.signOff?.selected ? { selected: p.signOff.selected } : {}), ...(p.followOns ? { followOns: p.followOns } : {}),
  };
}

const PROPOSAL_USAGE = 'proposal list | paths <id> | select <id> <path>... [--path-note <path>=<text>]... [--note <text>] | accept <id> [--note <text>] | more-paths <id> [--note <text>] [--select <path>]... | steer <id> --note <text> | reject <id> --note <why>';

function proposalCall(args: string[]): Call {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: { note: { type: 'string' }, 'path-note': { type: 'string', multiple: true }, select: { type: 'string', multiple: true } },
  });
  const [verb, id, ...rest] = positionals;
  if (verb === 'list' && !id) return { role: 'viewer', path: '/api/proposals', pick: (v) => (v as { items: ReviewItemView[] }).items.map(pathsBrief) };
  if (!id) throw usage(PROPOSAL_USAGE);
  const at = `/ui/api/proposals/${encodeURIComponent(id)}`;
  const note = values.note === undefined ? {} : { notes: values.note };
  if (verb === 'paths' && rest.length === 0) return { role: 'viewer', path: `/api/proposals/${encodeURIComponent(id)}`, pick: (v) => pathsBrief(v as ReviewItemView) };
  if (verb === 'select') {
    if (rest.length === 0) throw usage('proposal select <id> <path>... [--path-note <path>=<text>]... [--note <text>]');
    const notes = new Map<string, string>();
    for (const raw of values['path-note'] ?? []) {
      const eq = raw.indexOf('=');
      if (eq < 1 || !rest.includes(raw.slice(0, eq))) throw new OperatorRefusal(`--path-note ${raw}: write <path>=<text> for a path you select`);
      notes.set(raw.slice(0, eq), raw.slice(eq + 1));
    }
    return { role: 'operator', path: `${at}/accept`, body: async () => ({ ...note, paths: rest.map((p) => ({ id: p, ...(notes.get(p) ? { note: notes.get(p) } : {}) })) }) };
  }
  if (rest.length > 0 || values['path-note'] !== undefined || (values.select !== undefined && verb !== 'more-paths')) throw usage(PROPOSAL_USAGE);
  if (verb === 'accept') return { role: 'operator', path: `${at}/accept`, body: async () => note };
  if (verb === 'more-paths') return { role: 'operator', path: `${at}/more-paths`, body: async () => ({ ...note, ...(values.select ? { paths: values.select.map((p) => ({ id: p })) } : {}) }) };
  if ((verb === 'steer' || verb === 'reject') && values.note?.trim()) return { role: 'operator', path: `${at}/${verb}`, body: async () => note };
  throw usage(PROPOSAL_USAGE);
}

const TYPESAFE_KEY_SET = 'typesafe-key set (the key on stdin, never as an argument)';

/** The key comes from stdin only: an argument would be in the shell's history and the process list. */
function typesafeKeyCall(args: string[], stdin: () => string): Call {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const [verb, ...extra] = positionals;
  if (verb === undefined) return { role: 'viewer', path: '/api/minor-decisions', pick: (v) => (v as { typesafeKey: unknown }).typesafeKey };
  if (verb === 'remove' && extra.length === 0) return { role: 'operator', path: '/ui/api/typesafe-key', body: async () => ({ action: 'remove' }) };
  if (verb !== 'set' || extra.length > 0) throw usage(verb === 'set' ? TYPESAFE_KEY_SET : `typesafe-key | hopper ${TYPESAFE_KEY_SET} | hopper typesafe-key remove`);
  const value = stdin().trim();
  if (!value) throw new OperatorRefusal('no key on stdin: pipe it in, e.g. hopper typesafe-key set < key-file');
  return { role: 'operator', path: '/ui/api/typesafe-key', body: async () => ({ action: 'set', value }) };
}

const ARTIFACT_SHARE = 'artifact share <id> --with <name> | --public [--hours <n>]';

function artifactCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { with: { type: 'string' }, public: { type: 'boolean' }, hours: { type: 'string' } } });
  const [verb, id, ...rest] = positionals;
  const flags = values.with !== undefined || values.public !== undefined || values.hours !== undefined;
  if (verb === 'list' && !id && !flags) return { role: 'viewer', path: '/api/artifacts', pick: (v) => ({ artifacts: (v as { artifacts: unknown[] }).artifacts }) };
  if (!id) throw usage('artifact list | get <id> | share <id> … | revoke <id> <share> | rm <id>');
  const at = `/ui/api/artifacts/${encodeURIComponent(id)}`;
  if (verb === 'get' && rest.length === 0 && !flags) return { role: 'viewer', path: `/api/artifacts/${encodeURIComponent(id)}` };
  if (verb === 'rm' && rest.length === 0 && !flags) return { role: 'operator', path: `${at}/remove`, body: async () => ({}) };
  if (verb === 'revoke' && rest.length === 1 && !flags) return { role: 'operator', path: `${at}/shares/${encodeURIComponent(rest[0]!)}/revoke`, body: async () => ({}) };
  if (verb === 'share' && rest.length === 0) {
    // `--with`, not `--user`: `--user` names the user the CLI acts as.
    if (values.with !== undefined && !values.public && values.hours === undefined) return { role: 'operator', path: `${at}/share`, body: async () => ({ user: values.with }) };
    if (values.public && values.with === undefined) {
      const hours = values.hours === undefined ? undefined : Number(values.hours);
      if (hours !== undefined && (!Number.isInteger(hours) || hours < 1)) throw new OperatorRefusal(`--hours must be a whole number of at least 1, not ${values.hours}`);
      return { role: 'operator', path: `${at}/share`, body: async () => ({ link: true, ...(hours === undefined ? {} : { hours }) }) };
    }
    throw usage(ARTIFACT_SHARE);
  }
  throw usage('artifact list | get <id> | share <id> … | revoke <id> <share> | rm <id>');
}

function callOf(command: string, args: string[], stdin: () => string): Call {
  if (command === 'artifact') return artifactCall(args);
  if (command === 'typesafe-key') return typesafeKeyCall(args, stdin);
  if (command === 'auto-park') return autoParkCall(args);
  if (command === 'proposal') return proposalCall(args);
  if (command === 'prs') return prsCall(args);
  if (command === 'yolo') return yoloCall(args);
  if (command === 'backfill') return backfillCall(args);
  if (command === 'job') return jobCall(args);
  if (command === 'queue') return queueCall(args);
  if (command === 'problem') return problemCall(args);
  if (command === 'handoff') return handoffCall(args);
  if (command === 'failure') return failureCall(args);
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

/** Take `--url <url>` and `--user <id>` out of `args`, wherever they are, and `--json`: the answer is JSON anyway. */
function common(args: string[]): { rest: string[]; url?: string; user?: string } {
  const rest: string[] = [];
  const found: { url?: string; user?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') continue;
    if (a === '--url' || a === '--user') {
      const v = args[++i];
      if (v === undefined) throw new OperatorRefusal(`${a} needs a value`);
      found[a === '--url' ? 'url' : 'user'] = v;
    } else rest.push(a);
  }
  return { rest, ...found };
}

/**
 * `hopper job|queue|question|problem|handoff|failure|prs|yolo|backfill|auto-park|proposal|typesafe-key|artifact …`: one operator action on the running daemon, as `userOf` names the user.
 * Prints the daemon's answer as JSON.
 */
export async function runOperatorAction(
  instance: InstanceStore, command: string, args: string[], userOf: (id: string | undefined) => User, io: OperatorIo,
): Promise<void> {
  const { rest, url: rawUrl, user: userId } = common(args);
  const call = callOf(command, rest, io.stdin);
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
    const answer = call.body ? await send(call.path, await call.body(send)) : await send(call.path);
    io.out(`${JSON.stringify(call.pick ? call.pick(answer) : answer, null, 2)}\n`);
  } finally {
    sessions.drop(session.token, 'logout');
  }
}
