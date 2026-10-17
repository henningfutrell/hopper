// A draft probe (issue #474, design.md "Drafting on the user's AI CLI"): before a draft, whether the provider the user
// picked can draft on the machine they picked, and the models it lists there, so a picker offers only what can run.
// Refused machines first (`draftRefusal`); then, on this machine or an ssh target, the CLI's own status call and its
// model list, each in a fresh dir through `ON_MACHINE`, never a model call. Of claude's status only `loggedIn` is read.
// A client target has no probe call (its client runs claude for a level or a usage read only): claude there is usable
// while the client is dialled in, unchecked, and the draft says the rest.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { OptionChoice } from '../domain/plugins.ts';
import { commandOn } from '../executors/command.ts';
import { userProcessEnv } from '../executors/env.ts';
import { hopperSshAuth } from '../executors/ssh.ts';
import { leftOf, leftReason, ON_MACHINE, reapRun, runMarkOf, scrubbedEnv, withoutRunMarks } from '../plugins/claude-print.ts';
import { draftRefusal, failureOf, modelsCall, modelsOf, notSignedInReason, signedOut, statusCall, type DraftProvider, type ProbeCall } from './providers.ts';
import type { DraftHost } from './run.ts';

/** What a probe found: the provider can draft there, with the models it lists (empty: its own default), or why not. */
export type DraftProbe = { usable: true; models: OptionChoice[]; unchecked?: string } | { usable: false; reason: string };

/** What to probe: the provider and the machine the user picked; `bin`, the CLI's name there. */
export interface ProbeChoice { provider: DraftProvider; machine: string; bin?: string; timeoutMs?: number }

/** Default time each probe call may take. */
export const PROBE_TIMEOUT_MS = 20_000;

type Ran = { code: number; stdout: string; stderr: string } | { error: string; stderr?: string };

/** One program to its end, `stdin` on its stdin. Never throws. */
function ran(file: string, args: string[], stdin: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal): Promise<Ran> {
  return new Promise((resolve) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const stop = AbortSignal.any([signal, timeout]);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: Ran) => {
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
    child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

/** Whether `choice.provider` can draft on `choice.machine` now, and the models it lists there. Never throws. */
export async function probeOn(host: DraftHost, choice: ProbeChoice, signal: AbortSignal): Promise<DraftProbe> {
  const { provider } = choice;
  const m = await host.machine(choice.machine);
  const refused = draftRefusal(provider, choice.machine, m, { addedUser: Object.keys(host.userEnv).length > 0 });
  if (refused) return { usable: false, reason: refused };
  if (m!.client) {
    if (!host.client(m!.id)) return { usable: false, reason: `machine ${m!.id}: its client is not dialled in. Start the hopper client on it, or pick another machine.` };
    return { usable: true, models: [], unchecked: `machine ${m!.id} is a joined machine, and its client has no probe call: the draft itself says whether claude is signed in there.` };
  }
  const on = m!.ssh ? `machine ${m!.id}` : 'this machine';
  const bin = choice.bin ?? provider;
  const timeoutMs = choice.timeoutMs ?? PROBE_TIMEOUT_MS;
  const env = scrubbedEnv(userProcessEnv(m!.ssh ? {} : host.userEnv));
  const wrap = (argv: string[]): [string, string[]] => {
    if (!m!.ssh) return [argv[0]!, argv.slice(1)];
    const sshControlDir = join(host.dataDir, 'ssh');
    mkdirSync(sshControlDir, { recursive: true, mode: 0o700 });
    return commandOn(m!, argv, {
      ...(host.sshBin ? { sshBin: host.sshBin } : {}), sshControlDir, sshAuth: host.sshAuth ?? (() => hopperSshAuth({ env: host.env, dataDir: host.dataDir })),
      dockerHost: () => { throw new Error('no docker'); },
    });
  };
  // A call stopped by its timeout or a cancel is reaped on the machine (issue #472), as a draft run is. The lines
  // `ON_MACHINE` says never reach a reason or a status read, and a call that left files there fails.
  const call = async (c: ProbeCall): Promise<Ran> => {
    try {
      const [file, args] = wrap(['sh', '-c', ON_MACHINE, 'sh', ...c.argv]);
      const r = await ran(file, args, c.stdin, env, timeoutMs, signal);
      if ('error' in r) {
        const mark = r.stderr !== undefined ? runMarkOf(r.stderr) : undefined;
        const left = mark ? await reapRun(wrap, mark, env, process.cwd()) : [];
        return { error: left.length ? `${r.error}; ${leftReason(left)}` : r.error };
      }
      const left = leftOf(r.stderr);
      if (left.length) return { error: leftReason(left) };
      return { ...r, stderr: withoutRunMarks(r.stderr) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };

  const status = statusCall(provider, bin);
  if (status) {
    const r = await call(status);
    if ('error' in r) return { usable: false, reason: `${provider} on ${on}: ${r.error}` };
    if (signedOut(provider, r.code, `${r.stdout}\n${r.stderr}`)) return { usable: false, reason: notSignedInReason(provider, on) };
    // claude's output names the account: never in a reason.
    if (r.code !== 0) return { usable: false, reason: failureOf(provider, on, bin, r.code, provider === 'claude' ? r.stderr : `${r.stderr}\n${r.stdout}`) };
  }
  const listed = await call(modelsCall(provider, bin));
  if ('error' in listed) return { usable: false, reason: `${provider} on ${on}: ${listed.error}` };
  if (listed.code !== 0) {
    const reason = failureOf(provider, on, bin, listed.code, `${listed.stderr}\n${listed.stdout}`);
    // A model list that fails while the CLI is there and signed in: the CLI's own default model still runs.
    return listed.code === 127 || /not (?:installed|signed in)/.test(reason) ? { usable: false, reason } : { usable: true, models: [] };
  }
  return { usable: true, models: modelsOf(provider, listed.stdout) };
}
