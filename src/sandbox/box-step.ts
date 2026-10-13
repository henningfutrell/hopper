// One box step (issue #1004, design.md "Box steps"): a job's command run in a sandbox box beside the hopper, through
// the container runtime's exec — never typed into a pane —, its output streamed back, then its exit code and outputs.
// The job stays where it runs; only the step goes to the box. In order, each an exec or a copy:
//   1. the box makes the step's scratch dir, `$HOME/.hopper-step/<id>` (700), and the work dir `$HOME/work`; both on
//      the box's home volume, the only place the box may write;
//   2. the step's command (`step.sh`) and the job's proxy token (`token`) are copied into the scratch dir, and the
//      inputs, when there are any, into the work dir, all owned by the box's user;
//   3. the command runs in the work dir under sh, with HOPPER_TOKEN_FILE naming the token and HOPPER_SECRET the box's
//      vault helper: the vault gives the box's helper what it gives the job's ask, only while the step runs (box.ts);
//   4. the outputs come back as a tar on the stdout of `tar -cf -`, an output not there said in the log;
//   5. the scratch dir goes, whatever came before: the token with it.
// A stop (the timeout, or the job gone) kills the command's process tree in the box: TERM, then KILL.
import { closeSync, existsSync, openSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ContainerRuntime } from '../domain/sandboxes.ts';
import type { StepResult } from '../domain/windows-steps.ts';
import { filesTar } from './socket-http.ts';

/** The exit code of a step the hopper could not run, or bring back: as ssh's, for a Windows step. */
const FAILED = 255;
/** How long each call around the step may take. */
const SIDE_MS = 10 * 60_000;
/** How long the stop and the cleanup may take. */
const AFTER_MS = 60_000;

/** `$1`: the step's id. Prints the scratch dir and the work dir, one a line. */
const PREPARE = 'set -e; h="${HOME:-/tmp}"; s="$h/.hopper-step/$1"; rm -rf "$s"; mkdir -p "$s" "$h/work"; chmod 700 "$h/.hopper-step" "$s"; printf "%s\\n%s\\n" "$s" "$h/work"';
/** `$1`: the scratch dir; `$2`: the work dir. The shell keeps its pid through `exec`, so the stop finds the command. */
const RUN = 'echo $$ > "$1/pid"; cd "$2" || exit 125; exec sh "$1/step.sh"';
/**
 * `$1`: the scratch dir. The command's whole process tree, read from /proc before the first signal (a child the TERM
 * orphans is still in the list for the KILL), then TERM, then KILL.
 */
const STOP = 't() { echo "$1"; for c in $(cat /proc/"$1"/task/*/children 2>/dev/null); do t "$c"; done; }; '
  + 'p=$(cat "$1/pid" 2>/dev/null) || exit 0; all=$(t "$p"); kill -TERM $all 2>/dev/null; sleep 2; kill -KILL $all 2>/dev/null; exit 0';

/** A step as the box runs it. `dir`: its own directory on this machine, `inputs.tar` in it when `inputs`. */
export interface BoxStepCall {
  id: string;
  command: string;
  dir: string;
  inputs: boolean;
  outputs: string[];
  /** The job's proxy token: in a file of the scratch dir for the step's helper, never in an argument or the environment. */
  token: string;
  /** The box's vault helper, as its client named it; absent: the box has none (not joined yet). */
  helper?: string;
}

const absolute = (p: string | undefined): p is string => typeof p === 'string' && p.startsWith('/') && !p.includes('\0');
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Runs the step in the box `container`; resolves with its exit code. Never rejects: a failure of its own is `problem`. */
export async function runBoxStep(rt: ContainerRuntime, container: string, step: BoxStepCall, io: { log(chunk: string): void; signal: AbortSignal }): Promise<StepResult> {
  if (!rt.exec || !rt.copyIn) return { exit: FAILED, problem: `the ${rt.kind} runtime runs no command in a box: a box step runs only in a box beside the hopper` };
  const exec = rt.exec.bind(rt), copyIn = rt.copyIn.bind(rt);
  /** A short command's output, whole. */
  const quiet = async (cmd: string[], signal: AbortSignal): Promise<{ code: number; out: string; err: string }> => {
    let out = '', err = '';
    const code = await exec(container, { cmd, out: (c, s) => { if (s === 1) out += c.toString('utf8'); else err += c.toString('utf8'); }, signal });
    return { code, out, err };
  };
  const side = (): AbortSignal => AbortSignal.any([io.signal, AbortSignal.timeout(SIDE_MS)]);
  const own = join(step.dir, 'step.tar');
  let at: { scratch: string; work: string } | undefined;
  try {
    const p = await quiet(['sh', '-c', PREPARE, 'sh', step.id], side());
    const [scratch, work] = p.out.split('\n');
    if (p.code !== 0 || !absolute(scratch) || !absolute(work)) return { exit: FAILED, problem: `the box could not be prepared: ${p.err.trim() || `exit ${p.code}`}` };
    at = { scratch, work };
    writeFileSync(own, filesTar([{ name: 'step.sh', data: step.command, mode: 0o600 }, { name: 'token', data: `${step.token}\n`, mode: 0o600 }]), { mode: 0o600 });
    await copyIn(container, scratch, own);
    rmSync(own, { force: true });
    if (step.inputs) await copyIn(container, work, join(step.dir, 'inputs.tar'));

    const text = { 1: new StringDecoder('utf8'), 2: new StringDecoder('utf8') };
    let exit: number;
    try {
      exit = await exec(container, {
        cmd: ['sh', '-c', RUN, 'sh', scratch, work], env: { HOPPER_TOKEN_FILE: `${scratch}/token`, ...(step.helper ? { HOPPER_SECRET: step.helper } : {}) },
        out: (c, s) => { const t = text[s].write(c); if (t) io.log(t); }, signal: io.signal,
      });
    } catch (e) {
      if (!io.signal.aborted) throw e;
      await quiet(['sh', '-c', STOP, 'sh', scratch], AbortSignal.timeout(AFTER_MS)).catch(() => undefined);
      return { exit: FAILED, problem: 'stopped before it ended' };
    }
    for (const d of [text[1], text[2]]) { const t = d.end(); if (t) io.log(t); }
    const result: StepResult = { exit };
    if (step.outputs.length > 0) {
      const file = join(step.dir, 'outputs.tar');
      const fd = openSync(file, 'w', 0o600);
      let tarExit: number;
      try {
        tarExit = await exec(container, { cmd: ['tar', '-cf', '-', '-C', work, '--', ...step.outputs], out: (c, s) => { if (s === 1) writeSync(fd, c); else io.log(c.toString('utf8')); }, signal: side() });
      } finally {
        closeSync(fd);
      }
      const size = existsSync(file) ? statSync(file).size : 0;
      if (size > 0) result.outputsBytes = size;
      else result.problem = `no outputs came back: tar exit ${tarExit}`;
    }
    return result;
  } catch (e) {
    return { exit: FAILED, problem: io.signal.aborted ? 'stopped before it ended' : reason(e) };
  } finally {
    rmSync(own, { force: true });
    // The scratch dir goes even when the step was stopped, and the script a job sent with its inputs (--script).
    if (at) await quiet(['rm', '-rf', '--', at.scratch, `${at.work}/.hopper-step`], AbortSignal.timeout(AFTER_MS)).catch(() => undefined);
  }
}
