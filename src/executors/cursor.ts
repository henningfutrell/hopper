// The cursor-agent executor (issue #142, design.md "Cursor executor"): one job is Cursor's CLI agent
// in print mode, run on the job's machine through its connection — this machine or an ssh target —
// in the job's work tree. Each turn is one `cursor-agent -p` run; its answer ends with the hopper
// protocol's marker. A question parks the job with the Cursor chat id, and the answer resumes that
// chat (`--resume`). Nothing outlives a turn, so there is nothing to reattach or clean up: not
// idempotent, a restart fails a running job and never runs the agent twice.
import { mkdirSync } from 'node:fs';
import type { ExecutionContext, ExecutionOutcome, Executor } from '../domain/ports.ts';
import { commandOn, run } from './command.ts';
import { resolvePayload, validatePayload } from './herdr/payload.ts';
import { normaliseMarkerLine, protocolFooter } from './herdr/screen.ts';
import { scratchDirOf } from './herdr/start.ts';
import { shellQuote, type SshAuth } from './ssh.ts';

/** The answer's tail kept for whoever answers a question. */
const OUTPUT_CAP = 16000;
const SUMMARY_CHARS = 2000;

export interface CursorExecutorOptions {
  name: string;
  /** Cursor's CLI agent on the job's machine. */
  bin: string;
  /** Its own arguments: permissions (`--force`), workspace trust (`--trust`), sandbox. */
  args: string[];
  /** The work tree of a job whose payload names none. */
  defaultCwd: string;
  sshBin?: string;
  sshControlDir?: string;
  sshAuth: () => SshAuth;
}

/** What a parked job keeps: the chat to resume, in the work tree it ran in. */
interface CursorState { chatId: string; cwd: string }

interface CursorResult { is_error?: boolean; result?: unknown; session_id?: unknown }

const tail = (s: string): string => (s.length > OUTPUT_CAP ? s.slice(-OUTPUT_CAP) : s);

/** The answer's outcome by the marker on its last line (design.md "Phase 2" markers). */
export function outcomeOf(text: string, machine: string, chatId: string): ExecutionOutcome {
  const lines = text.trimEnd().split('\n');
  const last = normaliseMarkerLine(lines.at(-1) ?? '');
  const before = lines.slice(0, -1).join('\n').trim();
  if (last === 'HOPPER_DONE') return { kind: 'finished', result: { machine, summary: before.slice(0, SUMMARY_CHARS), chatId } };
  if (last.startsWith('HOPPER_FAILED')) return { kind: 'failed', error: last.slice('HOPPER_FAILED'.length).trim() || 'HOPPER_FAILED without a reason' };
  if (last === 'HOPPER_QUESTION') return { kind: 'question', question: { text: before, recentOutput: tail(text.trim()), detectedBy: 'marker' } };
  // The turn ended without a marker: the agent stopped and waits, so its last words go to whoever answers.
  return { kind: 'question', question: { text: text.trim(), recentOutput: tail(text.trim()), detectedBy: 'idle' } };
}

function refusal(ctx: ExecutionContext): string | undefined {
  const m = ctx.machine;
  if (m.docker) return `cursor-agent does not run on container target ${m.id}: it has no agent`;
  if (m.client) return `cursor-agent does not run on client target ${m.id}: a client serves herdr only`;
  return undefined;
}

export function createCursorExecutor(o: CursorExecutorOptions): Executor {
  if (o.sshControlDir) mkdirSync(o.sshControlDir, { recursive: true, mode: 0o700 });
  async function turn(ctx: ExecutionContext, cwd: string, text: string, chatId?: string): Promise<ExecutionOutcome> {
    const refused = refusal(ctx);
    if (refused) return { kind: 'failed', error: refused };
    const p = resolvePayload(ctx.job.spec.payload, o.defaultCwd);
    const scratch = scratchDirOf(cwd);
    // HOPPER_JOB_ID and the scratch dir come from the hopper; a payload cannot move them.
    const vars = Object.entries({ ...p.env, TMPDIR: scratch, HOPPER_JOB_ID: ctx.job.id }).map(([k, v]) => shellQuote(`${k}=${v}`));
    const argv = [
      o.bin, '-p', '--output-format', 'json', '--workspace', cwd, ...o.args,
      ...(p.model ? ['--model', p.model] : []), ...(chatId ? ['--resume', chatId] : []), '--', text,
    ].map(shellQuote);
    const script = `mkdir -p ${shellQuote(scratch)} && printf '*\\n' > ${shellQuote(`${scratch}/.gitignore`)} && cd ${shellQuote(cwd)} && exec env ${vars.join(' ')} ${argv.join(' ')}`;
    const where = ctx.machine.id;
    try {
      const [file, args] = commandOn(ctx.machine, ['sh', '-c', script], { ...o, dockerHost: () => { throw new Error('no docker'); } });
      ctx.progress(0, `cursor-agent ${chatId ? 'resumed' : 'started'} on ${where}`);
      const r = await run(file, args, p.timeoutMs, ctx.signal);
      if (r === 'aborted') return { kind: 'failed', error: 'aborted' };
      if (r === 'timeout') return { kind: 'failed', error: `cursor-agent on ${where} timed out after ${p.timeoutMs} ms` };
      if (r.exitCode !== 0) return { kind: 'failed', error: `cursor-agent exited ${r.exitCode} on ${where}: ${tail(r.stderr.trim() || r.stdout.trim())}` };
      let answer: CursorResult;
      try { answer = JSON.parse(r.stdout.trim()) as CursorResult; } catch { return { kind: 'failed', error: `cursor-agent on ${where} printed no JSON result: ${tail(r.stdout.trim())}` }; }
      const said = typeof answer.result === 'string' ? answer.result : '';
      if (answer.is_error) return { kind: 'failed', error: `cursor-agent on ${where}: ${tail(said.trim()) || 'error without a message'}` };
      if (typeof answer.session_id !== 'string' || answer.session_id === '') return { kind: 'failed', error: `cursor-agent on ${where} answered without a chat id` };
      const out = outcomeOf(said, where, answer.session_id);
      if (out.kind === 'question') ctx.saveState({ chatId: answer.session_id, cwd } satisfies CursorState);
      return out;
    } catch (e) {
      return { kind: 'failed', error: `cursor-agent on ${where}: ${(e as Error).message}` };
    }
  }

  return {
    name: o.name,
    idempotent: false,
    validate: validatePayload,
    run(ctx) {
      const p = resolvePayload(ctx.job.spec.payload, o.defaultCwd);
      return turn(ctx, p.cwd, `${p.prompt}\n\n${protocolFooter(p.cwd)}`);
    },
    resume(ctx, answer) {
      const s = ctx.job.executorState as Partial<CursorState> | undefined;
      if (!s?.chatId || !s.cwd) return Promise.resolve({ kind: 'failed', error: 'cursor-agent: no chat to resume' });
      return turn(ctx, s.cwd, answer, s.chatId);
    },
  };
}
