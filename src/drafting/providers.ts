// Draft providers (issue #474, design.md "Drafting on the user's AI CLI"): the AI CLIs a run skill's draft can run on —
// the user's `claude`, codex, Cursor's agent, opencode and omp, each signed in on the user's machine under its own
// account. How each is called for one locked-down turn — no tools, no session kept, no user settings where the CLI can
// leave them out — and how its answer is read. claude's argv is the client's (`levelArgv`), so a client target runs
// exactly what this machine does; the other CLIs' argv and reading are the print-mode executors' (print-agents.ts),
// with the lockdown flags in place of a job's. Which machines a provider can run on, and why not. Pure.
import { levelArgv } from '../client/level.ts';
import type { MachineSnapshot } from '../domain/types.ts';
import { DIALECTS } from '../executors/print-agents.ts';

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
 * opencode's lockdown is in its environment: every tool's permission denied, no project config, no Claude Code
 * prompt or skills read. Set by `env` in the argv, so it holds on an ssh target too.
 */
const OPENCODE_ENV = ['OPENCODE_PERMISSION={"*":"deny"}', 'OPENCODE_DISABLE_PROJECT_CONFIG=1', 'OPENCODE_DISABLE_CLAUDE_CODE=1'];

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
      return { argv: turn(['--mode', 'ask', '--sandbox', 'enabled', '--trust'], asked), stdin: '' };
    case 'opencode':
      return { argv: ['env', ...OPENCODE_ENV, ...turn(['--pure', ...(c.effort ? ['--variant', c.effort] : [])], asked)], stdin: '' };
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
  return NOT_SIGNED_IN.test(said) ? `${provider} is not signed in on ${on}. Sign it in there (${SIGN_IN[provider]}), then draft again.` : undefined;
}

/**
 * Why `provider` cannot draft on machine `id` now, or undefined: it can. `local`: whether `m` is this machine. `ownLogin`:
 * whether the user has a login of their own on this machine for it — a user added later has their own claude config dir
 * here (src/users/env.ts), and no other CLI's, so another CLI here would run on someone else's login.
 */
export function draftRefusal(provider: DraftProvider, id: string, m: MachineSnapshot | undefined, o: { addedUser: boolean }): string | undefined {
  if (!m) return `machine ${id} is not configured. Pick another machine.`;
  if (!m.online) return `machine ${id} is offline. Bring it back, or pick another machine.`;
  if (m.docker) return `machine ${id} is a container target: a draft cannot run there (docker exec passes no stdin). Pick another machine.`;
  if (m.client && provider !== 'claude') return `machine ${id} is a joined machine: its client runs only claude for a draft. Pick claude, or an ssh machine for ${provider}.`;
  if (!m.ssh && !m.client && o.addedUser && provider !== 'claude') {
    return `on this machine the hopper keeps only your own claude login: ${provider} here would run on another account. Pick one of your machines for ${provider}.`;
  }
  return undefined;
}
