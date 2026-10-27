// The `claude` CLI in print mode, locked down, for the built-in escalation level (claude-cli;
// design.md "Question pipeline"): no tools, no MCP, no settings, no session,
// output bound to a JSON Schema, prompt on stdin, cwd = hopper's data dir (so no project
// CLAUDE.md loads), env scrubbed of the Claude Code markers. Never throws. On a designated
// machine (`wrap`), the same argv runs through that machine's connection in a fresh private dir.
import { spawn } from 'node:child_process';
import type { z } from 'zod';
import type { DetectionKit, OptionChoice, QuestionAttempt } from './sdk.ts';
import { levelArgv } from '../client/level.ts';
import { userProcessEnv } from '../executors/env.ts';
import type { RunLogins } from '../domain/types.ts';
import { hideCodes } from '../logins/recognise.ts';
import { watchRunOutput } from '../logins/run-output.ts';

export interface ClaudePrintOptions {
  bin: string;
  model: string;
  /** `--effort`, when set. */
  effort?: string;
  cwd: string;
  timeoutMs: number;
  /**
   * The literal draft-07 JSON Schema for `--json-schema`. Not z.toJSONSchema: that stamps
   * `$schema` draft 2020-12, which the claude CLI's validator rejects ("no schema with key or ref").
   */
  jsonSchema: Record<string, unknown>;
  /** Where claude runs: given `[bin, ...argv]`, the program and argv that run it there. Absent: here. */
  wrap?: (argv: string[]) => [string, string[]];
  /** Over the daemon's environment: the user's CLI config dirs (PluginContext.userEnv, issue #158). */
  userEnv?: Readonly<Record<string, string>>;
  /** Where a device login the run waits on is reported (issue #476): it goes to the logins, never into the reply. */
  logins?: RunLogins;
  /** Told the run's cost in USD, when the CLI said it (`total_cost_usd`). */
  onCost?: (usd: number) => void;
}

/**
 * On an attached machine: claude in a fresh private dir there, removed after with the project dir
 * claude keeps for it, named for the dir as claude sees it: its real path, so a TMPDIR through a link (issue #472) still
 * finds it. `"$@"` is claude and its arguments, passed as words, never parsed as script; it runs in the background on the
 * script's own stdin (fd 3), so the script can say first, on stderr, which process and dir the run is (`hopper-run:`): a
 * run stopped by a timeout or a cancel is reaped from it (`REAP_RUN`). Whatever of the dirs stays is said too
 * (`hopper-run-left:`), and fails the run. Run as `sh -c ON_MACHINE sh <bin> <args…>`.
 */
export const ON_MACHINE = 'exec 3<&0; d=$(mktemp -d) && cd "$d" && d=$(pwd -P) || exit 1; '
  + 'c="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(printf %s "$d" | tr -c A-Za-z0-9 -)"; '
  + '"$@" <&3 3<&- & p=$!; exec 3<&-; printf \'hopper-run: %s %s\\n\' "$p" "$d" >&2; wait "$p"; s=$?; cd /; rm -rf "$d" "$c" 2>/dev/null; '
  + 'for x in "$d" "$c"; do if [ -e "$x" ]; then printf \'hopper-run-left: %s\\n\' "$x" >&2; fi; done; exit $s';

/**
 * A run `ON_MACHINE` started, stopped from here (issue #472): its claude killed on the machine, its dir and project dir
 * removed; what stays, said on stdout (`hopper-run-left:`). Run as `sh -c REAP_RUN sh <pid> <dir>` through the same
 * connection. A dir that is not a `mktemp -d` dir is refused before anything is removed.
 */
export const REAP_RUN = 'case $2 in /*/tmp.*) ;; *) exit 2 ;; esac; kill -9 "$1" 2>/dev/null; d=$2; '
  + 'c="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(printf %s "$d" | tr -c A-Za-z0-9 -)"; rm -rf "$d" "$c" 2>/dev/null; '
  + 'for x in "$d" "$c"; do if [ -e "$x" ]; then printf \'hopper-run-left: %s\\n\' "$x"; fi; done; exit 0';

/** The process and dir of a run, as `ON_MACHINE` said them: its first `hopper-run:` line, when it is one it could say. */
export function runMarkOf(stderr: string): { pid: string; dir: string } | undefined {
  const m = /^hopper-run: (\d+) (\/[^\n]*)$/m.exec(stderr);
  if (!m) return undefined;
  const dir = m[2]!;
  return /^\/(?:[^\n]*\/)?tmp\.[A-Za-z0-9]+$/.test(dir) && !dir.split('/').includes('..') ? { pid: m[1]!, dir } : undefined;
}

/** The paths a run left on the machine, as `ON_MACHINE` or `REAP_RUN` said them. */
export function leftOf(out: string): string[] {
  return [...out.matchAll(/^hopper-run-left: ([^\n]*)$/gm)].map((m) => m[1]!);
}

/** `out` without the lines `ON_MACHINE` and `REAP_RUN` say, so they never show in a reason. */
export function withoutRunMarks(out: string): string {
  return out.replace(/^hopper-run(?:-left)?: [^\n]*\n?/gm, '');
}

/** The reason a run failed when it left files on the machine. */
export const leftReason = (left: readonly string[]): string => `the run left files on the machine: ${left.join(', ')}`;

/**
 * Reap a stopped `ON_MACHINE` run (`mark`, from its stderr) through `wrap`, the connection it ran on: the paths that stay,
 * or why the reap itself failed, as a path list's reason. Never throws.
 */
export function reapRun(wrap: (argv: string[]) => [string, string[]], mark: { pid: string; dir: string }, env: NodeJS.ProcessEnv, cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    let out = '';
    let file: string;
    let args: string[];
    try {
      [file, args] = wrap(['sh', '-c', REAP_RUN, 'sh', mark.pid, mark.dir]);
    } catch {
      return resolve([mark.dir]);
    }
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], timeout: REAP_TIMEOUT_MS, killSignal: 'SIGKILL' });
    child.stdout.setEncoding('utf8').on('data', (c: string) => { out += c; });
    child.on('error', () => resolve([mark.dir]));
    // A reap that did not end well cannot say the dir went: it is said to stay.
    child.on('close', (code) => resolve(code === 0 ? leftOf(out) : [mark.dir]));
  });
}

const REAP_TIMEOUT_MS = 30_000;

/** Default `timeoutMs` of the claude plugins. */
export const CLAUDE_TIMEOUT_MS = 180_000;

/** `base` (process.env) without the Claude Code markers, so a child claude does not think it runs inside one. */
export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  return env;
}

/** The lockdown argv: one owner, the client's (src/client/level.ts), so a client target runs exactly what this machine does. */
export function claudeArgv(o: Pick<ClaudePrintOptions, 'model' | 'effort' | 'jsonSchema'>): string[] {
  return levelArgv(o);
}

type Ran<T extends object> = T & { model?: string };

/** What a print run printed: the schema-valid structured_output with the model that ran, or `{ error }`. */
export function parsePrint<T extends object>(stdout: string, schema: z.ZodType<T>): Ran<T> | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { error: 'claude output is not JSON' };
  }
  const result = json as { structured_output?: unknown; modelUsage?: unknown } | null;
  const parsed = schema.safeParse(result?.structured_output);
  if (!parsed.success) return { error: 'claude structured_output missing or invalid' };
  // modelUsage is keyed by the model ids that ran: what an alias such as `fable` resolved to.
  const usage = result?.modelUsage;
  const ran = usage && typeof usage === 'object' ? Object.keys(usage).join(', ') : '';
  return ran ? { ...parsed.data, model: ran } : parsed.data;
}

/** The cost in USD a print run said (`total_cost_usd`); undefined: it said none. */
export function costOfPrint(stdout: string): number | undefined {
  try {
    const cost = (JSON.parse(stdout) as { total_cost_usd?: unknown } | null)?.total_cost_usd;
    return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
  } catch {
    return undefined;
  }
}

/** Run one prompt; resolve the schema-valid structured_output with the model that ran, or `{ error }`. */
export function claudePrint<T extends object>(o: ClaudePrintOptions, schema: z.ZodType<T>, prompt: string, signal: AbortSignal): Promise<Ran<T> | { error: string }> {
  return new Promise((resolve) => {
    const timeout = AbortSignal.timeout(o.timeoutMs);
    const stop = AbortSignal.any([signal, timeout]);
    const reasonOf = () => (timeout.aborted ? `timeout after ${o.timeoutMs}ms` : 'aborted');
    let stdout = '';
    let stderr = '';
    let settled = false;
    let stopped = false;
    const login = watchRunOutput(o.logins, { now: () => new Date() });
    const finish = (r: Ran<T> | { error: string }) => {
      if (settled) return;
      settled = true;
      stop.removeEventListener('abort', onAbort);
      // A device code the run printed never leaves it in an error (issue #476).
      const said = 'error' in r ? { error: hideCodes(r.error, `${stdout}\n${stderr}`, login.codes()) } : r;
      login.end('error' in said ? { ok: false, reason: said.error } : { ok: true });
      resolve(said);
    };
    const [file, args] = o.wrap ? o.wrap([o.bin, ...claudeArgv(o)]) : [o.bin, claudeArgv(o)];
    const env = scrubbedEnv(userProcessEnv(o.wrap ? {} : o.userEnv));
    const child = spawn(file, args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const onAbort = () => {
      if (stopped || settled) return;
      stopped = true;
      const reason = reasonOf();
      child.kill('SIGKILL');
      // The kill stops the process here, not the run on the machine (issue #472): reaped through the same connection.
      const mark = o.wrap ? runMarkOf(stderr) : undefined;
      if (!o.wrap || !mark) return finish({ error: reason });
      void reapRun(o.wrap, mark, env, o.cwd).then((left) => finish({ error: left.length ? `${reason}; ${leftReason(left)}` : reason }));
    };
    if (stop.aborted) return onAbort();
    stop.addEventListener('abort', onAbort);
    child.on('error', (err) => finish({ error: `claude spawn failed: ${err.message}` }));
    child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c; login.feed(c); });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr += c; login.feed(c); });
    child.on('close', (code) => {
      if (stopped) return;
      const left = leftOf(stderr);
      const said = withoutRunMarks(stderr).trim().slice(0, 300);
      if (code !== 0) return finish({ error: `claude exited ${code}: ${said}${left.length ? `; ${leftReason(left)}` : ''}` });
      if (left.length) return finish({ error: leftReason(left) });
      const cost = o.onCost ? costOfPrint(stdout) : undefined;
      if (cost !== undefined) o.onCost!(cost);
      finish(parsePrint(stdout, schema));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

/** `which` the bin, then `<bin> --version`. Cheap; never a model call. */
export async function detectClaude(sys: DetectionKit, bin: string) {
  if (!(await sys.which(bin))) return { status: 'unavailable' as const, reason: `claude not found: ${bin}` };
  const version = await sys.version(bin, ['--version']);
  if (!version) return { status: 'unavailable' as const, reason: `${bin} --version failed` };
  return { status: 'available' as const, detail: version };
}

/** What `claudeModels` sends on stdin: the initialize control request, which lists the models. */
export const INITIALIZE = `${JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } })}\n`;

/** The arguments of `claudeModels`' call: the stream-json handshake, locked down as a level's run. */
export const CLAUDE_MODELS_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--tools', ''];

interface ListedModel { value?: unknown; displayName?: unknown; description?: unknown }

/** The models the reply to `INITIALIZE` lists; empty when `out` holds no reply. */
export function claudeModelsOf(out: string): OptionChoice[] {
  for (const line of out.split('\n')) {
    let msg: { type?: unknown; response?: { response?: { models?: unknown } } };
    try { msg = JSON.parse(line) as typeof msg; } catch { continue; }
    if (msg.type !== 'control_response') continue;
    const models = msg.response?.response?.models;
    if (!Array.isArray(models)) return [];
    return (models as ListedModel[]).flatMap((m) => (typeof m.value === 'string' && m.value ? [{
      value: m.value,
      ...(typeof m.displayName === 'string' ? { label: m.displayName } : {}),
      ...(typeof m.description === 'string' ? { description: m.description } : {}),
    }] : []));
  }
  return [];
}

/**
 * The models `bin` offers, as its stream-json initialize handshake lists them: the reply to one
 * control request, no prompt, so no model call. Empty when it cannot run or lists none.
 */
export async function claudeModels(sys: DetectionKit, bin: string): Promise<OptionChoice[]> {
  return claudeModelsOf(await sys.output(bin, CLAUDE_MODELS_ARGS, INITIALIZE) ?? '');
}

/** `option`'s choices: the models of the `claude` on PATH; none when it lists none. */
export async function claudeModelChoices(sys: DetectionKit, option: string): Promise<Record<string, OptionChoice[]>> {
  const models = await claudeModels(sys, 'claude');
  return models.length ? { [option]: models } : {};
}

/** One trail entry as a prompt line (the claude-cli prompt lists the trail so far). */
export function attemptLine(a: QuestionAttempt): string {
  const why = a.error ? `error: ${a.error}` : (a.reason ?? 'no reason given');
  const verdict = a.escalate === undefined ? '' : `escalate=${a.escalate}`;
  const what = a.answer ? `${a.answer}${verdict ? ` (${verdict})` : ''}` : (verdict || '(no answer)');
  return `- ${a.tier}${a.role ? ` [${a.role}]` : ''}${a.model ? ` (${a.model})` : ''}: ${what} — ${why}`;
}
