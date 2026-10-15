// A job's transcript (issue #1169 part 4, design.md "The job's transcript"): the agent session a job's checkpoint keeps
// (Claude's session file, one JSON object a line, scrubbed when it was kept), read as turns. Pure: the http route opens
// the checkpoint and gives the text here.

/** A plan step's state, as the agent's TodoWrite names it. */
export type TranscriptPlanStatus = 'pending' | 'in_progress' | 'completed';

/** One part of a turn, in the order the agent made it. */
export type TranscriptPart =
  | { kind: 'text'; text: string; truncated?: true }
  | { kind: 'reasoning'; text: string; truncated?: true }
  /** A tool call: `title` says what it did in a few words; `input` is its command, or its input as JSON. */
  | { kind: 'tool'; id: string; name: string; title: string; input: string; result?: string; error?: true; truncated?: true }
  /** The agent's plan (TodoWrite). */
  | { kind: 'plan'; id: string; items: { text: string; status: TranscriptPlanStatus }[] }
  /** A subagent the agent started (Task, Agent): what for, its kind, its prompt and what it gave back. */
  | { kind: 'subagent'; id: string; name: string; title: string; agent?: string; prompt: string; result?: string; error?: true; truncated?: true };

/** A prompt and everything the agent did after it, up to the next prompt. The first turn may have no prompt. */
export interface TranscriptTurn { index: number; at?: string; prompt?: string; parts: TranscriptPart[]; truncated?: true }

/** A page of a job's transcript (`POST /ui/api/jobs/:id/transcript`): the turns from `start`, of `total`. */
export interface JobTranscript { jobId: string; checkpointAt: string; total: number; start: number; turns: TranscriptTurn[] }

/** At most this many characters of a prompt, a text or a reasoning. */
export const TRANSCRIPT_TEXT_MAX = 20_000;
/** At most this many characters of a tool call's input or result. */
export const TRANSCRIPT_TOOL_MAX = 8_000;
/** At most this many characters of a tool call's title. */
const TITLE_MAX = 120;
/** A page's turns unless it says. */
export const TRANSCRIPT_PAGE = 20;

const PLAN_TOOLS = new Set(['TodoWrite']);
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

type Block = { type?: unknown; text?: unknown; thinking?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };
type Line = { type?: unknown; timestamp?: unknown; isMeta?: unknown; isSidechain?: unknown; message?: { content?: unknown } };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const cut = (text: string, max: number): { text: string; truncated?: true } => (text.length > max ? { text: text.slice(0, max), truncated: true } : { text });
const oneLine = (text: string): string => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t; };

/** A tool result's text: its string, or its text blocks joined, an image named. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b: Block) => (b.type === 'text' ? str(b.text) ?? '' : b.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
}

/** What a tool call did, in a few words: its description, else the field that names its target, else its name. */
function titleOf(name: string, input: Record<string, unknown>): string {
  for (const key of ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt']) {
    const v = str(input[key]);
    if (v?.trim()) return oneLine(v);
  }
  return name;
}

function toolPart(b: Block): TranscriptPart {
  const id = str(b.id) ?? '';
  const name = str(b.name) ?? 'tool';
  const input = b.input && typeof b.input === 'object' ? b.input as Record<string, unknown> : {};
  if (PLAN_TOOLS.has(name) && Array.isArray(input.todos)) {
    const items = (input.todos as { content?: unknown; status?: unknown }[]).map((t) => ({
      text: str(t.content) ?? '',
      status: (['pending', 'in_progress', 'completed'] as const).find((s) => s === t.status) ?? 'pending',
    }));
    return { kind: 'plan', id, items };
  }
  if (SUBAGENT_TOOLS.has(name)) {
    const agent = str(input.subagent_type);
    const prompt = cut(str(input.prompt) ?? '', TRANSCRIPT_TOOL_MAX);
    return { kind: 'subagent', id, name, title: oneLine(str(input.description) ?? name), ...(agent ? { agent } : {}), prompt: prompt.text, ...(prompt.truncated ? { truncated: true } : {}) };
  }
  const command = str(input.command);
  const shown = cut(command ?? JSON.stringify(input, null, 2), TRANSCRIPT_TOOL_MAX);
  return { kind: 'tool', id, name, title: titleOf(name, input), input: shown.text, ...(shown.truncated ? { truncated: true } : {}) };
}

/** The turns of a session file. A line that is no JSON, a subagent's own line and the session's bookkeeping are left out. */
export function parseTranscript(session: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const calls = new Map<string, TranscriptPart & { kind: 'tool' | 'subagent' }>();
  const current = (at?: string): TranscriptTurn => {
    const last = turns.at(-1);
    if (last) return last;
    const t: TranscriptTurn = { index: 0, ...(at ? { at } : {}), parts: [] };
    turns.push(t);
    return t;
  };
  for (const raw of session.split('\n')) {
    if (!raw.trim()) continue;
    let l: Line;
    try { l = JSON.parse(raw) as Line; } catch { continue; }
    if (!l || typeof l !== 'object' || l.isSidechain === true || l.isMeta === true) continue;
    const at = str(l.timestamp);
    const content = l.message?.content;
    const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content as Block[] : [];
    if (l.type === 'user') {
      for (const b of blocks.filter((x) => x.type === 'tool_result')) {
        const call = calls.get(str(b.tool_use_id) ?? '');
        if (!call) continue;
        const r = cut(resultText(b.content), TRANSCRIPT_TOOL_MAX);
        call.result = r.text;
        if (r.truncated) call.truncated = true;
        if (b.is_error === true) call.error = true;
      }
      const prompt = blocks.filter((x) => x.type === 'text').map((x) => str(x.text) ?? '').join('\n').trim();
      if (!prompt) continue;
      const p = cut(prompt, TRANSCRIPT_TEXT_MAX);
      turns.push({ index: turns.length, ...(at ? { at } : {}), prompt: p.text, parts: [], ...(p.truncated ? { truncated: true } : {}) });
    } else if (l.type === 'assistant') {
      const turn = current(at);
      for (const b of blocks) {
        if (b.type === 'text' || b.type === 'thinking') {
          const t = (b.type === 'text' ? str(b.text) : str(b.thinking))?.trim();
          if (!t) continue;
          const c = cut(t, TRANSCRIPT_TEXT_MAX);
          turn.parts.push({ kind: b.type === 'text' ? 'text' : 'reasoning', text: c.text, ...(c.truncated ? { truncated: true } : {}) });
        } else if (b.type === 'tool_use') {
          const part = toolPart(b);
          turn.parts.push(part);
          if (part.kind === 'tool' || part.kind === 'subagent') calls.set(part.id, part);
        }
      }
    }
  }
  return turns;
}

/** The newest `limit` turns before turn `before` (all of them unless it says), with where they start and how many there are. */
export function transcriptPage(turns: readonly TranscriptTurn[], o: { before?: number; limit?: number }): { total: number; start: number; turns: TranscriptTurn[] } {
  const end = Math.min(o.before ?? turns.length, turns.length);
  const start = Math.max(0, end - (o.limit ?? TRANSCRIPT_PAGE));
  return { total: turns.length, start, turns: turns.slice(start, end) };
}
