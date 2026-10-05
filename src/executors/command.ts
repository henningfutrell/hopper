// The command executor (issue #58, design.md "Container targets"): runs a job's body as a shell
// script on the machine its lane is on, through that machine's connection — this machine (none),
// ssh, or `docker exec` into a container target — and returns what it printed. No agent, no
// questions. Not idempotent: a restart never runs a command twice.
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { ExecutionContext, ExecutionOutcome, Executor } from '../domain/ports.ts';
import type { MachineSnapshot } from '../domain/types.ts';
import { dockerArgv, dockerEnv } from './docker.ts';
import { userProcessEnv } from './env.ts';
import { shellQuote, sshArgv, type SshAuth } from './ssh.ts';

/** Per stream, the tail kept in the job's result. */
const OUTPUT_CAP = 16000;
const ABORTED: ExecutionOutcome = { kind: 'failed', error: 'aborted' };

export interface CommandExecutorOptions {
  name: string;
  /** Wall-clock limit of one command. */
  timeoutMs: number;
  dockerBin?: string;
  sshBin?: string;
  /** Where ssh's shared connection sockets live; absent → no sharing. */
  sshControlDir?: string;
  /** How the hopper proves itself to an ssh target (design.md "Target authentication"); throws when it cannot. */
  sshAuth: () => SshAuth;
  /** The docker socket only the hopper may open (design.md "Target authentication"); throws when there is none. */
  dockerHost: () => string;
  /** Over the daemon's environment for what runs on this machine: the user's CLI config dirs (issue #158). */
  userEnv?: Readonly<Record<string, string>>;
}

/** The script a body carries: its first fenced code block when it has one, else the whole body. */
export function scriptOf(body: string): string {
  const fenced = /^```[^\n]*\n([\s\S]*?)^```/m.exec(body);
  return fenced ? fenced[1]! : body;
}

const tail = (s: string): string => (s.length > OUTPUT_CAP ? s.slice(-OUTPUT_CAP) : s);

/** The program and argv that run `argv` on the machine, by its connection. */
export function commandOn(machine: MachineSnapshot, argv: string[], o: Pick<CommandExecutorOptions, 'dockerBin' | 'sshBin' | 'sshControlDir' | 'sshAuth' | 'dockerHost'>): [string, string[]] {
  if (machine.docker) return [o.dockerBin ?? 'docker', dockerArgv(o.dockerHost(), ['exec', '--', machine.docker, ...argv])];
  // A client target serves herdr calls only (design.md "Client targets"); without this the command would run here.
  if (machine.client) throw new Error('the command executor does not run on a client target: it serves herdr only');
  if (machine.ssh) {
    const t = { target: machine.ssh, auth: o.sshAuth, ...(o.sshBin ? { bin: o.sshBin } : {}), ...(o.sshControlDir ? { controlDir: o.sshControlDir } : {}) };
    return [o.sshBin ?? 'ssh', sshArgv(t, argv.map(shellQuote).join(' '))];
  }
  return [argv[0]!, argv.slice(1)];
}

export interface Ran { exitCode: number; stdout: string; stderr: string }

/** Runs a program to its end: what it printed and its exit code, or how it was stopped. `userEnv` over the daemon's environment. */
export function run(file: string, args: string[], timeoutMs: number, signal: AbortSignal, userEnv: Readonly<Record<string, string>> = {}): Promise<Ran | 'aborted' | 'timeout'> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      env: dockerEnv(userProcessEnv(userEnv)), timeout: timeoutMs, killSignal: 'SIGKILL', signal, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ exitCode: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (signal.aborted) return resolve('aborted');
      if (e.killed) return resolve('timeout');
      if (typeof e.code === 'number') return resolve({ exitCode: e.code, stdout, stderr });
      reject(new Error(`${file}: ${e.message}`));
    });
  });
}

export function createCommandExecutor(o: CommandExecutorOptions): Executor {
  if (o.sshControlDir) mkdirSync(o.sshControlDir, { recursive: true, mode: 0o700 });
  return {
    name: o.name,
    idempotent: false,
    validate(payload) {
      return typeof payload.body === 'string' && payload.body.trim() !== '' ? null : 'body must be a non-empty string: the command to run';
    },
    async run(ctx: ExecutionContext): Promise<ExecutionOutcome> {
      const { body, env } = ctx.job.spec.payload as { body: string; env?: Record<string, string> };
      const vars = Object.entries({ ...env, HOPPER_JOB_ID: ctx.job.id }).map(([k, v]) => `${k}=${v}`);
      const where = ctx.machine.id;
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
