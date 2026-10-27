// The print-mode agent executors (design.md "Print-mode agent executors"; issue #142 for Cursor's agent,
// #307 for codex, opencode and omp): one job is an agent CLI in print mode, run on the job's machine
// through its connection — this machine, an ssh target or a client target — in the job's work tree. Each turn is one run;
// its last message ends with the hopper protocol's marker; on a client target (issue #865) the turn goes down the
// machine's link as `POST /turn`, the same script, and the reap as its `/reap`. A question pauses the job with the agent's
// session id, and the answer resumes that session. Not idempotent: a restart fails a running job and
// never runs the agent twice. As a herdr-claude job (issue #410): its own scratch dir, each turn in the
// job's systemd user scope where the machine has one (the turn before stopped first), and the reap when
// the job ends, through the machine's connection. How each CLI is called and read is print-agents.ts's.
import { mkdirSync } from 'node:fs';
import type { ExecutionContext, ExecutionOutcome, Executor, MachineShell } from '../domain/ports.ts';
import { REVIEW_KINDS, REVIEW_SECTIONS, type MachineSnapshot } from '../domain/types.ts';
import { scopeUnitOf } from '../client/reap.ts';
import { scopeLimitProperties, scopeLimitsOf, type JobLimits } from '../domain/job-limits.ts';
import { runtimeCommand, runtimeEnvOf, turnServiceCommand } from '../client/job-runtime.ts';
import { SANDBOX_SUBDIR, sandboxCommand } from '../client/job-sandbox.ts';
import { commandOn, run, type Ran } from './command.ts';
import { resolvePayload, validatePayload, workTreeOn } from './herdr/payload.ts';
import { makeJobWorktreeCommand } from './herdr/job-worktree.ts';
import { STATUS_NOTE_NUDGE, normaliseMarkerLine, protocolFooter, waitFields } from './herdr/screen.ts';
import { jobScratchOf, jobTmpOf, jobToolEnv, linkTmpCommand, mkScratchCommand } from './herdr/start.ts';
import { clientShell, localShell, sshShell } from './machine-shell.ts';
import { clientTurn, type ClientTransport } from './client.ts';
import { DIALECTS, type PrintAgent } from './print-agents.ts';
import { shellQuote, type SshAuth } from './ssh.ts';
import { hideCodes } from '../logins/recognise.ts';
import { watchRunOutput } from '../logins/run-output.ts';
import { lastTaskCount } from '../domain/task-count.ts';
import { HEAVY_SHIMS } from '../domain/heavy-steps.ts';
import { withMemoryLines } from '../domain/repo-memory.ts';

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
  sshBin?: string;
  sshControlDir?: string;
  sshAuth: () => SshAuth;
  /** Over the daemon's environment for what runs on this machine: the user's CLI config dirs (issue #158). */
  userEnv?: Readonly<Record<string, string>>;
  /** A client target's link, by its machine id (issue #865); undefined while none has it. */
  client?: (machine: string) => ClientTransport | undefined;
}

/**
 * What a job keeps: the work tree it runs in and the ssh or client target it runs on (absent: this machine), for the
 * reap; once on a question, the agent's session (its chat) to resume.
 */
type PrintAgentState = { cwd: string; ssh?: string; client?: string; chatId?: string };

const tail = (s: string): string => (s.length > OUTPUT_CAP ? s.slice(-OUTPUT_CAP) : s);

/** An answer without a marker (issue #163): progress, never a question. */
interface StatusNote { statusNote: string }

/** The answer's outcome by the marker on its last line (design.md "Phase 2" markers). */
export function outcomeOf(text: string, machine: string, chatId: string): ExecutionOutcome | StatusNote {
  const lines = text.trimEnd().split('\n');
  const last = normaliseMarkerLine(lines.at(-1) ?? '');
  const before = lines.slice(0, -1).join('\n').trim();
  if (last === 'HOPPER_DONE') return { kind: 'finished', result: { machine, summary: withMemoryLines(before, SUMMARY_CHARS), chatId } };
  if (last.startsWith('HOPPER_FAILED')) return { kind: 'failed', error: last.slice('HOPPER_FAILED'.length).trim() || 'HOPPER_FAILED without a reason' };
  if (last === 'HOPPER_QUESTION') return { kind: 'question', question: { text: before, recentOutput: tail(text.trim()), detectedBy: 'marker' } };
  const review = REVIEW_KINDS.find((k) => REVIEW_SECTIONS[k].marker === last);
  if (review) return { kind: 'report', review, report: { text: before, recentOutput: tail(text.trim()) } };
  // Its own wait (issue #483): the marker, then its fields to the end. A person ends it; the answer resumes the session.
  const at = lines.findLastIndex((l) => normaliseMarkerLine(l) === 'HOPPER_WAITING');
  const wait = at >= 0 ? waitFields(lines.slice(at + 1)) : undefined;
  if (wait) return { kind: 'wait', wait };
  return { statusNote: text.trim() };
}

/**
 * The turn's command on the job's machine (issue #410): the agent in the job's own scope where the machine
 * has a systemd user manager — the scope of a turn before, and whatever it left, stopped first, since a turn
 * never waits on background work —, else as it is. A trial run first, so a systemd that cannot make a scope
 * runs the agent without one. The scope gets the machine's job limits (issue #2622, src/domain/job-limits.ts).
 */
export function turnCommand(jobId: string, run: string, limits?: JobLimits): string {
  const unit = scopeUnitOf(jobId);
  const props = scopeLimitProperties(limits).map((p) => ` -p ${p}`).join('');
  return `if command -v systemd-run >/dev/null 2>&1 && systemd-run --user --scope --quiet --collect${props} -- true >/dev/null 2>&1; then`
    // systemd 254 and later expand `$` in the command's arguments, which would rewrite a script's own variables.
    + ' x=--expand-environment=no; systemd-run --user --scope --quiet --collect $x -- true >/dev/null 2>&1 || x=;'
    + ` systemctl --user stop ${unit}.scope >/dev/null 2>&1;`
    + ` exec systemd-run --user --scope --quiet --collect $x --unit=${unit} -p KillMode=control-group -p TimeoutStopSec=10s${props} -- ${run}; fi; exec ${run}`;
}

/**
 * What a turn's scope runs (issue #1295), `sh -c` of it: the job's own container runtime, with its socket started in the
 * scope, then the job's sandbox around the agent's `run`, as around Claude in a pane, and the socket stopped when the agent
 * ends, the turn ending only once it did (issue #1840); its exit code is the agent's. What the setup prints stays out of
 * the agent's answer. A runtime that wrote no environment, or a sandbox that could not be set up, ends the turn (exit 125):
 * it would run next to the host's runtime.
 * A machine where bubblewrap cannot run runs the agent as before, with the job's runtime and its guards.
 */
export function isolatedTurn(jobId: string, scratch: string, run: string): string {
  const fail = (what: string): string => `{ printf '%s\\n' ${shellQuote(`hopper: the job ${what} could not be set up`)} >&2; exit 125; }`;
  return `{ ${runtimeCommand(jobId, scratch, false, HEAVY_SHIMS)}; } >/dev/null 2>&1; [ -r ${shellQuote(runtimeEnvOf(scratch))} ] || ${fail('container runtime')}; `
    + `case $( { ${sandboxCommand(scratch)}; } 2>/dev/null) in *hopper-sandbox-on) w=${shellQuote(`${scratch}/${SANDBOX_SUBDIR}/run`)};; *hopper-sandbox-none) w=;; *) ${fail('sandbox')};; esac; `
    + `${turnServiceCommand(jobId, scratch)} \${w:+"$w"} ${run}; r=$?; [ -n "$sp" ] && { kill "$sp"; wait "$sp"; } 2>/dev/null; exit $r`;
}

/** A first turn's text: the job's prompt, what it is told besides (notes, a brief), and the protocol. */
function taskOf(ctx: ExecutionContext, prompt: string, cwd: string, told: string | undefined): string {
  return `${prompt}\n\n${told ? `${told}\n\n` : ''}${protocolFooter(cwd, ctx.jobRules, jobScratchOf(cwd, ctx.job.id))}`;
}

function refusal(agent: PrintAgent, ctx: ExecutionContext): string | undefined {
  const m = ctx.machine;
  if (m.containerImage) return `${agent} does not run on container target ${m.id}: it has no agent`;
  return undefined;
}

export function createPrintAgentExecutor(o: PrintAgentExecutorOptions): Executor {
  const dialect = DIALECTS[o.agent];
  const label = o.agent;
  if (o.sshControlDir) mkdirSync(o.sshControlDir, { recursive: true, mode: 0o700 });
  /** A client target's link, looked up at each call: it may join, be renamed or dial in again while the job runs. */
  const transportOf = (machine: string): ClientTransport => ({
    machine, link: () => o.client?.(machine)?.link(), token: () => o.client?.(machine)?.token() ?? '',
  });
  /** The machine as this executor reaches it: this one, an ssh target or a client target. */
  const shellOn = (s: { ssh?: string; client?: string }): MachineShell => (s.client ? clientShell(transportOf(s.client)) : s.ssh
    ? sshShell({ target: s.ssh, auth: o.sshAuth, ...(o.sshBin ? { bin: o.sshBin } : {}), ...(o.sshControlDir ? { controlDir: o.sshControlDir } : {}) })
    : localShell(o.userEnv));
  const stateOf = (ctx: ExecutionContext, cwd: string): PrintAgentState => ({ cwd, ...(ctx.machine.client ? { client: ctx.machine.id } : ctx.machine.ssh ? { ssh: ctx.machine.ssh } : {}) });
  /** One run of the turn's script on the job's machine; on a client target its output comes at its end, so no login is seen while it waits. */
  const runOn = async (ctx: ExecutionContext, script: string, timeoutMs: number, feed: (chunk: string) => void): Promise<Ran | 'aborted' | 'timeout'> => {
    if (!ctx.machine.client) {
      const [file, args] = commandOn(ctx.machine, ['sh', '-c', script], o);
      return run(file, args, timeoutMs, ctx.signal, o.userEnv, feed);
    }
    if (!o.client?.(ctx.machine.id)?.link()) throw new Error(`client ${ctx.machine.id} is not dialled in`);
    try {
      const r = await clientTurn(transportOf(ctx.machine.id), script, timeoutMs, ctx.signal);
      return r.timedOut ? 'timeout' : { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
    } catch (e) {
      if (ctx.signal.aborted) return 'aborted';
      throw e;
    }
  };
  /** One turn; `notes` is how many answers in a row before it carried no marker. */
  async function turn(ctx: ExecutionContext, cwd: string, text: string, chatId?: string, notes = 0): Promise<ExecutionOutcome> {
    const refused = refusal(label, ctx);
    if (refused) return { kind: 'failed', error: refused };
    const p = resolvePayload(ctx.job, ctx.machine);
    // The job's own scratch dir (issue #410), so the reap can remove it; the work tree's scratch dirs ignore themselves.
    // TMPDIR is its temp link (issue #506), so a Unix socket path under TMPDIR fits.
    const scratch = jobScratchOf(cwd, ctx.job.id);
    // Stdin is /dev/null: codex and opencode read a stdin that is not a terminal to its end before the turn,
    // and the one a run would hand them is never closed (issue #307).
    // The job's way to the hopper (issues #563, #652: no GitHub token, git through the hopper), HOPPER_JOB_ID, the scratch dir and JOB_TOOL_ENV (issue #1502) with Gradle's idle timeout (issue #2489) come from the hopper; a payload cannot move them.
    const credentials = await ctx.credentials?.(scratch);
    const limits = scopeLimitsOf(ctx.machine);
    const vars = Object.entries({ ...p.env, ...credentials, TMPDIR: jobTmpOf(ctx.job.id), HOPPER_JOB_ID: ctx.job.id, ...jobToolEnv(p.env, limits, jobTmpOf(ctx.job.id)) }).map(([k, v]) => shellQuote(`${k}=${v}`));
    const argv = dialect.argv({ bin: o.bin, args: o.args, cwd, ...(p.model ? { model: p.model } : {}), ...(chatId ? { session: chatId } : {}), text }).map(shellQuote);
    // On the first turn, the job's repository fetched or cloned in a work tree that is no repository (issue #361),
    // with the job's variables (its git through the hopper); what it says goes to stderr, never into the agent's answer.
    const checkout = !chatId && p.repo ? `( export ${vars.join(' ')}; ${makeJobWorktreeCommand(cwd, ctx.job.id, { repo: p.repo, ...(p.repoUrl ? { url: p.repoUrl } : {}), worktrees: false })} ) >&2; ` : '';
    // The job's own container runtime and its sandbox (issue #1295), in the turn's scope.
    const isolated = isolatedTurn(ctx.job.id, scratch, `env ${vars.join(' ')} ${argv.join(' ')} </dev/null`);
    const script = `${mkScratchCommand(cwd, ctx.job.id)} && ${linkTmpCommand(scratch, ctx.job.id)} && cd ${shellQuote(cwd)} && ${checkout}{ ${turnCommand(ctx.job.id, `sh -c ${shellQuote(isolated)}`, limits)}; }`;
    const where = ctx.machine.id;
    try {
      ctx.progress(`${label} ${chatId ? 'resumed' : 'started'} on ${where}`);
      const first = new Date().toISOString();
      // A device code the agent's tools print goes to the logins while the turn waits on it (issue #476).
      const login = watchRunOutput(ctx.logins, { now: () => new Date() }, (line) => ctx.progress(line));
      const r = await runOn(ctx, script, p.timeoutMs, login.feed).then((ran) => {
        login.end(ran === 'aborted' || ran === 'timeout' ? { ok: false, reason: ran === 'aborted' ? 'aborted' : 'timed out' } : ran.exitCode === 0 ? { ok: true } : { ok: false, reason: `exited ${ran.exitCode}` });
        return ran;
      });
      if (r === 'aborted') return { kind: 'failed', error: 'aborted' };
      if (r === 'timeout') return { kind: 'failed', error: `${label} on ${where} timed out after ${p.timeoutMs} ms` };
      // What the turn printed goes on as an error, a question or progress: never with a device code (issue #476).
      // What the turn spent (issue #2302, part 6), whatever it answered.
      const spent = dialect.usage?.(r.stdout, { first, last: new Date().toISOString() });
      if (spent) ctx.tokenUse?.(spent.session, spent.use);
      const seen = `${r.stdout}\n${r.stderr}`;
      const hidden = (text: string): string => hideCodes(text, seen, login.codes());
      const answer = dialect.read(r.stdout);
      if (r.exitCode !== 0) {
        const said = 'error' in answer ? answer.error : r.stderr.trim() || r.stdout.trim();
        return { kind: 'failed', error: `${label} exited ${r.exitCode} on ${where}: ${hidden(tail(said))}` };
      }
      if ('error' in answer) return { kind: 'failed', error: `${label} on ${where}: ${hidden(tail(answer.error))}` };
      if ('unreadable' in answer) return { kind: 'failed', error: `${label} on ${where} ${hidden(tail(answer.unreadable))}` };
      // The last task count the turn wrote is the job's progress (issue #794).
      const tasks = lastTaskCount(answer.text);
      if (tasks) ctx.progress(undefined, tasks);
      const out = outcomeOf(hidden(answer.text), where, answer.session);
      if ('statusNote' in out) {
        // A status note opens no question (issue #163): the agent is nudged in the same session.
        ctx.progress(out.statusNote);
        if (notes >= NUDGES) return { kind: 'failed', error: `${label} answered ${notes + 1} times in a row without a marker: ${tail(out.statusNote)}` };
        return await turn(ctx, cwd, STATUS_NOTE_NUDGE, answer.session, notes + 1);
      }
      if (out.kind === 'question' || out.kind === 'report' || out.kind === 'wait') ctx.saveState({ ...stateOf(ctx, cwd), chatId: answer.session } satisfies PrintAgentState);
      return out;
    } catch (e) {
      return { kind: 'failed', error: `${label} on ${where}: ${(e as Error).message}` };
    }
  }

  return {
    name: o.name,
    idempotent: false,
    reviews: true,
    validate: validatePayload,
    reopensKept: true,
    run(ctx) {
      const refused = refusal(label, ctx);
      if (refused) return Promise.resolve({ kind: 'failed', error: refused });
      const p = resolvePayload(ctx.job, ctx.machine);
      // Issue #323: `~` is the lane's machine's home, never this process's when the job runs elsewhere.
      const tree = workTreeOn(ctx.machine, p.cwd);
      if ('error' in tree) return Promise.resolve({ kind: 'failed', error: tree.error });
      ctx.workTree(tree.cwd);
      // Saved before the turn: a job that ends any way at all is reaped where it ran.
      ctx.saveState(stateOf(ctx, tree.cwd));
      // Notes a person sent before it started (issue #997) go in its task; it has no turn boundary the hopper types into.
      return turn(ctx, tree.cwd, taskOf(ctx, p.prompt, tree.cwd, ctx.notes?.take('start')));
    },
    resume(ctx, answer) {
      const s = ctx.job.executorState as Partial<PrintAgentState> | undefined;
      // Push it (issue #1472 part 2): the ended job goes on in a fresh turn in its saved work tree, its task, then the brief.
      if (ctx.job.continued && s?.cwd) {
        ctx.workTree(s.cwd);
        const notes = ctx.notes?.take('start');
        return turn(ctx, s.cwd, taskOf(ctx, resolvePayload(ctx.job, ctx.machine).prompt, s.cwd, notes ? `${answer}\n\n${notes}` : answer));
      }
      if (!s?.chatId || !s.cwd) return Promise.resolve({ kind: 'failed', error: `${label}: no session to resume` });
      const notes = ctx.notes?.take('resume');
      return turn(ctx, s.cwd, notes ? `${answer}\n\n${notes}` : answer, s.chatId);
    },
    /**
     * The reap (issue #410): the job's scope and processes stopped, its scratch dir removed unless it holds work not pushed,
     * or kept for the retention of its status (issue #2494).
     */
    async cleanup(job, o) {
      const s = job.executorState as Partial<PrintAgentState> | undefined;
      if (!s?.cwd) return undefined;
      return shellOn(s).reap(job.id, jobScratchOf(s.cwd, job.id), o?.keepScratch === true);
    },
    machineShell: (machine: MachineSnapshot) => (machine.containerImage ? undefined : shellOn(machine.client ? { client: machine.id } : { ssh: machine.ssh })),
  };
}
