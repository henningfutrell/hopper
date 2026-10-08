// HerdrClient over the herdr CLI. Every call is `<bin> --session <session> …` with no shell,
// JSON on stdout, server errors as JSON on stderr with exit 1, usage errors with exit 2.
// Never the default session: the session is required. On an attached machine (`ssh`) the same
// argv runs there through `ssh`, quoted for the remote shell, `herdr` found by name from its PATH
// (`REMOTE_PATH`, issue #311; design.md "Attached machines"), authenticated as `../ssh.ts` says
// (design.md "Target authentication").

import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { scrubbedEnv, userProcessEnv } from '../env.ts';
import { clientHerdr, type ClientTransport } from '../client.ts';
import { clientShell, localShell, sshShell } from '../machine-shell.ts';
import type { MachineShell } from '../../domain/ports.ts';
import { REMOTE_PATH, SSH_FAILED, shellQuote, sshArgv, type SshTransport } from '../ssh.ts';
import { HerdrError } from './client.ts';
import type { AgentInfo, AgentStatus, HerdrClient } from './client.ts';

const DEFAULT_TIMEOUT_MS = 15000;

function errorFrom(stderr: string, fallback: string): HerdrError {
  try {
    const { error } = JSON.parse(stderr) as { error?: { code?: string; message?: string } };
    if (error?.code) return new HerdrError(error.code, error.message ?? error.code);
  } catch { /* not JSON: fall through */ }
  return new HerdrError('unknown', stderr.trim() || fallback);
}

export interface HerdrCliClient extends HerdrClient {
  readonly session: string;
  /** Run one herdr command; resolves raw stdout. */
  exec(args: string[], timeoutMs?: number): Promise<string>;
  /** Run one herdr command; resolves its parsed JSON `result`. */
  run(args: string[], timeoutMs?: number): Promise<Record<string, unknown>>;
}

/** This machine's herdr: its binary and session are the hopper's to name. */
interface LocalOptions {
  bin: string; session: string; timeoutMs?: number; ssh?: never;
  /** Over the daemon's environment for this machine's herdr: the user's CLI config dirs (issue #158). */
  userEnv?: Readonly<Record<string, string>>;
}
/** An ssh target's herdr: `herdr` as its PATH finds it (issue #311), in the session the hopper names. */
interface SshOptions { session: string; timeoutMs?: number; ssh: SshTransport }
type CliOptions = LocalOptions | SshOptions;
/** A client target's herdr: its binary and session are the client's own (design.md "Client targets"). */
interface ClientOptions { client: ClientTransport; timeoutMs?: number }

/** herdr's exit status as the CLI gives it: usage errors exit 2, server errors carry JSON on stderr. */
function failure(code: number, stderr: string, fallback: string): HerdrError {
  return code === 2 ? new HerdrError('usage', stderr.trim() || fallback) : errorFrom(stderr, fallback);
}

export function createHerdrCliClient(o: CliOptions | ClientOptions): HerdrCliClient {
  if ('client' in o) return withCalls('', viaClient(o.client), o.timeoutMs ?? DEFAULT_TIMEOUT_MS, clientShell(o.client));
  if (!o.session) throw new Error('herdr session is required (never the default session)');
  return withCalls(o.session, viaCli(o), o.timeoutMs ?? DEFAULT_TIMEOUT_MS, o.ssh ? sshShell(o.ssh) : localShell(o.userEnv));
}

type Exec = (args: string[], timeoutMs: number) => Promise<string>;

function viaClient(t: ClientTransport): Exec {
  return async (args, timeoutMs) => {
    let r;
    try {
      r = await clientHerdr(t, args, timeoutMs);
    } catch (e) {
      throw new HerdrError('client', (e as Error).message);
    }
    if (r.code === 0) return r.stdout;
    if (r.code === 124) throw new HerdrError('timeout', `herdr ${args.slice(0, 2).join(' ')} timed out after ${timeoutMs} ms`);
    throw failure(r.code, r.stderr, `herdr exited ${r.code}`);
  };
}

function viaCli(o: CliOptions): Exec {
  const ssh = o.ssh;
  if (ssh?.controlDir) mkdirSync(ssh.controlDir, { recursive: true, mode: 0o700 });
  return (args, timeoutMs) => new Promise((resolve, reject) => {
    const argv = ['--session', o.session, ...args];
    let file: string, fileArgs: string[];
    try {
      [file, fileArgs] = ssh ? [ssh.bin ?? 'ssh', sshArgv(ssh, `${REMOTE_PATH} exec ${['herdr', ...argv].map(shellQuote).join(' ')}`)] : [o.bin, argv];
    } catch (e) {
      // Not authenticated as the hopper must be (no key, unpinned, a jump host): never connected.
      return reject(new HerdrError('ssh', `ssh ${ssh!.target}: ${(e as Error).message}`));
    }
    execFile(file, fileArgs, {
      env: scrubbedEnv(ssh ? process.env : userProcessEnv(o.userEnv)), timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (e.killed) return reject(new HerdrError('timeout', `herdr ${args.slice(0, 2).join(' ')} timed out after ${timeoutMs} ms`));
      if (typeof e.code === 'string') return reject(new HerdrError('spawn', `${file}: ${e.message}`));
      if (ssh && e.code === SSH_FAILED) return reject(new HerdrError('ssh', `ssh ${ssh.target}: ${stderr.trim() || e.message}`));
      reject(failure(e.code ?? 1, stderr, e.message));
    });
  });
}

function withCalls(session: string, call: Exec, callTimeout: number, shell: MachineShell): HerdrCliClient {
  const exec = (args: string[], timeoutMs = callTimeout): Promise<string> => call(args, timeoutMs);

  const run = async (args: string[], timeoutMs?: number): Promise<Record<string, unknown>> => {
    const out = await exec(args, timeoutMs);
    try {
      return ((JSON.parse(out) as { result?: Record<string, unknown> }).result ?? {});
    } catch {
      throw new HerdrError('bad_output', `herdr ${args.slice(0, 2).join(' ')}: not JSON: ${out.slice(0, 200)}`);
    }
  };

  return {
    session,
    exec,
    run,
    async ensureWorkspace(label, cwd) {
      const list = await run(['workspace', 'list']);
      const found = (list.workspaces as { workspace_id: string; label?: string }[] | undefined)?.find((w) => w.label === label);
      if (found) return found.workspace_id;
      const created = await run(['workspace', 'create', '--label', label, '--cwd', cwd, '--no-focus']);
      return (created.workspace as { workspace_id: string }).workspace_id;
    },
    async createTab({ workspaceId, cwd, label, env }) {
      const envArgs = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
      const r = await run(['tab', 'create', '--workspace', workspaceId, '--cwd', cwd, '--label', label, ...envArgs, '--no-focus']);
      return { tabId: (r.tab as { tab_id: string }).tab_id, paneId: (r.root_pane as { pane_id: string }).pane_id };
    },
    async startAgent({ name, paneId, args, timeoutMs }) {
      try {
        await run(['agent', 'start', name, '--kind', 'claude', '--pane', paneId, '--timeout', String(timeoutMs), '--', ...args], timeoutMs + callTimeout);
        return { ok: true };
      } catch (err) {
        if (err instanceof HerdrError && err.code === 'agent_not_ready') return { ok: false, notReady: true };
        if (err instanceof HerdrError && err.code === 'agent_pane_busy') return { ok: false, paneBusy: true };
        throw err;
      }
    },
    async getAgent(name): Promise<AgentInfo | null> {
      try {
        const r = await run(['agent', 'get', name]);
        const a = r.agent as { agent_status: AgentStatus; state_change_seq: number; pane_id: string };
        return { status: a.agent_status, stateChangeSeq: a.state_change_seq, paneId: a.pane_id };
      } catch (err) {
        if (err instanceof HerdrError && err.code === 'agent_not_found') return null;
        throw err;
      }
    },
    read: (paneId, { source, lines }) => exec(['pane', 'read', paneId, '--source', source, '--lines', String(lines)]),
    async prompt(name, text) { await run(['agent', 'prompt', name, text]); },
    async sendKeys(paneId, keys) { await exec(['pane', 'send-keys', paneId, ...keys]); },
    async sendText(paneId, text) { await exec(['pane', 'send-text', paneId, text]); },
    async runInPane(paneId, command) { await exec(['pane', 'run', paneId, command]); },
    async waitOutput(paneId, text, timeoutMs) {
      try {
        await exec(['pane', 'wait-output', paneId, '--match', text, '--source', 'recent-unwrapped', '--timeout', String(timeoutMs)], timeoutMs + callTimeout);
        return true;
      } catch (err) {
        if (err instanceof HerdrError && err.code === 'timeout') return false;
        throw err;
      }
    },
    async closePane(paneId) { await run(['pane', 'close', paneId]); },
    reap: (jobId, scratch) => shell.reap(jobId, scratch),
    survey: (roots) => shell.survey(roots),
    keepCredential: (jobId, dir, file, content, make) => shell.keepCredential(jobId, dir, file, content, make),
  };
}
