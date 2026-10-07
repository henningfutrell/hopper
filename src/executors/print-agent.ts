// The print-mode agent executors (design.md "Print-mode agent executors"; issue #142 for Cursor's agent,
// #307 for codex, opencode and omp): one job is an agent CLI in print mode, run on the job's machine
// through its connection — this machine or an ssh target — in the job's work tree. Each turn is one run;
// its last message ends with the hopper protocol's marker. A question parks the job with the agent's
// session id, and the answer resumes that session. Nothing outlives a turn, so there is nothing to
// reattach or clean up: not idempotent, a restart fails a running job and never runs the agent twice.
// How each CLI is called and read is print-agents.ts's.
import { mkdirSync } from 'node:fs';
import type { ExecutionContext, ExecutionOutcome, Executor } from '../domain/ports.ts';
import { commandOn, run } from './command.ts';
import { resolvePayload, validatePayload, workTreeOn } from './herdr/payload.ts';
import { STATUS_NOTE_NUDGE, normaliseMarkerLine, protocolFooter } from './herdr/screen.ts';
import { scratchDirOf } from './herdr/start.ts';
import { DIALECTS, type PrintAgent } from './print-agents.ts';
import { shellQuote, type SshAuth } from './ssh.ts';

/** The answer's tail kept for whoever answers a question. */
const OUTPUT_CAP = 16000;
const SUMMARY_CHARS = 2000;
/** Nudges after status notes in a row before the job fails: a print-mode turn never waits on background work. */
const NUDGES = 3;

export interface PrintAgentExecutorOptions {
  /** Which CLI: the id of its executor plugin. */
  agent: PrintAgent;
  name: string;
  /** The agent's CLI on the job's machine. */
  bin: string;
  /** Its own arguments: permissions, sandbox, workspace trust. */
  args: string[];
  /** The work tree of a job whose payload names none. */
  defaultCwd: string;
  sshBin?: string;
  sshControlDir?: string;
  sshAuth: () => SshAuth;
  /** Over the daemon's environment for what runs on this machine: the user's CLI config dirs (issue #158). */
  userEnv?: Readonly<Record<string, string>>;
}

/** What a parked job keeps: the agent's session (its chat) to resume, in the work tree it ran in. */
interface PrintAgentState { chatId: string; cwd: string }

const tail = (s: string): string => (s.length > OUTPUT_CAP ? s.slice(-OUTPUT_CAP) : s);

/** An answer without a marker (issue #163): progress, never a question. */
interface StatusNote { statusNote: string }

/** The answer's outcome by the marker on its last line (design.md "Phase 2" markers). */
export function outcomeOf(text: string, machine: string, chatId: string): ExecutionOutcome | StatusNote {
  const lines = text.trimEnd().split('\n');
  const last = normaliseMarkerLine(lines.at(-1) ?? '');
  const before = lines.slice(0, -1).join('\n').trim();
  if (last === 'HOPPER_DONE') return { kind: 'finished', result: { machine, summary: before.slice(0, SUMMARY_CHARS), chatId } };
  if (last.startsWith('HOPPER_FAILED')) return { kind: 'failed', error: last.slice('HOPPER_FAILED'.length).trim() || 'HOPPER_FAILED without a reason' };
  if (last === 'HOPPER_QUESTION') return { kind: 'question', question: { text: before, recentOutput: tail(text.trim()), detectedBy: 'marker' } };
  return { statusNote: text.trim() };
}

function refusal(agent: PrintAgent, ctx: ExecutionContext): string | undefined {
  const m = ctx.machine;
  if (m.docker) return `${agent} does not run on container target ${m.id}: it has no agent`;
  if (m.client) return `${agent} does not run on client target ${m.id}: a client serves herdr only`;
  return undefined;
}

export function createPrintAgentExecutor(o: PrintAgentExecutorOptions): Executor {
  const dialect = DIALECTS[o.agent];
  const label = o.agent;
  if (o.sshControlDir) mkdirSync(o.sshControlDir, { recursive: true, mode: 0o700 });
  /** One turn; `notes` is how many answers in a row before it carried no marker. */
  async function turn(ctx: ExecutionContext, cwd: string, text: string, chatId?: string, notes = 0): Promise<ExecutionOutcome> {
    const refused = refusal(label, ctx);
    if (refused) return { kind: 'failed', error: refused };
    const p = resolvePayload(ctx.job.spec.payload, ctx.machine, o.defaultCwd);
    const scratch = scratchDirOf(cwd);
    // Stdin is /dev/null: codex and opencode read a stdin that is not a terminal to its end before the turn,
    // and the one a run would hand them is never closed (issue #307).
    // The job's credentials (GH_TOKEN, issue #214), HOPPER_JOB_ID and the scratch dir come from the hopper; a payload cannot move them.
    const vars = Object.entries({ ...p.env, ...ctx.credentials, TMPDIR: scratch, HOPPER_JOB_ID: ctx.job.id }).map(([k, v]) => shellQuote(`${k}=${v}`));
    const argv = dialect.argv({ bin: o.bin, args: o.args, cwd, ...(p.model ? { model: p.model } : {}), ...(chatId ? { session: chatId } : {}), text }).map(shellQuote);
    const script = `mkdir -p ${shellQuote(scratch)} && printf '*\\n' > ${shellQuote(`${scratch}/.gitignore`)} && cd ${shellQuote(cwd)} && exec env ${vars.join(' ')} ${argv.join(' ')} </dev/null`;
    const where = ctx.machine.id;
    try {
      const [file, args] = commandOn(ctx.machine, ['sh', '-c', script], { ...o, dockerHost: () => { throw new Error('no docker'); } });
      ctx.progress(0, `${label} ${chatId ? 'resumed' : 'started'} on ${where}`);
      const r = await run(file, args, p.timeoutMs, ctx.signal, o.userEnv);
      if (r === 'aborted') return { kind: 'failed', error: 'aborted' };
      if (r === 'timeout') return { kind: 'failed', error: `${label} on ${where} timed out after ${p.timeoutMs} ms` };
      const answer = dialect.read(r.stdout);
      if (r.exitCode !== 0) {
        const said = 'error' in answer ? answer.error : r.stderr.trim() || r.stdout.trim();
        return { kind: 'failed', error: `${label} exited ${r.exitCode} on ${where}: ${tail(said)}` };
      }
      if ('error' in answer) return { kind: 'failed', error: `${label} on ${where}: ${tail(answer.error)}` };
      if ('unreadable' in answer) return { kind: 'failed', error: `${label} on ${where} ${tail(answer.unreadable)}` };
      const out = outcomeOf(answer.text, where, answer.session);
      if ('statusNote' in out) {
        // A status note opens no question (issue #163): the agent is nudged in the same session.
        ctx.progress(0, out.statusNote);
        if (notes >= NUDGES) return { kind: 'failed', error: `${label} answered ${notes + 1} times in a row without a marker: ${tail(out.statusNote)}` };
        return await turn(ctx, cwd, STATUS_NOTE_NUDGE, answer.session, notes + 1);
      }
      if (out.kind === 'question') ctx.saveState({ chatId: answer.session, cwd } satisfies PrintAgentState);
      return out;
    } catch (e) {
      return { kind: 'failed', error: `${label} on ${where}: ${(e as Error).message}` };
    }
  }

  return {
    name: o.name,
    idempotent: false,
    validate: validatePayload,
    run(ctx) {
      const p = resolvePayload(ctx.job.spec.payload, ctx.machine, o.defaultCwd);
      // Issue #323: `~` is the lane's machine's home, never this process's when the job runs elsewhere.
      const tree = workTreeOn(ctx.machine, p.cwd);
      if ('error' in tree) return Promise.resolve({ kind: 'failed', error: tree.error });
      ctx.workTree(tree.cwd);
      return turn(ctx, tree.cwd, `${p.prompt}\n\n${protocolFooter(tree.cwd, ctx.jobRules)}`);
    },
    resume(ctx, answer) {
      const s = ctx.job.executorState as Partial<PrintAgentState> | undefined;
      if (!s?.chatId || !s.cwd) return Promise.resolve({ kind: 'failed', error: `${label}: no session to resume` });
      return turn(ctx, s.cwd, answer, s.chatId);
    },
  };
}
