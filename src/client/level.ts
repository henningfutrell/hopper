// An escalation level's run (issue #482, design.md "Question pipeline", "Client targets"): `claude` in print
// mode, locked down — no tools, no MCP, no settings, no session, output bound to a JSON Schema, the prompt on
// stdin. The argv is built here, from the model, the effort and the schema alone, so a signed `POST /level`
// on a client target can never start anything but this; the hopper's claude-cli level builds the same argv
// for this machine and an ssh target. Also the client's one way to run claude (`runClaude`), which a usage
// read's `POST /claude` shares. Imports nothing of hopper: it is installed on the target as plain files.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** Default timeout of a level's run, and the most a client allows. */
export const LEVEL_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;

export interface LevelRun { model: string; effort?: string; jsonSchema: Record<string, unknown> }

/** The lockdown argv of a level's run. `--tools` is last so its variadic list cannot swallow another flag. */
export function levelArgv(o: LevelRun): string[] {
  return [
    '-p', '--model', o.model, ...(o.effort ? ['--effort', o.effort] : []),
    '--output-format', 'json', '--json-schema', JSON.stringify(o.jsonSchema),
    '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--tools', '',
  ];
}

/** A model alias or id: never an option, a space or a path. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;
const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v);
const isSchema = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && JSON.stringify(v).length <= 64 * 1024;

/** The argv, stdin and timeout a `/level` body asks for; else why it is refused. */
export function levelCallOf(body: unknown): { argv: string[]; input: string; timeoutMs: number } | string {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { model?: unknown; effort?: unknown; jsonSchema?: unknown; prompt?: unknown; timeoutMs?: unknown };
  if (typeof b.model !== 'string' || !MODEL.test(b.model)) return 'model must be a model alias or id';
  if (b.effort !== undefined && !isEffort(b.effort)) return `effort must be one of ${EFFORTS.join(', ')}`;
  if (!isSchema(b.jsonSchema)) return 'jsonSchema must be a JSON Schema object of at most 64 KiB';
  if (typeof b.prompt !== 'string' || !b.prompt) return 'prompt must be non-empty text';
  const timeoutMs = typeof b.timeoutMs === 'number' && b.timeoutMs > 0 ? Math.min(b.timeoutMs, MAX_TIMEOUT_MS) : LEVEL_TIMEOUT_MS;
  return { argv: levelArgv({ model: b.model, ...(b.effort ? { effort: b.effort } : {}), jsonSchema: b.jsonSchema }), input: b.prompt, timeoutMs };
}

export interface Ran { code: number; stdout: string; stderr: string }

/** One claude call, in a fresh private dir, `input` on its stdin; the dir and the project dir claude keeps for it removed after. */
export function runClaude(bin: string, args: string[], timeoutMs: number, input = ''): Promise<Ran> {
  const dir = mkdtempSync(join(tmpdir(), 'hopper-claude-'));
  const done = (r: Ran): Ran => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', dir.replace(/[^A-Za-z0-9]/g, '-')), { recursive: true, force: true });
    return r;
  };
  return new Promise((resolve) => {
    const child = execFile(bin, args, { cwd: dir, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve(done({ code: 0, stdout, stderr }));
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (e.killed) return resolve(done({ code: 124, stdout, stderr: `claude timed out after ${timeoutMs} ms` }));
      resolve(done({ code: typeof e.code === 'number' ? e.code : 127, stdout, stderr: stderr || e.message }));
    });
    child.stdin?.on('error', () => undefined); // a claude that exits before reading answers its own exit code
    child.stdin?.end(input);
  });
}

/** A signed `/level` call (issue #482): claude locked down, its argv built here, the prompt on stdin. */
export async function level(bin: string, body: string, answer: (status: number, payload: unknown) => void): Promise<void> {
  let call: ReturnType<typeof levelCallOf>;
  try { call = levelCallOf(JSON.parse(body)); } catch { return answer(400, { error: 'body must be JSON' }); }
  if (typeof call === 'string') return answer(400, { error: call });
  answer(200, await runClaude(bin, call.argv, call.timeoutMs, call.input));
}
