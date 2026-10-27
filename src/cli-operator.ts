// The operator's actions from the command line (issue #374, design.md "Operator actions from the CLI"):
// show a job, and list the waiting jobs, each held one with why it is held (issue #874, cli-operator-queue.ts); accept, reject, cancel (issue #1460), run a job again or send its pull request back for rework (issue #724), dismiss failed jobs (issue #1123), order the queue, set the queue gate, list the open questions with why each came to a
// person (issue #679), answer, close or dismiss a question; and the Failures actions (issue #623): list, release or resolve a problem, list or resolve a hand-off,
// list or run a failure again; the Pull requests list, yolo mode per repository and the done-check backfill (issue #637); Merge now and Close PR (issue #677, cli-operator-pr.ts), and Tend again (issue #1010);
// the TypeSafe API key, read from stdin, never an argument (issue #657).
// the proposals (issue #651): list them, show one's paths, select paths to continue with, ask for more, steer, reject;
// the artifacts (issue #673, cli-operator-artifact.ts); the master key's status (issue #685, cli-operator-keys.ts): never the key;
// the vault, its templates and the sandbox boxes (issue #716, cli-operator-vault.ts): a secret's value from stdin only; the infra plans (issue #2205, cli-operator-infra.ts);
// API tokens (issue #718, cli-operator-keys.ts): mint one for an agent, printed once; list and revoke them;
// Report a bug and Your reports (issue #694, cli-operator-report.ts): its context first, then the report; direct jobs (issue #901, cli-operator-direct.ts);
// search (issue #945, cli-operator-search.ts): the jobs by their words, type-ahead, the index's state and Reindex;
// the Windows link report of the keep-alive loop on Windows (issue #712, cli-operator-windows-link.ts).
// Each is the UI's own `POST /ui/api/*` on the running daemon, so the daemon's checks, events and
// runtime (a source told, an answer typed into a waiting pane) apply as they do for a click. The session it
// goes under is minted here, in the database, for the one call, and dropped after it: whoever runs the CLI
// holds the database's credentials, the daemon's own trust, so a session of theirs adds none.
// With HOPPER_REFRESH_TOKEN_FILE (issue #1138) the CLI opens no database: it acts with a grant — a delegate approver's,
// say — trading the refresh token that file holds for an API token, and keeping the new refresh token in the file.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ESCALATION_REASONS, HANDOFF_RESOLUTIONS, type FailuresView, type Job, type ReviewItemView, type User } from './domain/types.ts';
import type { InstanceStore } from './domain/ports.ts';
import { OPERATOR_CLI_NAME } from './domain/failures.ts';
import { OperatorRefusal, perform, sender, usage, type Call } from './cli-operator-call.ts';
import { questionCall } from './cli-operator-questions.ts';
import { SESSION_HEADER } from './http/ui/guard.ts';
import { CLI_REALM, createUiSessions } from './http/ui/sessions.ts';
import { loadSignInConfig } from './auth/index.ts';
import { ARTIFACT_USAGE, artifactCall } from './cli-operator-artifact.ts';
import { MASTER_KEY_USAGE, TOKEN_USAGE, masterKeyCall, tokenCall, typesafeKeyCall } from './cli-operator-keys.ts';
import { ACCOUNTS_USAGE, accountsCall } from './cli-operator-accounts.ts';
import { TERMINAL_USAGE, terminalCall } from './cli-operator-terminal.ts';
import { LANES_USAGE, lanesCall } from './cli-operator-lanes.ts';
import { MACHINE_USAGE, machineCall } from './cli-operator-machine.ts'; import { CLOUD_LINK_USAGE, cloudLinkCall } from './cli-operator-cloud-link.ts';
import { PR_USAGE, prCall, prsCall, yoloCall } from './cli-operator-pr.ts'; import { INFRA_USAGE, infraCall } from './cli-operator-infra.ts'; import { SCHEDULE_USAGE, scheduleCall } from './cli-operator-schedule.ts'; import { MEMORY_USAGE, memoryCall } from './cli-operator-memory.ts';
import { REPO_USAGE, repoCall } from './cli-operator-repo.ts'; import { USAGE_USAGE, usageCall } from './cli-operator-usage.ts'; import { GRADES_USAGE, gradesCall } from './cli-operator-grades.ts'; import { FORECAST_USAGE, forecastCall } from './cli-operator-forecast.ts'; import { DEPLOYMENT_USAGE, deploymentCall } from './cli-operator-deployment.ts'; import { INTAKE_USAGE, intakeCall } from './cli-operator-intake.ts';
import { QUEUE_USAGE, ownWaitOf, queueCall } from './cli-operator-queue.ts';
import { DIRECT_USAGE, directCall } from './cli-operator-direct.ts'; import { DISMISS_USAGE, dismissCall } from './cli-operator-dismiss.ts';
import { REPORT_USAGE, reportCall } from './cli-operator-report.ts';
import { SEARCH_USAGE, searchCall } from './cli-operator-search.ts';
import { VAULT_USAGE, grantCall, sandboxCall, templateCall, vaultCall } from './cli-operator-vault.ts';
import { driftCall } from './cli-update-drift.ts';
import { WINDOWS_LINK_USAGE, windowsLinkCall } from './cli-operator-windows-link.ts';

export const OPERATOR_COMMANDS = ['job', 'queue', 'question', 'problem', 'handoff', 'failure', 'prs', 'pr', 'repo', 'yolo', 'backfill', 'proposal', 'typesafe-key', 'artifact', 'master-key', 'lanes', 'machine', 'cloud-link', 'accounts', 'terminal', 'vault', 'grant', 'template', 'sandbox', 'token', 'report', 'search', 'windows-link', 'infra', 'intake', 'usage', 'grades', 'forecast', 'deployment', 'schedule', 'memory'] as const;

export const OPERATOR_USAGE = `  hopper job show <id>                               one job, by its id or short id: its state, and why it is held or waits (holdReason, waitReason),
                                                     or, on its own wait, what it waits on (waitsOn, waitsFor, wait)
  hopper job accept <id>                             let a waiting job through the queue gate: it joins the end of the user order
  hopper job reject <id> [--reason <text>]           a waiting job ends rejected, the reason kept on it
  hopper job cancel <id> [--reason <text>]           any job that has not ended ends cancelled, the reason kept on it
  hopper job park <id> [--reason <text>]             park a running job, or one on a question, a proposal or a research report: it leaves its lane, and keeps its work
  hopper job pick-up <id>                            pick a parked job up: it waits again where it was parked, or resumes its session
  hopper job rerun <id>                              run a failed, finished, rejected or cancelled job again; it runs its item's approved text
  hopper job cleaned-up <id>                         an ended job whose cleanup cannot reach its machine: its pane is closed, or its machine is gone for good; its item's jobs may run
  hopper job end-wait <id> [--note <text>]           end a job's own wait: it goes on, told the note; a stranded one resumes its session
  hopper job rework <id> --notes <text>              send a done job's open pull request back: it becomes a draft, a new job reworks it, told the notes
  hopper job keep-original <id>                      a job held because its item changed: it runs the original text
  hopper job accept-new-text <id>                    a job held because its item changed: it runs the new text (the owner only, as Access decides)
  hopper job quarantine|unquarantine <id>            quarantine a job: held, and it reaches nothing through the hopper; or lift it
  hopper job approve-trust <id>                      approve the trust of a job Jev's check, a deny or an edit lowered, or one with no item
  hopper job stamp <id>                              a job's trust stamp: its level, whether it verifies, and what it holds (start, gate 2, doors)
${DISMISS_USAGE}
${DIRECT_USAGE}
${QUEUE_USAGE}
  hopper question list [--reason <reason>]           the open questions; --reason keeps those sent to a person for it: ${ESCALATION_REASONS.join(', ')}
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
  hopper failure stuck [<cause>]                     the stuck work by cause (stranded: a wait whose agent session ended); with a cause, run its bulk action
  hopper prs                                         the Pull requests list: each waiting pull request, its state and its repository's yolo mode
${PR_USAGE}
${REPO_USAGE}\n${USAGE_USAGE}\n${GRADES_USAGE}\n${FORECAST_USAGE}\n${DEPLOYMENT_USAGE}
${INTAKE_USAGE}
  hopper yolo <owner/repo> on|off|default            yolo mode for one repository: the hopper merges its ready pull requests; default follows every repository's
  hopper backfill done-check                         judge again each done-check failure waiting on a person: done, PR waiting, or it stays
  hopper proposal list                               the open proposals, each with its paths in short
  hopper proposal paths <id>                         one proposal's newest version: its problem, its paths, the recommendation
  hopper proposal select <id> <path>... [--path-note <path>=<text>]... [--note <text>]
                                                     Continue with selected: each path continues as its own follow-on job
  hopper proposal accept <id> [--note <text>]        accept a proposal of zero paths (no change is needed, or no viable path)
  hopper proposal more-paths <id> [--note <text>] [--select <path>]...
                                                     Ask for more paths; the paths named stay selected for the next version
  hopper proposal steer <id> --note <text>           Steer: the note goes back to the job
  hopper proposal reject <id> [--note <why>]         Reject the whole proposal: the job ends with the rejection
  hopper typesafe-key                                the TypeSafe API key Jev asks with: set or not, its last 4 characters, when; never the key
  hopper typesafe-key set                            set it from stdin (never as an argument): checked once against TypeSafe, then kept in the vault
  hopper typesafe-key remove                         remove it: Jev is off until a key is set
${MASTER_KEY_USAGE}
${ARTIFACT_USAGE}
${REPORT_USAGE}
${SEARCH_USAGE}
${LANES_USAGE}
${MACHINE_USAGE}
${CLOUD_LINK_USAGE}
${ACCOUNTS_USAGE}
${TERMINAL_USAGE}
${VAULT_USAGE}
${INFRA_USAGE}
${SCHEDULE_USAGE}
${MEMORY_USAGE}
${TOKEN_USAGE}
${WINDOWS_LINK_USAGE}
  Each prints the daemon's answer as JSON (--json is accepted and changes nothing).`;


export interface OperatorIo {
  env: Record<string, string | undefined>;
  /** All of stdin: the TypeSafe API key for `typesafe-key set`. */
  stdin(): string;
  out(text: string): void;
}


/** A session lives this long at most, whatever the sign-in config's session lengths: one call, then it is dropped. */
const SESSION_MS = 5 * 60_000;
/** Who a CLI session is: no realm the sign-in config names, so a reconcile drops it. */
const CLI_IDENTITY = { realm: CLI_REALM, subject: 'operator-cli', name: OPERATOR_CLI_NAME, groups: [] };


function jobCall(args: string[]): Call {
  const direct = directCall(args[0], args.slice(1));
  if (direct) return direct;
  if (args[0] === 'dismiss') return dismissCall(args.slice(1));
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' }, notes: { type: 'string' }, note: { type: 'string' } } });
  const [verb, id, ...extra] = positionals;
  if (!id || extra.length > 0) throw usage('job show|stamp|accept|reject|cancel|park|pick-up|rerun|cleaned-up|rework|keep-original|accept-new-text|quarantine|unquarantine|approve-trust|end-wait <id>');
  const at = `/ui/api/jobs/${encodeURIComponent(id)}`, notes = values.notes, note = values.note;
  // End a job's own wait (issue #1779: a stranded one too), as the job's End wait button.
  if (verb === 'end-wait' && notes === undefined && values.reason === undefined) return { role: 'operator', path: `${at}/end-wait`, body: async () => (note === undefined ? {} : { note }) };
  if (verb === 'end-wait' || note !== undefined) throw usage('job end-wait <id> [--note <text>]');
  // The whole job as the job view reads it; a held job's `holdReason` says why it is held, and one on its own wait what it waits on (issue #1780).
  if (verb === 'show' && notes === undefined && values.reason === undefined) return { role: 'viewer', path: `/api/jobs/${encodeURIComponent(id)}`, pick: (j) => ({ ...(j as Job), ...ownWaitOf(j as Job) }) };
  // Its trust stamp (issue #655 part 10): whether it verifies, and what it holds or lets through.
  if (verb === 'stamp' && notes === undefined && values.reason === undefined) return { role: 'viewer', path: `/api/jobs/${encodeURIComponent(id)}/stamp` };
  if (verb === 'rework' && notes !== undefined && values.reason === undefined) return { role: 'operator', path: `${at}/rework`, body: async () => ({ notes }) };
  if (verb === 'rework' || notes !== undefined) throw usage('job rework <id> --notes <text>');
  if (verb === 'reject' || verb === 'cancel' || verb === 'park') return { role: 'operator', path: `${at}/${verb}`, body: async () => (values.reason === undefined ? {} : { reason: values.reason }) };
  if (values.reason !== undefined) throw usage('job reject|cancel|park <id> --reason <text>');
  // Pick up (issue #2167), as the Parked view's: the re-queue route.
  if (verb === 'pick-up') return { role: 'operator', path: `${at}/requeue`, body: async () => ({}) };
  // Run again, and the two ways on for a job held because its item changed (issue #662): each its own route.
  // Quarantine and its lift (issue #655) too.
  // Mark closed (issue #2427): an ended job's deferred cleanup is done, its pane closed or its machine gone for good.
  if (verb === 'cleaned-up') return { role: 'operator', path: `${at}/cleaned-up`, body: async () => ({}) };
  if (['rerun', 'keep-original', 'accept-new-text', 'quarantine', 'unquarantine', 'approve-trust'].includes(verb ?? '')) return { role: 'operator', path: `${at}/${verb}`, body: async () => ({}) };
  if (verb === 'accept') {
    // As the Queue view's Accept: the accepted waiting jobs in queue order, then this one.
    return { role: 'operator', path: '/ui/api/queue/order', body: async (get) => {
      const { waiting } = await get('/api/queue') as { waiting: { id: string; accepted?: boolean }[] };
      return { jobIds: [...waiting.filter((j) => j.accepted !== false && j.id !== id).map((j) => j.id), id] };
    } };
  }
  throw usage('job show|stamp|accept|reject|cancel|park|pick-up|rerun|cleaned-up|rework|keep-original|accept-new-text|quarantine|unquarantine|approve-trust|end-wait <id>');
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
  // Stuck work (issues #1010, #1779): the causes, or one cause's bulk action.
  if (verb === 'stuck' && !id) return failuresList((v) => v.stuck);
  if (verb === 'stuck' && extra.length === 0) return { role: 'operator', path: `/ui/api/failures/stuck/${encodeURIComponent(id!)}`, body: async () => ({}) };
  throw usage('failure list | retry <id> | stuck [<cause>]');
}

function backfillCall(args: string[]): Call {
  if (args.length !== 1 || args[0] !== 'done-check') throw usage('backfill done-check');
  return { role: 'operator', path: '/ui/api/backfill/done-check', body: async () => ({}) };
}

/** A proposal's paths in short, as the CLI lists them (issue #651). */
function pathsBrief(p: ReviewItemView) {
  const v = p.versions.at(-1)!;
  const set = v.paths ?? { paths: [] };
  return {
    id: p.id, jobId: p.jobId, status: p.status, stage: p.stage, version: v.number, title: p.source?.title, tldr: v.sections.tldr, problem: v.sections.problem,
    paths: set.paths.map((x) => ({
      id: x.id, title: x.title, summary: x.summary, tradeoffs: x.tradeoffs, ...(x.otherFields ? { otherFields: x.otherFields } : {}), creates: x.creates,
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
  if (verb === 'reject') return { role: 'operator', path: `${at}/reject`, body: async () => note };
  if (verb === 'steer' && values.note?.trim()) return { role: 'operator', path: `${at}/steer`, body: async () => note };
  throw usage(PROPOSAL_USAGE);
}

function callOf(command: string, args: string[], stdin: () => string): Call {
  if (command === 'update') return driftCall(args);
  if (command === 'master-key') return masterKeyCall(args);
  if (command === 'lanes') return lanesCall(args);
  if (command === 'machine') return machineCall(args);
  if (command === 'cloud-link') return cloudLinkCall(args);
  if (command === 'accounts') return accountsCall(args, stdin);
  if (command === 'terminal') return terminalCall(args, stdin);
  if (command === 'token') return tokenCall(args);
  if (command === 'vault') return vaultCall(args, stdin);
  if (command === 'grant') return grantCall(args);
  if (command === 'template') return templateCall(args); if (command === 'infra') return infraCall(args); if (command === 'schedule') return scheduleCall(args); if (command === 'memory') return memoryCall(args);
  if (command === 'sandbox') return sandboxCall(args);
  if (command === 'artifact') return artifactCall(args);
  if (command === 'report') return reportCall(args);
  if (command === 'search') return searchCall(args);
  if (command === 'windows-link') return windowsLinkCall(args);
  if (command === 'typesafe-key') return typesafeKeyCall(args, stdin);
  if (command === 'proposal') return proposalCall(args);
  if (command === 'prs') return prsCall(args);
  if (command === 'pr') return prCall(args);
  if (command === 'repo') return repoCall(args); if (command === 'intake') return intakeCall(args); if (command === 'usage') return usageCall(args); if (command === 'grades') return gradesCall(args); if (command === 'forecast') return forecastCall(args); if (command === 'deployment') return deploymentCall(args);
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
 * `hopper job|queue|question|problem|handoff|failure|prs|pr|repo|yolo|backfill|proposal|typesafe-key|artifact|master-key|lanes|machine|vault|template|sandbox|report|search|windows-link …`: one operator action on the running daemon, as `userOf` names the user.
 * Prints the daemon's answer as JSON; the exit code the call gives it.
 */
export async function runOperatorAction(
  instance: InstanceStore, command: string, args: string[], userOf: (id: string | undefined) => User, io: OperatorIo,
): Promise<number> {
  const { rest, url: rawUrl, user: userId } = common(args);
  const call = callOf(command, rest, io.stdin);
  const url = daemonUrl(rawUrl, io.env);
  const user = userOf(userId);
  // A CLI session is no gateway realm's: no token of one is ever checked for it.
  const signIn = { config: () => loadSignInConfig(instance.signInConfig.read()), checkGateway: async () => ({ ok: false as const, status: 403 as const, error: 'the operator CLI checks no gateway token' }) };
  const sessions = createUiSessions({ repo: instance.uiSessions, clock: { now: () => new Date() }, signIn });
  // `--as` (issue #2220) names who decided, in the session's name only: its role and user stay the CLI's.
  const session = sessions.create({ role: call.role, identity: call.as === undefined ? CLI_IDENTITY : { ...CLI_IDENTITY, name: call.as }, userId: user.id, lastsMs: SESSION_MS });
  try {
    return await perform(call, sender(url, { [SESSION_HEADER]: session.token, origin: url.origin }), io);
  } finally {
    sessions.drop(session.token, 'logout');
  }
}

/** The environment variable that names a grant's refresh-token file (issue #1138): the CLI then opens no database. */
export const REFRESH_TOKEN_FILE = 'HOPPER_REFRESH_TOKEN_FILE';

/**
 * One operator action with a grant's API token, not a session of the database's (issue #1138): the refresh token in the
 * file `HOPPER_REFRESH_TOKEN_FILE` names is traded at `POST /ui/auth/token/refresh`, and the new one replaces it in the
 * file before the action is sent, as the old one is spent. The grant's scopes and role, and Access, decide the action.
 */
export async function runOperatorActionWithGrant(command: string, args: string[], io: OperatorIo): Promise<number> {
  const { rest, url: rawUrl, user } = common(args);
  if (user !== undefined) throw new OperatorRefusal(`--user: with ${REFRESH_TOKEN_FILE}, the grant names the user it acts for`);
  const call = callOf(command, rest, io.stdin); if (call.as !== undefined) throw new OperatorRefusal(`--as: with ${REFRESH_TOKEN_FILE}, the grant names who acts`);
  const url = daemonUrl(rawUrl, io.env);
  const file = io.env[REFRESH_TOKEN_FILE]!;
  let refresh: string;
  try {
    refresh = readFileSync(file, 'utf8').trim();
  } catch (e) {
    throw new OperatorRefusal(`${REFRESH_TOKEN_FILE} names ${file}, which cannot be read: ${(e as Error).message}`);
  }
  const traded = await sender(url, {})('/ui/auth/token/refresh', { refresh }) as { token: string; refresh: string };
  // The refresh token sent is spent now: keep its successor before anything else can fail.
  const next = `${file}.new`;
  writeFileSync(next, `${traded.refresh}\n`, { mode: 0o600 });
  renameSync(next, file);
  return perform(call, sender(url, { authorization: `Bearer ${traded.token}` }), io);
}
