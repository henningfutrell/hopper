// The command executor (issue #58, design.md "Container targets"): runs a job's body as a shell
// script on the machine its lane is on, through that machine's connection — this machine (none),
// ssh, or, on a container target, a one-shot sandbox box of its own (issue #865) — and returns what
// it printed. No agent, no questions. Not idempotent: a restart never runs a command twice.
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { ExecutionContext, ExecutionOutcome, Executor } from '../domain/ports.ts';
import type { CommandBoxes } from '../domain/sandboxes.ts';
import type { MachineSnapshot } from '../domain/types.ts';
import { scrubbedEnv, userProcessEnv } from './env.ts';
import { shellQuote, sshArgv, type SshAuth } from './ssh.ts';

/** Per stream, the tail kept in the job's result. */
const OUTPUT_CAP = 16000;
/** Per stream, the most a run keeps while it runs: past it, the run is stopped (issue #1958). */
const RUN_BUFFER_MIB = 64;
const ABORTED: ExecutionOutcome = { kind: 'failed', error: 'aborted' };

export interface CommandExecutorOptions {
  name: string;
  /** Wall-clock limit of one command. */
  timeoutMs: number;
  sshBin?: string;
  /** Where ssh's shared connection sockets live; absent → no sharing. */
  sshControlDir?: string;
  /** How the hopper proves itself to an ssh target (design.md "Target authentication"); throws when it cannot. */
  sshAuth: () => SshAuth;
  /** A container target's command boxes, through the sandbox module (issue #865); absent: this hopper starts none. */
  boxes?: CommandBoxes;
  /** Over the daemon's environment for what runs on this machine: the user's CLI config dirs (issue #158). */
  userEnv?: Readonly<Record<string, string>>;
}

/** The script a body carries: its first fenced code block when it has one, else the whole body. */
export function scriptOf(body: string): string {
  const fenced = /^```[^\n]*\n([\s\S]*?)^```/m.exec(body);
  return fenced ? fenced[1]! : body;
}

const tail = (s: string): string => (s.length > OUTPUT_CAP ? s.slice(-OUTPUT_CAP) : s);

/** The program and argv that run `argv` on the machine, by its connection. A container target's commands run in boxes, not here. */
export function commandOn(machine: MachineSnapshot, argv: string[], o: Pick<CommandExecutorOptions, 'sshBin' | 'sshControlDir' | 'sshAuth'>): [string, string[]] {
  if (machine.containerImage) throw new Error('a container target runs each command in a sandbox box of its own, not over a connection');
  // A client target runs no job body (design.md "Client targets"); without this the command would run here.
  if (machine.client) throw new Error('the command executor does not run on a client target: a client runs no job body');
  if (machine.ssh) {
    const t = { target: machine.ssh, auth: o.sshAuth, ...(o.sshBin ? { bin: o.sshBin } : {}), ...(o.sshControlDir ? { controlDir: o.sshControlDir } : {}) };
    return [o.sshBin ?? 'ssh', sshArgv(t, argv.map(shellQuote).join(' '))];
  }
  return [argv[0]!, argv.slice(1)];
}

export interface Ran { exitCode: number; stdout: string; stderr: string }

/**
 * Runs a program to its end: what it printed and its exit code, or how it was stopped. `userEnv` over the daemon's
 * environment; `onOutput` sees its stdout and stderr as they come (a device code it waits on, issue #476).
 */
export function run(file: string, args: string[], timeoutMs: number, signal: AbortSignal, userEnv: Readonly<Record<string, string>> = {}, onOutput?: (chunk: string) => void): Promise<Ran | 'aborted' | 'timeout'> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, {
      env: scrubbedEnv(userProcessEnv(userEnv)), timeout: timeoutMs, killSignal: 'SIGKILL', signal, maxBuffer: RUN_BUFFER_MIB * 1024 * 1024, encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ exitCode: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (signal.aborted) return resolve('aborted');
      if (e.killed) return resolve('timeout');
      if (typeof e.code === 'number') return resolve({ exitCode: e.code, stdout, stderr });
      if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new Error(`printed more than ${RUN_BUFFER_MIB} MiB`));
      reject(new Error(`${file}: ${e.message}`));
    });
    if (onOutput) for (const out of [child.stdout, child.stderr]) out?.on('data', (c: string | Buffer) => onOutput(String(c)));
  });
}

export function createCommandExecutor(o: CommandExecutorOptions): Executor {
  if (o.sshControlDir) mkdirSync(o.sshControlDir, { recursive: true, mode: 0o700 });
  /** On a container target: the script in a one-shot box of its image, its output one stream, as the box's terminal wrote it. */
  async function inBox(ctx: ExecutionContext, env: Record<string, string>, script: string): Promise<ExecutionOutcome> {
    const where = ctx.machine.id;
    if (!o.boxes) return { kind: 'failed', error: `command on ${where}: this hopper starts no sandbox box, so a container target runs no command` };
    let output = '';
    const r = await o.boxes.run({ jobId: ctx.job.id, image: ctx.machine.containerImage!, script, env, timeoutMs: o.timeoutMs }, { log: (chunk) => { output += chunk; }, signal: ctx.signal });
    if (ctx.signal.aborted) return ABORTED;
    if (r.stopped === 'timed-out') return { kind: 'failed', error: `command on ${where} timed out after ${o.timeoutMs} ms` };
    if (r.problem) return { kind: 'failed', error: `command on ${where}: ${r.problem}` };
    const stdout = tail(output.replaceAll('\r\n', '\n'));
    if (r.exit !== 0) return { kind: 'failed', error: `command exited ${r.exit} on ${where}: ${stdout.trim()}` };
    return { kind: 'finished', result: { machine: where, exitCode: 0, stdout, stderr: '' } };
  }
  return {
    name: o.name,
    idempotent: false,
    validate(payload) {
      return typeof payload.body === 'string' && payload.body.trim() !== '' ? null : 'body must be a non-empty string: the command to run';
    },
    async run(ctx: ExecutionContext): Promise<ExecutionOutcome> {
      const { body, env } = ctx.job.spec.payload as { body: string; env?: Record<string, string> };
      const where = ctx.machine.id;
      if (ctx.machine.containerImage) return inBox(ctx, { ...env, HOPPER_JOB_ID: ctx.job.id }, scriptOf(body));
      const vars = Object.entries({ ...env, HOPPER_JOB_ID: ctx.job.id }).map(([k, v]) => `${k}=${v}`);
      try {
        const [file, args] = commandOn(ctx.machine, ['env', ...vars, 'sh', '-c', scriptOf(body)], o);
        const r = await run(file, args, o.timeoutMs, ctx.signal, o.userEnv);
        if (r === 'aborted') return ABORTED;
        if (r === 'timeout') return { kind: 'failed', error: `command on ${where} timed out after ${o.timeoutMs} ms` };
        if (r.exitCode !== 0) return { kind: 'failed', error: `command exited ${r.exitCode} on ${where}: ${tail((r.stderr.trim() || r.stdout.trim()))}` };
        return { kind: 'finished', result: { machine: where, exitCode: 0, stdout: tail(r.stdout), stderr: tail(r.stderr) } };
      } catch (e) {
        return { kind: 'failed', error: `command on ${where}: ${(e as Error).message}` };
      }
    },
  };
}
