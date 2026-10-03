import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { AnswerRequest, AnswerVerdict, Answerer } from '../domain/ports.ts';
import { buildPrompt } from './prompt.ts';

const verdictSchema = z.object({
  answer: z.string(),
  confident: z.boolean(),
  risky: z.boolean(),
  reason: z.string(),
});
const outputSchema = z.object({ structured_output: verdictSchema });
const JSON_SCHEMA = JSON.stringify(z.toJSONSchema(verdictSchema));

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  return env;
}

function parseVerdict(stdout: string): AnswerVerdict | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { error: 'claude output is not JSON' };
  }
  const parsed = outputSchema.safeParse(json);
  return parsed.success ? parsed.data.structured_output : { error: 'claude structured_output missing or invalid' };
}

/** One tier backed by the `claude` CLI in print mode. Never throws. */
export function createClaudeCliAnswerer(o: {
  tier: Answerer['tier'];
  model: string;
  bin: string;
  cwd: string;
  timeoutMs: number;
}): Answerer {
  // --tools is last so its variadic list cannot swallow another flag.
  const argv = [
    '-p', '--model', o.model, '--output-format', 'json', '--json-schema', JSON_SCHEMA,
    '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--tools', '',
  ];
  return {
    tier: o.tier,
    model: o.model,
    answer(req: AnswerRequest, signal: AbortSignal) {
      return new Promise((resolve) => {
        const timeout = AbortSignal.timeout(o.timeoutMs);
        const stop = AbortSignal.any([signal, timeout]);
        const reasonOf = () => (timeout.aborted ? `timeout after ${o.timeoutMs}ms` : 'aborted');
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (r: AnswerVerdict | { error: string }) => {
          if (settled) return;
          settled = true;
          stop.removeEventListener('abort', onAbort);
          resolve(r);
        };
        const child = spawn(o.bin, argv, { cwd: o.cwd, env: scrubbedEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
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
          finish(parseVerdict(stdout));
        });
        child.stdin.on('error', () => {});
        child.stdin.end(buildPrompt(req));
      });
    },
  };
}
