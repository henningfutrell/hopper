// A draft run on the user's machine (issue #474, design.md "Drafting on the user's AI CLI"): one locked-down turn of
// the provider the user picked, on the machine the user picked, signed in there under that machine's account. This
// machine and an ssh target run it in a fresh private dir there (`ON_MACHINE`), removed after; a client target runs
// claude through its signed `POST /level` (issue #482), which builds the same argv, and no other CLI. The hopper never
// reads or copies a CLI's credentials: the CLI finds its own login, and a user added later runs claude with their own
// config dir here (src/users/env.ts). A timeout or a cancel stops the run, there too (issue #472: reaped through the same
// connection); a run dir that stays fails the run; a device code it prints goes to the logins.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { clientLevel, type ClientTransport } from '../executors/client.ts';
import { commandOn } from '../executors/command.ts';
import { userProcessEnv } from '../executors/env.ts';
import { hopperSshAuth, type SshAuth } from '../executors/ssh.ts';
import type { MachineSnapshot, RunLogins } from '../domain/types.ts';
import { hideCodes } from '../logins/recognise.ts';
import { watchRunOutput } from '../logins/run-output.ts';
import { CLAUDE_TIMEOUT_MS, leftOf, leftReason, ON_MACHINE, reapRun, runMarkOf, scrubbedEnv, withoutRunMarks } from '../plugins/claude-print.ts';
import { draftIssueWith, type DraftAnswer, type IssueDraftResult } from '../run-skills/draft.ts';
import type { DraftScope } from '../run-skills/constraints.ts';
import type { FileIssueInput } from '../run-skills/file-issue.ts';
import { answeredError, CLAUDE_DEFAULT_MODEL, draftArgv, draftRefusal, failureOf, readDraft, type DraftCall, type DraftProvider } from './providers.ts';

/** What a draft run needs of the user's runtime: their machines and clients, the ssh key, their CLI config dirs. */
export interface DraftHost {
  machine(id: string): Promise<MachineSnapshot | undefined>;
  client(id: string): ClientTransport | undefined;
  /** The hopper's data dir: the ssh control dir and the hopper's own ssh key are under it. */
  dataDir: string;
  env: (name: string) => string | undefined;
  /** The user's CLI config dirs over the daemon's environment (issue #158): empty for admin. */
  userEnv: Readonly<Record<string, string>>;
  sshBin?: string;
  /** How ssh signs in: default the hopper's own key (`hopperSshAuth`). */
  sshAuth?: () => SshAuth;
  logins?: RunLogins;
}

/** What the user picked: the provider, the machine, and the model and effort, else the CLI's own. `bin`: the CLI's name there. */
export interface DraftChoice { provider: DraftProvider; machine: string; model?: string; effort?: string; bin?: string; timeoutMs?: number }

/** `stderr` with an error: the run was stopped, and this is what it printed until then. */
type Turn = { code: number; stdout: string; stderr: string } | { error: string; stderr?: string };

/** One program to its end, `stdin` on its stdin: what it printed, or why it stopped. Never throws. */
function turn(file: string, args: string[], stdin: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal, feed: (chunk: string) => void): Promise<Turn> {
  return new Promise((resolve) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const stop = AbortSignal.any([signal, timeout]);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: Turn) => {
      if (settled) return;
      settled = true;
      stop.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const onAbort = () => {
      child.kill('SIGKILL');
      finish({ error: timeout.aborted ? `timed out after ${timeoutMs} ms` : 'cancelled', stderr });
    };
    if (stop.aborted) return onAbort();
    stop.addEventListener('abort', onAbort);
    child.on('error', (err) => finish({ error: `could not start: ${err.message}` }));
    child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c; feed(c); });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr += c; feed(c); });
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

/** One draft turn of `call` on machine `m`, read into the answer. */
async function runOn(host: DraftHost, m: MachineSnapshot, call: DraftCall, timeoutMs: number, signal: AbortSignal): Promise<DraftAnswer> {
  const on = m.ssh || m.client ? `machine ${m.id}` : 'this machine';
  const bin = call.bin ?? call.provider;
  const login = watchRunOutput(host.logins, { now: () => new Date() });
  let seen = '';
  const said = (r: DraftAnswer): DraftAnswer => {
    // A device code the run printed never leaves it in an error (issue #476).
    const out = 'error' in r ? { error: hideCodes(r.error, seen, login.codes()) } : r;
    login.end('error' in out ? { ok: false, reason: out.error } : { ok: true });
    return out;
  };
  let ran: Turn;
  if (m.client) {
    const t = host.client(m.id);
    if (!t) return said({ error: `machine ${m.id}: its client is not dialled in. Start the hopper client on it, or pick another machine.` });
    const level = { model: call.model ?? CLAUDE_DEFAULT_MODEL, ...(call.effort ? { effort: call.effort } : {}), jsonSchema: call.jsonSchema, prompt: call.prompt };
    ran = await new Promise<Turn>((resolve) => {
      const onAbort = () => resolve({ error: 'cancelled' });
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      clientLevel(t, level, timeoutMs).then(
        (r) => resolve(r.code === 124 ? { error: `timed out after ${timeoutMs} ms` } : r),
        (e: unknown) => resolve({ error: e instanceof Error ? e.message : String(e) }),
      ).finally(() => signal.removeEventListener('abort', onAbort));
    });
  } else {
    const { argv, stdin } = draftArgv(call);
    let there: (argv: string[]) => [string, string[]];
    let file: string;
    let args: string[];
    try {
      if (m.ssh) {
        const sshControlDir = join(host.dataDir, 'ssh');
        mkdirSync(sshControlDir, { recursive: true, mode: 0o700 });
        const opts = {
          ...(host.sshBin ? { sshBin: host.sshBin } : {}), sshControlDir, sshAuth: host.sshAuth ?? (() => hopperSshAuth({ env: host.env, dataDir: host.dataDir })),
          dockerHost: () => { throw new Error('no docker'); },
        };
        there = (a) => commandOn(m, a, opts);
      } else {
        there = (a) => [a[0]!, a.slice(1)];
      }
      [file, args] = there(['sh', '-c', ON_MACHINE, 'sh', ...argv]);
    } catch (e) {
      return said({ error: `${on}: ${e instanceof Error ? e.message : String(e)}` });
    }
    // The user's config dirs only here: an ssh target's CLI runs with that machine's own environment.
    const env = scrubbedEnv(userProcessEnv(m.ssh ? {} : host.userEnv));
    ran = await turn(file, args, stdin, env, timeoutMs, signal, (c) => { seen += c; login.feed(c); });
    // Stopped: the kill reached the process here, not the run on the machine (issue #472).
    const mark = 'error' in ran && ran.stderr !== undefined ? runMarkOf(ran.stderr) : undefined;
    if ('error' in ran && mark) {
      const left = await reapRun(there, mark, env, process.cwd());
      if (left.length) ran = { error: `${ran.error}; ${leftReason(left)}` };
    }
  }
  if ('error' in ran) return said({ error: `${call.provider} on ${on}: ${ran.error}` });
  seen = `${ran.stdout}\n${ran.stderr}`;
  const left = leftOf(ran.stderr);
  const failed = ran.code !== 0 ? failureOf(call.provider, on, bin, ran.code, `${withoutRunMarks(ran.stderr)}\n${ran.stdout}`) : undefined;
  if (left.length) return said({ error: `${failed ? `${failed}; ` : `${call.provider} on ${on}: `}${leftReason(left)}` });
  if (failed) return said({ error: failed });
  const read = readDraft(call.provider, ran.stdout);
  if ('error' in read) return said({ error: answeredError(call.provider, on, read.error) });
  if ('unreadable' in read) return said({ error: `${call.provider} on ${on} gave no draft: ${read.unreadable}` });
  return said(read);
}

/**
 * Draft an issue with the user's own AI CLI on the machine they picked: refused, in plain words, where it cannot run;
 * else the file-issue run skill's draft, masked and checked against `scope`, with its findings, or why there is none.
 */
export async function draftOn(host: DraftHost, choice: DraftChoice, input: FileIssueInput, scope: DraftScope, signal: AbortSignal): Promise<IssueDraftResult | { error: string }> {
  const m = await host.machine(choice.machine);
  const refused = draftRefusal(choice.provider, choice.machine, m, { addedUser: Object.keys(host.userEnv).length > 0 });
  if (refused) return { error: refused };
  const timeoutMs = choice.timeoutMs ?? CLAUDE_TIMEOUT_MS;
  return draftIssueWith((prompt, jsonSchema, s) => runOn(host, m!, {
    provider: choice.provider, prompt, jsonSchema,
    ...(choice.bin ? { bin: choice.bin } : {}), ...(choice.model ? { model: choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}),
  }, timeoutMs, s), input, scope, signal);
}
