// The `claude` CLI in print mode, locked down, for the built-in escalation level (claude-cli;
// design.md "Question pipeline"): no tools, no MCP, no settings, no session,
// output bound to a JSON Schema, prompt on stdin, cwd = hopper's data dir (so no project
// CLAUDE.md loads), env scrubbed of the Claude Code markers. Never throws.
import { spawn } from 'node:child_process';
import type { z } from 'zod';
import type { DetectionKit, OptionChoice, QuestionAttempt } from './sdk.ts';

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
}

/** Default `timeoutMs` of the claude plugins. */
export const CLAUDE_TIMEOUT_MS = 180_000;

/** process.env without the Claude Code markers, so a child claude does not think it runs inside one. */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  return env;
}

export function claudeArgv(o: Pick<ClaudePrintOptions, 'model' | 'effort' | 'jsonSchema'>): string[] {
  // --tools is last so its variadic list cannot swallow another flag.
  return [
    '-p', '--model', o.model, ...(o.effort ? ['--effort', o.effort] : []),
    '--output-format', 'json', '--json-schema', JSON.stringify(o.jsonSchema),
    '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--tools', '',
  ];
}

type Ran<T extends object> = T & { model?: string };

function parse<T extends object>(stdout: string, schema: z.ZodType<T>): Ran<T> | { error: string } {
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

/** Run one prompt; resolve the schema-valid structured_output with the model that ran, or `{ error }`. */
export function claudePrint<T extends object>(o: ClaudePrintOptions, schema: z.ZodType<T>, prompt: string, signal: AbortSignal): Promise<Ran<T> | { error: string }> {
  return new Promise((resolve) => {
    const timeout = AbortSignal.timeout(o.timeoutMs);
    const stop = AbortSignal.any([signal, timeout]);
    const reasonOf = () => (timeout.aborted ? `timeout after ${o.timeoutMs}ms` : 'aborted');
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: Ran<T> | { error: string }) => {
      if (settled) return;
      settled = true;
      stop.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const child = spawn(o.bin, claudeArgv(o), { cwd: o.cwd, env: scrubbedEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const onAbort = () => {
      child.kill('SIGKILL');
      finish({ error: reasonOf() });
    };
    if (stop.aborted) return onAbort();
    stop.addEventListener('abort', onAbort);
    child.on('error', (err) => finish({ error: `claude spawn failed: ${err.message}` }));
    child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
    child.on('close', (code) => {
      if (code !== 0) return finish({ error: `claude exited ${code}: ${stderr.trim().slice(0, 300)}` });
      finish(parse(stdout, schema));
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

const INITIALIZE = `${JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } })}\n`;

interface ListedModel { value?: unknown; displayName?: unknown; description?: unknown }

/**
 * The models `bin` offers, as its stream-json initialize handshake lists them: the reply to one
 * control request, no prompt, so no model call. Empty when it cannot run or lists none.
 */
export async function claudeModels(sys: DetectionKit, bin: string): Promise<OptionChoice[]> {
  const out = await sys.output(bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--tools', ''], INITIALIZE);
  for (const line of (out ?? '').split('\n')) {
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
