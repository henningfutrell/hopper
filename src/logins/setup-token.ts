// The hopper's own `claude setup-token` (issue #1287, design.md "The hopper's Claude sign-in for pods"): the sign-in a job pod
// and a lane pod start with, made by the hopper so a person only opens its URL and pastes the code back. The CLI prints nothing
// without a terminal, so it runs in a pseudo-terminal: util-linux `script`, wide, so the token is on one line. Each run has a
// home of its own, removed when it ends, and an environment of its own: nothing of the hopper's or of a sign-in before.
// The token it printed is answered once, to the caller, which keeps it in the vault; never in a reason or a log.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startSignIn, SIGN_IN_URL_MS } from '../client/sign-in.ts';
import { agentCredentialValueProblem, POD_AGENT_CREDENTIAL } from '../domain/agent-credential.ts';
import { maskClaudeTokens } from '../secrets/mask.ts';

/** The tool a setup-token sign-in names on its login. */
export const SETUP_TOKEN_TOOL = 'claude setup-token';
/** The pseudo-terminal's width: a token is about 110 characters. */
const COLUMNS = 500;
/** The most output read for the token. */
const OUTPUT_CAP = 64 * 1024;

/** How a setup-token run ended: the token it printed, or why not. */
export type SetupTokenEnd = { ok: true; token: string } | { ok: false; reason: string };

/** A `claude setup-token` that showed its URL and waits for the code. */
export interface SetupTokenRun {
  url: string;
  /** Write the code; resolves when the CLI ended. Once only. */
  paste(code: string): Promise<SetupTokenEnd>;
  /** Stop it, whatever it does. */
  cancel(): void;
}

// eslint-disable-next-line no-control-regex -- the colours a CLI prints are escape sequences
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
const TOKEN = /sk-ant-oat\d\d-[A-Za-z0-9_-]{8,}/g;

/** The setup token in what the CLI printed: its last one, undefined when it printed none. */
export function setupTokenIn(text: string): string | undefined {
  const found = text.replace(ANSI, '').match(TOKEN)?.at(-1);
  return found && !agentCredentialValueProblem('', found) ? found : undefined;
}

/** `s` quoted for sh. */
const quoted = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Start `file setup-token` in a pseudo-terminal, with a home of its own under `dir`. Resolves once it printed its URL; rejects
 * when it ends first, or prints none in `urlMs`. `env`: variables the run gets besides its own (tests).
 */
export async function startSetupToken(o: { file: string; dir: string; env?: Record<string, string>; urlMs?: number; lifeMs?: number; pasteMs?: number }): Promise<SetupTokenRun> {
  const home = mkdtempSync(join(o.dir, 'setup-token-'));
  let removed = false;
  const remove = (): void => {
    if (removed) return;
    removed = true;
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  let output = '';
  const env = { ...o.env, PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home, SHELL: '/bin/sh', TERM: 'xterm-256color', LANG: 'C.UTF-8' };
  const command = `stty cols ${COLUMNS} rows 50 2>/dev/null; exec ${quoted(o.file)} setup-token`;
  let run;
  try {
    run = await startSignIn('script', ['-qfec', command, '/dev/null'], {
      cwd: home, env, enter: '\r', urlMs: o.urlMs ?? SIGN_IN_URL_MS,
      ...(o.lifeMs !== undefined ? { lifeMs: o.lifeMs } : {}), ...(o.pasteMs !== undefined ? { pasteMs: o.pasteMs } : {}),
      onOutput: (text) => { output = (output + text).slice(-OUTPUT_CAP); },
    });
  } catch (e) {
    remove();
    throw new Error(maskClaudeTokens(e instanceof Error ? e.message : String(e)), { cause: e });
  }
  const { url } = run;
  const signIn = run;
  return {
    url,
    async paste(code) {
      const from = output.length;
      try {
        const end = await signIn.paste(code);
        if (!end.ok) return { ok: false, reason: maskClaudeTokens(end.reason) };
        const token = setupTokenIn(output.slice(from));
        return token ? { ok: true, token } : { ok: false, reason: 'claude setup-token ended with no token' };
      } finally {
        remove();
      }
    },
    cancel() {
      signIn.cancel();
      // The CLI is killed; its home goes once it is gone.
      setTimeout(remove, 100).unref();
    },
  };
}

/**
 * The hopper's Claude sign-in for pods as the sign-ins run it: `start` runs `file` (default `claude` on PATH) `setup-token`
 * under `dir`; `keep` sets the token as the user's vault secret CLAUDE_TOKEN through `set`, its scope naming the account, and
 * answers why it could not.
 */
export function setupTokenSignIn(o: { file?: string; env?: Record<string, string>; dir: string; set: (s: { name: string; value: string; scope: string }, by: string) => Promise<{ ok: true } | { ok: false; error: string }> }) {
  return {
    start: () => startSetupToken({ file: o.file ?? 'claude', dir: o.dir, ...(o.env ? { env: o.env } : {}) }),
    async keep(k: { token: string; account: string; by: string }): Promise<string | undefined> {
      const r = await o.set({ name: POD_AGENT_CREDENTIAL, value: k.token, scope: `Claude account ${k.account}` }, k.by);
      return r.ok ? undefined : r.error;
    },
  };
}
