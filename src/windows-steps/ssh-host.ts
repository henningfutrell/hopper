// The Windows host a step runs on, over ssh and scp (issue #731, design.md "Windows sandbox steps"). The hopper reaches
// it as it reaches an ssh target ("Target authentication"): its own key, public-key authentication only, the pinned
// host key only — here one known_hosts file per Windows host, written before each step —, nothing forwarded. Four
// calls per step: prepare the scratch directory, copy the inputs and the step's script, run it (its output streamed;
// its vault secrets, when it has any, on that call's stdin only), bring the outputs back; then the scratch directory is
// removed.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WindowsStepHost } from '../domain/ports.ts';
import type { StepResult, WindowsHost } from '../domain/windows-steps.ts';
import { scrubbedEnv } from '../executors/env.ts';
import { scpArgv, sshArgv, SSH_FAILED, type SshAuth, type SshTransport } from '../executors/ssh.ts';
import { cleanupScript, encodedCommand, prepareScript, runScript, scpScratch, secretsInput, stepFile } from './powershell.ts';

export interface SshStepHostOptions {
  /** How the hopper proves itself (the same key as to its ssh targets); its known_hosts is replaced by the host's own pin. */
  auth: () => SshAuth;
  /** Where the per-host known_hosts files and the shared connections' sockets live. */
  sshDir: string;
  sshBin?: string;
  scpBin?: string;
}

/** How long the calls around the step may take: the copy of large inputs included. */
const SIDE_CALL_MS = 10 * 60 * 1000;

interface Ran { code: number; stderr: string; aborted: boolean }

/** Runs `bin`; `stdin`, when given, is written to it, then closed — the only way a secret reaches the host. */
function run(bin: string, argv: string[], o: { signal: AbortSignal; timeoutMs?: number; out?: (chunk: string) => void; stdin?: string }): Promise<Ran> {
  return new Promise((resolve) => {
    let stderr = '';
    let aborted = false;
    const child = spawn(bin, argv, { env: scrubbedEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => { /* the far end closed early: its exit says why */ });
    child.stdin.end(o.stdin ?? '');
    const stop = () => { aborted = true; child.kill('SIGTERM'); };
    const timer = o.timeoutMs ? setTimeout(stop, o.timeoutMs) : undefined;
    if (o.signal.aborted) stop(); else o.signal.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8').on('data', (c: string) => o.out?.(c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => { if (o.out) o.out(c); else if (stderr.length < 4000) stderr += c; });
    const done = (code: number) => {
      if (timer) clearTimeout(timer);
      o.signal.removeEventListener('abort', stop);
      resolve({ code, stderr: stderr.trim(), aborted });
    };
    child.on('error', (e) => { stderr += e.message; done(SSH_FAILED); });
    child.on('close', (code) => done(code ?? SSH_FAILED));
  });
}

export function createSshStepHost(o: SshStepHostOptions): WindowsStepHost {
  const ssh = o.sshBin ?? 'ssh';
  const scp = o.scpBin ?? 'scp';
  const transport = (host: WindowsHost): SshTransport => {
    const dir = join(o.sshDir, 'windows');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const knownHostsFile = join(dir, `${host.name}.known_hosts`);
    writeFileSync(knownHostsFile, `${host.ssh} ${host.hostKey}\n`, { mode: 0o600 });
    return { target: host.ssh, bin: ssh, controlDir: o.sshDir, auth: () => ({ ...o.auth(), knownHostsFile }) };
  };

  return {
    async run(host, step, io) {
      let t: SshTransport;
      try { t = transport(host); } catch (e) { return { exit: SSH_FAILED, problem: (e as Error).message }; }
      const remote = (script: string, opts: { out?: (c: string) => void; timeoutMs?: number; signal?: AbortSignal; stdin?: string } = {}) =>
        run(ssh, sshArgv(t, encodedCommand(script)), { signal: opts.signal ?? io.signal, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.out ? { out: opts.out } : {}), ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) });
      const failed = (what: string, r: Ran): StepResult => ({ exit: SSH_FAILED, problem: r.aborted ? `${what}: stopped` : `${what}: ${r.stderr || `exit ${r.code}`}` });
      try {
        const prepared = await remote(prepareScript(host.workDir), { timeoutMs: SIDE_CALL_MS });
        if (prepared.code !== 0) return failed(`the host ${host.name} could not be prepared`, prepared);
        // Windows PowerShell 5.1 reads a script with no byte order mark as the system's code page: the mark keeps it UTF-8.
        writeFileSync(join(step.dir, 'step.ps1'), `\ufeff${stepFile(step.command)}`);
        const sent = await run(scp, scpArgv(t, { to: true, from: [...(step.inputs ? [join(step.dir, 'inputs.tar')] : []), join(step.dir, 'step.ps1')], remote: `${scpScratch(host.workDir)}/` }), { signal: io.signal, timeoutMs: SIDE_CALL_MS });
        if (sent.code !== 0) return failed('the inputs could not be copied to the host', sent);
        const secrets = step.secrets && Object.keys(step.secrets).length > 0 ? step.secrets : undefined;
        const ran = await remote(runScript({ workDir: host.workDir, inputs: step.inputs, outputs: step.outputs, secrets: secrets !== undefined }), { out: io.log, ...(secrets ? { stdin: secretsInput(secrets) } : {}) });
        if (ran.aborted) return { exit: ran.code, problem: 'stopped before it ended' };
        const result: StepResult = { exit: ran.code };
        if (ran.code === SSH_FAILED) result.problem = `ssh ended with ${SSH_FAILED}: the connection to ${host.name} failed, or the command exited ${SSH_FAILED}`;
        if (step.outputs.length > 0) {
          const local = join(step.dir, 'outputs.tar');
          const back = await run(scp, scpArgv(t, { to: false, remote: `${scpScratch(host.workDir)}/outputs.tar`, local }), { signal: io.signal, timeoutMs: SIDE_CALL_MS });
          if (back.code === 0 && existsSync(local)) result.outputsBytes = statSync(local).size;
          else result.problem = result.problem ?? `no outputs came back: ${back.stderr || `scp exit ${back.code}`}`;
        }
        return result;
      } catch (e) {
        return { exit: SSH_FAILED, problem: (e as Error).message };
      } finally {
        // The scratch directory goes even when the step was stopped: a call of its own, with its own short deadline.
        try { await remote(cleanupScript(host.workDir), { signal: new AbortController().signal, timeoutMs: 60_000 }); } catch { /* the next step's prepare removes it */ }
      }
    },
  };
}
