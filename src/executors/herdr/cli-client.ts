// HerdrClient over the herdr CLI. Every call is `<bin> --session <session> …` with no shell,
// JSON on stdout, server errors as JSON on stderr with exit 1, usage errors with exit 2.
// Never the default session: the session is required.

import { execFile } from 'node:child_process';
import { HerdrError } from './client.ts';
import type { AgentInfo, AgentStatus, HerdrClient } from './client.ts';

const DEFAULT_TIMEOUT_MS = 15000;

/** process.env without CLAUDECODE and CLAUDE_CODE_*: a child-session marker must not leak into panes. */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')));
}

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

export function createHerdrCliClient(o: { bin: string; session: string; timeoutMs?: number }): HerdrCliClient {
  if (!o.session) throw new Error('herdr session is required (never the default session)');
  const callTimeout = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const exec = (args: string[], timeoutMs = callTimeout): Promise<string> => new Promise((resolve, reject) => {
    execFile(o.bin, ['--session', o.session, ...args], {
      env: scrubbedEnv(), timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (e.killed) return reject(new HerdrError('timeout', `herdr ${args.slice(0, 2).join(' ')} timed out after ${timeoutMs} ms`));
      if (typeof e.code === 'string') return reject(new HerdrError('spawn', `${o.bin}: ${e.message}`));
      if (e.code === 2) return reject(new HerdrError('usage', stderr.trim() || e.message));
      reject(errorFrom(stderr, e.message));
    });
  });

  const run = async (args: string[], timeoutMs?: number): Promise<Record<string, unknown>> => {
    const out = await exec(args, timeoutMs);
    try {
      return ((JSON.parse(out) as { result?: Record<string, unknown> }).result ?? {});
    } catch {
      throw new HerdrError('bad_output', `herdr ${args.slice(0, 2).join(' ')}: not JSON: ${out.slice(0, 200)}`);
    }
  };

  return {
    session: o.session,
    exec,
    run,
    async ensureWorkspace(label, cwd) {
      const list = await run(['workspace', 'list']);
      const found = (list.workspaces as { workspace_id: string; label?: string }[] | undefined)?.find((w) => w.label === label);
      if (found) return found.workspace_id;
      const created = await run(['workspace', 'create', '--label', label, '--cwd', cwd, '--no-focus']);
      return (created.workspace as { workspace_id: string }).workspace_id;
    },
    async createTab({ workspaceId, cwd, label }) {
      const r = await run(['tab', 'create', '--workspace', workspaceId, '--cwd', cwd, '--label', label, '--no-focus']);
      return { tabId: (r.tab as { tab_id: string }).tab_id, paneId: (r.root_pane as { pane_id: string }).pane_id };
    },
    async startAgent({ name, paneId, args, timeoutMs }) {
      try {
        await run(['agent', 'start', name, '--kind', 'claude', '--pane', paneId, '--timeout', String(timeoutMs), '--', ...args], timeoutMs + callTimeout);
        return { ok: true };
      } catch (err) {
        if (err instanceof HerdrError && err.code === 'agent_not_ready') return { ok: false, notReady: true };
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
    async closePane(paneId) { await run(['pane', 'close', paneId]); },
  };
}
