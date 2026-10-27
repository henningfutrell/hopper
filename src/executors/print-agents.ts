// How each print-mode agent CLI is called and how its answer is read (design.md "Print-mode agent
// executors", issues #142, #307 and #533): Cursor's agent and Claude Code print one JSON result; codex, opencode
// and omp print JSON events, one per line. The shapes are the real CLIs' (cursor-agent 2026.10, codex-cli 0.160,
// opencode 2.1, omp 18.7, claude 2.1.292). Only the call and the reading differ; the turn is print-agent.ts's.

import { printTurnTokenUse, type SessionTokenUse } from '../domain/token-usage.ts';

/** The agent CLIs a print-mode executor runs, by the id of its executor plugin. */
export const PRINT_AGENTS = ['cursor-agent', 'codex', 'opencode', 'omp', 'claude'] as const;
export type PrintAgent = (typeof PRINT_AGENTS)[number];

/**
 * One turn's call: the CLI, its own arguments, the model, the session to resume, the text to send, and the most the turn
 * may spend in US dollars, for a CLI that takes such a cap (issue #2848 part 3).
 */
export interface TurnCall { bin: string; args: readonly string[]; cwd: string; model?: string; session?: string; text: string; maxBudgetUsd?: number }

/**
 * What a turn's output says: the agent's last message and the session to resume; an error the agent
 * reported; or output that cannot be read as an answer (`unreadable`: what is wrong with it).
 */
export type TurnAnswer = { text: string; session: string } | { error: string } | { unreadable: string };

/** What a turn's output says, its session if it names one: a draft turn keeps none (issue #474). */
export type TurnSaid = { text: string; session?: string } | { error: string } | { unreadable: string };

export interface Dialect {
  /** The call; with `textOnStdin`, the text is not in it. */
  argv(c: TurnCall): string[];
  /** The CLI reads the text on stdin: an argument would reach the model changed (issue #2856). */
  textOnStdin?: true;
  /** The token use the turn's output says, by its session (issue #2302, part 6); absent: the CLI says none the hopper reads. */
  usage?(stdout: string, at: { first: string; last: string }): { session: string; use: SessionTokenUse } | undefined;
  /** Whether the turn takes `maxBudgetUsd`, and what the CLI said when it stopped there; absent: it takes none. */
  capReached?(stdout: string): string | undefined;
  /** The answer and the session to resume: a job's turn. */
  read(stdout: string): TurnAnswer;
  /** The answer, with its session when it names one. */
  said(stdout: string): TurnSaid;
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): Json => (v && typeof v === 'object' ? v as Json : {});

/** Each line of `stdout` that is a JSON object; other lines (a CLI's own notices) are skipped. */
function events(stdout: string): Json[] {
  const out: Json[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try { out.push(obj(JSON.parse(line))); } catch { /* not an event */ }
  }
  return out;
}

const model = (c: TurnCall): string[] => (c.model ? ['--model', c.model] : []);

/** A dialect from its argv and its reading: a job's turn needs the session (`what`: how the CLI names it). */
function dialect(argv: Dialect['argv'], said: Dialect['said'], what: string): Dialect {
  return {
    argv,
    said,
    read(stdout) {
      const r = said(stdout);
      if (!('text' in r)) return r;
      return r.session ? { text: r.text, session: r.session } : { unreadable: `printed no ${what}: ${stdout.trim()}` };
    },
  };
}

/** One JSON result: `result` the last message, `session_id` the session, `is_error` the CLI's own error. Cursor's agent and Claude Code alike. */
function readResult(stdout: string): TurnSaid {
  let r: Json;
  try { r = obj(JSON.parse(stdout.trim())); } catch { return { unreadable: `printed no JSON result: ${stdout.trim()}` }; }
  const said = str(r.result) ?? '';
  if (r.is_error) return { error: said.trim() || 'error without a message' };
  const session = str(r.session_id);
  return { text: said, ...(session ? { session } : {}) };
}

const cursor = dialect(
  (c) => [c.bin, '-p', '--output-format', 'json', '--workspace', c.cwd, ...c.args, ...model(c), ...(c.session ? ['--resume', c.session] : []), '--', c.text],
  readResult, 'chat id',
);

/**
 * `claude -p --output-format json` (issue #533): Claude Code in print mode shows no screen — no onboarding, no trust
 * dialog, nothing to press — so a fresh home runs it as it is. It works in its cwd, the job's work tree.
 */
const claude: Dialect = {
  ...dialect(
    (c) => [c.bin, '-p', '--output-format', 'json', ...c.args, ...model(c), ...(c.maxBudgetUsd !== undefined ? ['--max-budget-usd', String(c.maxBudgetUsd)] : []),
      ...(c.session ? ['--resume', c.session] : []), '--', c.text],
    readResult, 'chat id',
  ),
  // `--max-budget-usd` (issue #2848 part 3): over it, claude ends the turn with this subtype, its errors, and exit 1.
  capReached(stdout) {
    let r: Json;
    try { r = obj(JSON.parse(stdout.trim())); } catch { return undefined; }
    if (r.subtype !== 'error_max_budget_usd') return undefined;
    return (Array.isArray(r.errors) ? r.errors.map(str).find((e) => e) : undefined) ?? 'it reached its budget';
  },
  // Its result's `modelUsage`, an error's too: the tokens were spent.
  usage(stdout, at) {
    let r: Json;
    try { r = obj(JSON.parse(stdout.trim())); } catch { return undefined; }
    const session = str(r.session_id), use = printTurnTokenUse(r, at);
    return session && use ? { session, use } : undefined;
  },
};


/** `codex exec --json`: `thread.started` names the thread; each `agent_message` item is a message; `turn.failed` ends it. */
const codex = dialect(
  (c) => (c.session
    ? [c.bin, 'exec', 'resume', '--json', ...c.args, ...model(c), '--', c.session, c.text]
    : [c.bin, 'exec', '--json', ...c.args, ...model(c), '--', c.text]),
  (stdout) => {
    let session: string | undefined;
    let text: string | undefined;
    for (const e of events(stdout)) {
      if (e.type === 'thread.started') session = str(e.thread_id);
      else if (e.type === 'turn.failed') return { error: str(obj(e.error).message) ?? 'turn failed' };
      else if (e.type === 'item.completed' && obj(e.item).type === 'agent_message') text = str(obj(e.item).text);
    }
    return text === undefined ? { unreadable: 'answered no message' } : { text, ...(session ? { session } : {}) };
  },
  'thread',
);

/**
 * `opencode run --format json`: every event names the session; the text parts of the last message are the answer.
 * opencode 2 (issue #2856): `--standalone` runs a private server for the run, never the background service, which
 * outlives the turn and keeps the environment and config of the run that started it. The text goes on stdin: opencode 2
 * quotes a text argument with a space again, and after `--` sends it twice.
 */
const opencode: Dialect = {
  ...dialect(
    (c) => [c.bin, 'run', '--standalone', '--format', 'json', ...c.args, ...model(c), ...(c.session ? ['--session', c.session] : [])],
    (stdout) => {
      let session: string | undefined;
      let message: string | undefined;
      let text = '';
      for (const e of events(stdout)) {
        session ??= str(e.sessionID);
        if (e.type === 'error') {
          const err = obj(e.error);
          const why = str(obj(err.data).message);
          return { error: [str(err.name), why].filter(Boolean).join(': ') || 'error without a message' };
        }
        const part = obj(e.part);
        if (e.type !== 'text' || part.type !== 'text') continue;
        if (part.messageID !== message) { message = str(part.messageID); text = ''; }
        text += str(part.text) ?? '';
      }
      return message === undefined ? { unreadable: 'answered no message' } : { text, ...(session ? { session } : {}) };
    },
    'session',
  ),
  textOnStdin: true,
};

/** `omp -p --mode json`: the `session` line names it; `agent_end` carries the messages, the last the answer. */
const omp = dialect(
  (c) => [c.bin, '-p', '--mode', 'json', '--no-title', ...c.args, ...model(c), ...(c.session ? ['--resume', c.session] : []), '--', c.text],
  (stdout) => {
    let session: string | undefined;
    let last: Json | undefined;
    for (const e of events(stdout)) {
      if (e.type === 'session') session = str(e.id);
      else if (e.type === 'agent_end' && Array.isArray(e.messages)) last = obj((e.messages as unknown[]).findLast((m) => obj(m).role === 'assistant'));
    }
    if (!last) return { unreadable: 'answered no message' };
    if (last.stopReason === 'error' || last.stopReason === 'aborted') return { error: str(last.errorMessage) ?? `stopped: ${String(last.stopReason)}` };
    const parts = Array.isArray(last.content) ? last.content as unknown[] : [];
    return { text: parts.map(obj).filter((p) => p.type === 'text').map((p) => str(p.text) ?? '').join(''), ...(session ? { session } : {}) };
  },
  'session',
);

export const DIALECTS: Readonly<Record<PrintAgent, Dialect>> = { 'cursor-agent': cursor, codex, opencode, omp, claude };
