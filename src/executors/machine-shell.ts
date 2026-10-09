// A job's machine, reached for the reap and the sweep (issue #410, design.md "Work tree" → "The reap"):
// the fixed scripts of src/client/server.ts run there through the machine's own connection — this
// machine, ssh, or a client target's `/reap` and `/survey` — never typed into a pane, where Claude may
// still be in front of the shell.
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { MachineShell } from '../domain/ports.ts';
import { CREDENTIAL_KEPT, credentialArgv } from '../client/credential.ts';
import { readReap, readSurvey, reapArgv, surveyArgv } from '../client/server.ts';
import { DISCOVER_TIMEOUT_MS, discoverArgv } from '../client/discover.ts';
import { readDiscovery } from '../blast-radius/read.ts';
import { clientScript, type ClientAnswer, type ClientTransport } from './client.ts';
import { scrubbedEnv, userProcessEnv } from './env.ts';
import { shellQuote, sshArgv, type SshTransport } from './ssh.ts';

/** A reap waits up to 10 s per scope stop and 3 s for processes; a survey reads /proc once. */
const TIMEOUT_MS = 60000;

type Call = { reap: { jobId: string; scratch?: string } } | { survey: { roots: string[] } }
  | { credential: { jobId: string; dir: string; file: string; content: string; make: boolean } } | { discover: true };

function shellOver(where: string, run: (call: Call) => Promise<ClientAnswer>): MachineShell {
  const unfinished = (what: string, r: ClientAnswer): Error =>
    new Error(`the ${what} on ${where} did not finish (exit ${r.code}): ${(r.stderr.trim() || r.stdout.trim()).slice(-500)}`);
  return {
    async reap(jobId, scratch) {
      const r = await run({ reap: { jobId, ...(scratch ? { scratch } : {}) } });
      const said = readReap(r.stdout);
      if (!said) throw unfinished('reap', r);
      return said;
    },
    async survey(roots) {
      const r = await run({ survey: { roots } });
      const found = readSurvey(r.stdout);
      if (!found) throw unfinished('survey', r);
      return found;
    },
    async discover() {
      const r = await run({ discover: true });
      const found = readDiscovery(r.stdout);
      if (!found) throw unfinished('discovery', r);
      return found;
    },
    async keepCredential(jobId, dir, file, content, make = false) {
      const r = await run({ credential: { jobId, dir, file, content, make } });
      if (!r.stdout.split('\n').some((l) => l.trimEnd() === CREDENTIAL_KEPT)) throw unfinished('credential write', r);
    },
  };
}

const argvOf = (call: Call): string[] => ('reap' in call ? reapArgv(call.reap.jobId, call.reap.scratch)
  : 'survey' in call ? surveyArgv(call.survey.roots) : 'discover' in call ? discoverArgv()
    : credentialArgv(call.credential.jobId, call.credential.dir, call.credential.file, call.credential.make));
/** A discovery asks each tool with a timeout of its own, so it may take longer than the other scripts. */
const timeoutOf = (call: Call): number => ('discover' in call ? DISCOVER_TIMEOUT_MS : TIMEOUT_MS);
/** What the call's script reads on stdin: a credential's content, never an argument. */
const inputOf = (call: Call): string => ('credential' in call ? call.credential.content : '');

function runFile(file: string, args: string[], env: NodeJS.ProcessEnv, input: string, timeoutMs = TIMEOUT_MS): Promise<ClientAnswer> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (e.killed) return reject(new Error(`${file}: no answer within ${timeoutMs} ms`));
      if (typeof e.code === 'string') return reject(new Error(`${file}: ${e.message}`));
      resolve({ code: e.code ?? 1, stdout, stderr });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}

/** This machine: the scripts run as the user's processes do (issue #158). */
export const localShell = (userEnv?: Readonly<Record<string, string>>): MachineShell =>
  shellOver('this machine', (call) => {
    const [file, ...args] = argvOf(call);
    return runFile(file!, args, userProcessEnv(userEnv), inputOf(call), timeoutOf(call));
  });

/** An ssh target: the scripts run in its shell over the hopper's own connection (design.md "Target authentication"). */
export function sshShell(ssh: SshTransport): MachineShell {
  return shellOver(ssh.target, (call) => {
    if (ssh.controlDir) mkdirSync(ssh.controlDir, { recursive: true, mode: 0o700 });
    return runFile(ssh.bin ?? 'ssh', sshArgv(ssh, argvOf(call).map(shellQuote).join(' ')), scrubbedEnv(), inputOf(call), timeoutOf(call));
  });
}

/** A client target: its client runs its own copy of the scripts, signed calls like every other (design.md "Client targets"). */
export const clientShell = (t: ClientTransport): MachineShell =>
  shellOver(`client ${t.machine}`, (call) => ('reap' in call ? clientScript(t, '/reap', call.reap)
    : 'survey' in call ? clientScript(t, '/survey', call.survey) : 'discover' in call ? clientScript(t, '/discover', {})
      : clientScript(t, '/credential', call.credential)));
