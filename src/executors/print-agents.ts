// How each print-mode agent CLI is called and how its answer is read (design.md "Print-mode agent
// executors", issues #142 and #307): Cursor's agent prints one JSON result; codex, opencode and omp print
// JSON events, one per line. The shapes are the real CLIs' (cursor-agent 2026.10, codex-cli 0.160,
// opencode 1.18, omp 18.7). Only the call and the reading differ; the turn is print-agent.ts's.

/** The agent CLIs a print-mode executor runs, by the id of its executor plugin. */
export const PRINT_AGENTS = ['cursor-agent', 'codex', 'opencode', 'omp'] as const;
export type PrintAgent = (typeof PRINT_AGENTS)[number];

/** One turn's call: the CLI, its own arguments, the model, the session to resume, the text to send. */
export interface TurnCall { bin: string; args: readonly string[]; cwd: string; model?: string; session?: string; text: string }

/**
 * What a turn's output says: the agent's last message and the session to resume; an error the agent
 * reported; or output that cannot be read as an answer (`unreadable`: what is wrong with it).
 */
export type TurnAnswer = { text: string; session: string } | { error: string } | { unreadable: string };

export interface Dialect { argv(c: TurnCall): string[]; read(stdout: string): TurnAnswer }

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

const cursor: Dialect = {
  argv: (c) => [c.bin, '-p', '--output-format', 'json', '--workspace', c.cwd, ...c.args, ...model(c), ...(c.session ? ['--resume', c.session] : []), '--', c.text],
  read(stdout) {
    let r: Json;
    try { r = obj(JSON.parse(stdout.trim())); } catch { return { unreadable: `printed no JSON result: ${stdout.trim()}` }; }
    const said = str(r.result) ?? '';
    if (r.is_error) return { error: said.trim() || 'error without a message' };
    const session = str(r.session_id);
    return session ? { text: said, session } : { unreadable: 'answered without a chat id' };
  },
};

/** `codex exec --json`: `thread.started` names the thread; each `agent_message` item is a message; `turn.failed` ends it. */
const codex: Dialect = {
  argv: (c) => (c.session
    ? [c.bin, 'exec', 'resume', '--json', ...c.args, ...model(c), '--', c.session, c.text]
    : [c.bin, 'exec', '--json', ...c.args, ...model(c), '--', c.text]),
  read(stdout) {
    let session: string | undefined;
    let text: string | undefined;
    for (const e of events(stdout)) {
      if (e.type === 'thread.started') session = str(e.thread_id);
      else if (e.type === 'turn.failed') return { error: str(obj(e.error).message) ?? 'turn failed' };
      else if (e.type === 'item.completed' && obj(e.item).type === 'agent_message') text = str(obj(e.item).text);
    }
    if (!session) return { unreadable: `printed no thread: ${stdout.trim()}` };
    return text === undefined ? { unreadable: 'answered no message' } : { text, session };
  },
};

/** `opencode run --format json`: every event names the session; the text parts of the last message are the answer. */
const opencode: Dialect = {
  argv: (c) => [c.bin, 'run', '--format', 'json', ...c.args, ...model(c), ...(c.session ? ['--session', c.session] : []), '--', c.text],
  read(stdout) {
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
    if (!session) return { unreadable: `printed no session: ${stdout.trim()}` };
    return message === undefined ? { unreadable: 'answered no message' } : { text, session };
  },
};

/** `omp -p --mode json`: the `session` line names it; `agent_end` carries the messages, the last the answer. */
const omp: Dialect = {
  argv: (c) => [c.bin, '-p', '--mode', 'json', '--no-title', ...c.args, ...model(c), ...(c.session ? ['--resume', c.session] : []), '--', c.text],
  read(stdout) {
    let session: string | undefined;
    let last: Json | undefined;
    for (const e of events(stdout)) {
      if (e.type === 'session') session = str(e.id);
      else if (e.type === 'agent_end' && Array.isArray(e.messages)) last = obj((e.messages as unknown[]).findLast((m) => obj(m).role === 'assistant'));
    }
    if (!session) return { unreadable: `printed no session: ${stdout.trim()}` };
    if (!last) return { unreadable: 'answered no message' };
    if (last.stopReason === 'error' || last.stopReason === 'aborted') return { error: str(last.errorMessage) ?? `stopped: ${String(last.stopReason)}` };
    const parts = Array.isArray(last.content) ? last.content as unknown[] : [];
    return { text: parts.map(obj).filter((p) => p.type === 'text').map((p) => str(p.text) ?? '').join(''), session };
  },
};

export const DIALECTS: Readonly<Record<PrintAgent, Dialect>> = { 'cursor-agent': cursor, codex, opencode, omp };
