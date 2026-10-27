// Draft providers (issue #474, design.md "Drafting on the user's AI CLI"): the AI CLIs a run skill's draft can run on —
// the user's `claude`, codex, Cursor's agent, opencode and omp, each signed in on the user's machine under its own
// account. How each is called for one locked-down turn — no tools, no session kept, no user settings where the CLI can
// leave them out — and how its answer is read. claude's argv is the client's (`levelArgv`), so a client target runs
// exactly what this machine does; the other CLIs' argv and reading are the print-mode executors' (print-agents.ts),
// with the lockdown flags in place of a job's. What a CLI keeps of a run on its machine is removed after the run: opencode's
// session, Cursor's agent's chat. Which machines a provider can run on, and why not. The probe's calls, which say before a
// draft whether a provider is signed in there and which models it lists, and how they are read. Pure.
import { levelArgv } from '../client/level.ts';
import type { OptionChoice } from '../domain/plugins.ts';
import type { MachineSnapshot } from '../domain/types.ts';
import { DIALECTS } from '../executors/print-agents.ts';
import { CLAUDE_MODELS_ARGS, claudeModelsOf, INITIALIZE } from '../plugins/claude-print.ts';

export const DRAFT_PROVIDERS = ['claude', 'codex', 'cursor-agent', 'opencode', 'omp'] as const;
export type DraftProvider = (typeof DRAFT_PROVIDERS)[number];

export const isDraftProvider = (v: unknown): v is DraftProvider => typeof v === 'string' && (DRAFT_PROVIDERS as readonly string[]).includes(v);

/** One draft's call: the CLI (`bin`, default the provider's name), the model and effort, the answer's JSON Schema, the prompt. */
export interface DraftCall { provider: DraftProvider; bin?: string; model?: string; effort?: string; jsonSchema: Record<string, unknown>; prompt: string }

/** The argv to run (the CLI first) and what goes on its stdin. */
export interface DraftArgv { argv: string[]; stdin: string }

/** The model claude runs when the user names none: the claude-cli level's default. */
export const CLAUDE_DEFAULT_MODEL = 'opus';

/**
 * opencode's lockdown (opencode 2, issue #2862), in its environment: every tool's permission denied
 * (`OPENCODE_CONFIG_CONTENT`, the config opencode reads last, so it wins over the user's own), no project config, no
 * Claude Code prompt or skills read, no update check. opencode 2 has no switch that leaves plugins out (1.x's `--pure`).
 */
export const OPENCODE_LOCKDOWN: Readonly<Record<string, string>> = {
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { '*': 'deny' } }),
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_DISABLE_AUTOUPDATE: '1',
};

/**
 * opencode's run, `"$@"`: its lockdown (`OPENCODE_LOCKDOWN`) set in the script, so it holds on an ssh target too.
 * opencode keeps a session for every run: the script deletes the one its output names (`sessionID`), with the same
 * environment and `--standalone` (no background service), whether the run went well or not. Its output goes to a file
 * in the run dir first, so the script can read the session from it. Run as `sh -c OPENCODE_RUN sh <bin> run <args…>`.
 */
export const OPENCODE_RUN = `export ${Object.entries(OPENCODE_LOCKDOWN).map(([k, v]) => `${k}='${v}'`).join(' ')}; `
  + '"$@" >.opencode-out; s=$?; cat .opencode-out; '
  + 'id=$(sed -n \'s/.*"sessionID":"\\(ses_[A-Za-z0-9_-]*\\)".*/\\1/p\' .opencode-out | head -n 1); rm -f .opencode-out; '
  + 'if [ -n "$id" ]; then "$1" session delete "$id" --standalone >/dev/null 2>&1; fi; exit $s';

/**
 * Cursor's agent's run, `"$@"`: its project data in the run dir (`CURSOR_DATA_DIR`, which holds no login), so it goes
 * with the dir; its chat, which it keeps in its config dir named for the md5 of the run dir's real path, removed after.
 * Run as `sh -c CURSOR_RUN sh <bin> -p <args…>`.
 */
export const CURSOR_RUN = 'd=$(pwd -P); export CURSOR_DATA_DIR="$d/.cursor-data"; "$@"; s=$?; '
  + 'c=${CURSOR_CONFIG_DIR:-${XDG_CONFIG_HOME:+$XDG_CONFIG_HOME/cursor}}; c=${c:-$HOME/.cursor}; '
  + 'h=$(printf %s "$d" | { md5sum 2>/dev/null || md5; } | cut -c1-32); '
  + 'case $h in *[!0-9a-f]*|"") ;; *) rm -rf "$c/chats/$h" ;; esac; exit $s';

/** codex's reasoning efforts: `max` is its `xhigh`. */
const codexEffort = (e: string): string => (e === 'max' ? 'xhigh' : e);

/** The text a CLI with no `--json-schema` is asked to answer, after the prompt. */
export const ANSWER_JSON_ONLY = 'Answer with one JSON object only, in the form the prompt asks for: no Markdown fence, no text before or after it.';

/** The argv and stdin of one draft turn, locked down for its CLI. */
export function draftArgv(c: DraftCall): DraftArgv {
  const bin = c.bin ?? c.provider;
  const turn = (args: string[], text: string): string[] => DIALECTS[c.provider].argv({ bin, args, cwd: '.', ...(c.model ? { model: c.model } : {}), text });
  const asked = `${c.prompt}\n\n${ANSWER_JSON_ONLY}`;
  switch (c.provider) {
    case 'claude':
      return { argv: [bin, ...levelArgv({ model: c.model ?? CLAUDE_DEFAULT_MODEL, ...(c.effort ? { effort: c.effort } : {}), jsonSchema: c.jsonSchema })], stdin: c.prompt };
    case 'codex':
      // `-` reads the prompt from stdin. Read-only sandbox, nothing kept, no user config or rules.
      return {
        argv: turn(['--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only',
          ...(c.effort ? ['-c', `model_reasoning_effort="${codexEffort(c.effort)}"`] : [])], '-'),
        stdin: asked,
      };
    case 'cursor-agent':
      // Ask mode is read-only Q&A; the sandbox on; `--trust` so the fresh run dir asks nothing. No effort flag.
      return { argv: ['sh', '-c', CURSOR_RUN, 'sh', ...turn(['--mode', 'ask', '--sandbox', 'enabled', '--trust'], asked)], stdin: '' };
    case 'opencode':
      // The text on stdin (the dialect's); an effort is the model's variant, `provider/model#variant`: with no model, none.
      return {
        argv: ['sh', '-c', OPENCODE_RUN, 'sh', ...DIALECTS.opencode.argv({ bin, args: [], cwd: '.', ...(c.model ? { model: c.effort ? `${c.model}#${c.effort}` : c.model } : {}), text: asked })],
        stdin: asked,
      };
    case 'omp':
      return {
        argv: turn(['--no-tools', '--no-session', '--no-skills', '--no-rules', '--no-extensions', '--no-lsp', ...(c.effort ? [`--thinking=${c.effort}`] : [])], asked),
        stdin: '',
      };
  }
}

/** What a draft turn printed: the answer as JSON with the model that ran, the CLI's own error, or why it cannot be read. */
export type DraftRead = { answer: unknown; model?: string } | { error: string } | { unreadable: string };

/** The one JSON object in an agent's last message: as it is, or inside a Markdown fence, or between its first `{` and last `}`. */
export function jsonIn(text: string): unknown {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(t);
  for (const candidate of [fenced?.[1] ?? t, t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)]) {
    try { return JSON.parse(candidate); } catch { /* the next */ }
  }
  return undefined;
}

/** A draft turn's stdout, read by its provider. */
export function readDraft(provider: DraftProvider, stdout: string): DraftRead {
  if (provider === 'claude') {
    let json: { structured_output?: unknown; modelUsage?: unknown; is_error?: unknown; result?: unknown } | null;
    try { json = JSON.parse(stdout) as typeof json; } catch { return { unreadable: 'claude printed no JSON result' }; }
    if (json?.is_error) return { error: typeof json.result === 'string' && json.result.trim() ? json.result.trim() : 'claude answered an error' };
    if (json?.structured_output === undefined) return { unreadable: 'claude answered no structured output' };
    const usage = json.modelUsage;
    const model = usage && typeof usage === 'object' ? Object.keys(usage).join(', ') : '';
    return { answer: json.structured_output, ...(model ? { model } : {}) };
  }
  const said = DIALECTS[provider].said(stdout);
  if (!('text' in said)) return said;
  const answer = jsonIn(said.text);
  return answer === undefined ? { unreadable: `${provider} answered no JSON object` } : { answer };
}

/** Text a CLI prints when it has no login (or its login ended): its provider's sign-in, never a model answer. */
const NOT_SIGNED_IN = /not (?:logged|signed) in|log ?in required|please (?:run \/?)?(?:log|sign) ?in|auth(?:entication)? (?:required|failed)|unauthori[sz]ed|invalid api key|no api key|\b401\b/i;

/** How to sign each provider in on its machine. */
export const SIGN_IN: Readonly<Record<DraftProvider, string>> = {
  claude: 'claude, then /login',
  codex: 'codex login',
  'cursor-agent': 'cursor-agent login',
  opencode: 'opencode auth login',
  omp: 'omp, then /login',
};

/** A failed turn's plain reason: not installed, not signed in, or what it said. `on`: the machine, in words. */
export function failureOf(provider: DraftProvider, on: string, bin: string, code: number, output: string): string {
  const said = output.trim();
  if (code === 127 || (/not found|no such file or directory/i.test(said) && said.includes(bin))) {
    return `${provider} is not installed on ${on} (${bin} not found). Install it there, or pick another machine.`;
  }
  return notSignedIn(provider, on, said) ?? `${provider} on ${on} exited ${code}: ${said.slice(0, 300) || 'no output'}`;
}

/** The error a turn answered (it exited 0): not signed in, or what it said. */
export function answeredError(provider: DraftProvider, on: string, error: string): string {
  return notSignedIn(provider, on, error) ?? `${provider} on ${on} answered an error: ${error.trim().slice(0, 300)}`;
}

function notSignedIn(provider: DraftProvider, on: string, said: string): string | undefined {
  return NOT_SIGNED_IN.test(said) ? notSignedInReason(provider, on) : undefined;
}

/**
 * Why `provider` cannot draft on machine `id` now, or undefined: it can. `local`: whether `m` is this machine. `ownLogin`:
 * whether the user has a login of their own on this machine for it — a user added later has their own claude config dir
 * here (src/users/env.ts), and no other CLI's, so another CLI here would run on someone else's login.
 */
export function draftRefusal(provider: DraftProvider, id: string, m: MachineSnapshot | undefined, o: { addedUser: boolean }): string | undefined {
  if (!m) return `machine ${id} is not configured. Pick another machine.`;
  if (!m.online) return `machine ${id} is offline. Bring it back, or pick another machine.`;
  if (m.containerImage) return `machine ${id} is a container target: a draft cannot run there (it runs commands only). Pick another machine.`;
  if (m.client && provider !== 'claude') return `machine ${id} is a joined machine: its client runs only claude for a draft. Pick claude, or an ssh machine for ${provider}.`;
  if (!m.ssh && !m.client && o.addedUser && provider !== 'claude') {
    return `on this machine the hopper keeps only your own claude login: ${provider} here would run on another account. Pick one of your machines for ${provider}.`;
  }
  return undefined;
}

/** One probe call: the argv to run (the CLI first) and what goes on its stdin. None of them is a model call. */
export interface ProbeCall { argv: string[]; stdin: string }

/**
 * The call that says whether `provider` is signed in, or undefined: opencode needs no sign-in (it has free models) and
 * omp has no status call; a draft says it, when it runs.
 */
export function statusCall(provider: DraftProvider, bin: string): ProbeCall | undefined {
  switch (provider) {
    case 'claude': return { argv: [bin, 'auth', 'status', '--json'], stdin: '' };
    case 'codex': return { argv: [bin, 'login', 'status'], stdin: '' };
    case 'cursor-agent': return { argv: [bin, 'status'], stdin: '' };
    case 'opencode':
    case 'omp':
      return undefined;
  }
}

/**
 * Whether a status call's output says the CLI is not signed in. Of claude's, only `loggedIn` is read: its output also
 * names the account. An output that says neither is taken as signed in: the draft says it, when it runs.
 */
export function signedOut(provider: DraftProvider, code: number, output: string): boolean {
  if (provider === 'claude') {
    try { return (JSON.parse(output) as { loggedIn?: unknown }).loggedIn === false; } catch { return false; }
  }
  return /not logged in/i.test(output) && (provider !== 'codex' || code !== 0);
}

/** The call that lists `provider`'s models on its machine. */
export function modelsCall(provider: DraftProvider, bin: string): ProbeCall {
  switch (provider) {
    case 'claude': return { argv: [bin, ...CLAUDE_MODELS_ARGS], stdin: INITIALIZE };
    case 'codex': return { argv: [bin, 'debug', 'models'], stdin: '' };
    case 'cursor-agent': return { argv: [bin, 'models'], stdin: '' };
    case 'opencode': return { argv: ['env', ...Object.entries(OPENCODE_LOCKDOWN).map(([k, v]) => `${k}=${v}`), bin, 'models', '--standalone'], stdin: '' };
    case 'omp': return { argv: [bin, 'models', '--json'], stdin: '' };
  }
}

type Json = Record<string, unknown>;
const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const choice = (value: string | undefined, label?: unknown, description?: unknown): OptionChoice[] => (value ? [{
  value, ...(text(label) && label !== value ? { label: text(label)! } : {}), ...(text(description) ? { description: text(description)! } : {}),
}] : []);

function listed(stdout: string): Json[] {
  try {
    const models = (JSON.parse(stdout) as { models?: unknown }).models;
    return Array.isArray(models) ? models.filter((m): m is Json => !!m && typeof m === 'object') : [];
  } catch { return []; }
}

/**
 * The models a models call listed, each its value for `--model`; empty when it lists none or cannot be read. codex: the
 * ones it shows (`visibility: list`); Cursor's agent: the lines after `Available models`, `<id> - <name>`; opencode:
 * `provider/model` lines; omp: each model's `selector`.
 */
export function modelsOf(provider: DraftProvider, stdout: string): OptionChoice[] {
  switch (provider) {
    case 'claude': return claudeModelsOf(stdout);
    case 'codex': return listed(stdout).filter((m) => m.visibility === 'list').flatMap((m) => choice(text(m.slug), m.display_name, m.description));
    case 'cursor-agent': {
      const lines = stdout.split('\n');
      const from = lines.findIndex((l) => l.trim() === 'Available models');
      if (from < 0) return [];
      return lines.slice(from + 1).flatMap((l) => {
        const m = /^(\S+) - (.+?)(?:\s+\((?:current|default)(?:, (?:current|default))?\))?$/.exec(l.trim());
        return m ? choice(m[1], m[2]) : [];
      });
    }
    case 'opencode': return stdout.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l)).flatMap((l) => choice(l));
    case 'omp': return listed(stdout).flatMap((m) => choice(text(m.selector), m.name));
  }
}

/** Why a provider is not signed in on a machine, with its sign-in. */
export const notSignedInReason = (provider: DraftProvider, on: string): string =>
  `${provider} is not signed in on ${on}. Sign it in there (${SIGN_IN[provider]}), then draft again.`;
