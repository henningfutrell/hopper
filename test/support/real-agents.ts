// The real print-mode agent CLIs (issue #1958), set up to talk to the fake model server and nothing else: for each, how
// to find it, the arguments its executor plugin gives it, the environment and config files that point it at the server
// with a dummy key, and the tool call that writes a file, in its own tool's shape. Proxy variables name the server too,
// so a CLI's own calls elsewhere (telemetry, an update check, a model catalog) are refused there, never sent.
import { accessSync, closeSync, constants, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import type { PrintAgent } from '../../src/executors/index.ts';
import type { ModelFault, ModelStep } from './fake-model-server.ts';

export interface RealAgent {
  agent: PrintAgent;
  /** The plugin's own arguments: permissions, sandbox, the provider. */
  args(url: string): string[];
  /** The model the job names. */
  model: string;
  /** The job's variables that point the CLI at the server. */
  env(url: string): Record<string, string>;
  /** Config files the CLI reads from its home, by their path under HOME. */
  files?(url: string): Record<string, string>;
  /** The faults it retries with no end (seen at its version here): only the turn's timeout ends the job. */
  retriesPastTimeout?: readonly ModelFault[];
  /** The faults it fails at once on some runs and retries past the timeout on others: either way is its own. */
  eitherWay?: readonly ModelFault[];
  /** A tool call that writes `text` to `file` in the work tree. */
  write(file: string, text: string): ModelStep;
}

const KEY = 'fake-model-key';

/** Every request but the server's own goes through the server, which refuses it. */
const proxied = (url: string): Record<string, string> =>
  ({ HTTPS_PROXY: url, HTTP_PROXY: url, https_proxy: url, http_proxy: url, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' });

export const REAL_AGENTS: readonly RealAgent[] = [
  {
    agent: 'claude', model: 'claude-fake-1',
    args: () => ['--dangerously-skip-permissions'],
    env: (url) => ({
      ...proxied(url), ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: KEY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_MAX_RETRIES: '1',
    }),
    write: (file, text) => ({ tool: { name: 'Bash', input: { command: `printf %s '${text}' > ${file}`, description: `Write ${file}` } } }),
  },
  {
    agent: 'codex', model: 'gpt-fake-1',
    args: (url) => [
      '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_provider="fake"',
      '-c', `model_providers.fake={name="fake",base_url="${url}/v1",wire_api="responses",env_key="FAKE_MODEL_KEY",request_max_retries=0,stream_max_retries=0}`,
    ],
    env: (url) => ({ ...proxied(url), FAKE_MODEL_KEY: KEY }),
    write: (file, text) => ({ tool: { name: 'exec_command', input: { cmd: `printf %s '${text}' > ${file}` } } }),
  },
  {
    agent: 'opencode', model: 'openai/fake-1',
    args: () => [],
    env: (url) => ({
      ...proxied(url), OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: { openai: { options: { baseURL: `${url}/v1`, apiKey: KEY }, models: { 'fake-1': { name: 'fake-1', tool_call: true } } } },
        permission: { edit: 'allow', bash: 'allow' },
      }),
    }),
    // opencode 2.1 retries a 429, a 5xx and a cut stream with a growing backoff and no limit.
    retriesPastTimeout: ['rate-limited', 'overloaded', 'server-error', 'cut'],
    // opencode 2 names its shell tool `shell` (1.x: `bash`).
    write: (file, text) => ({ tool: { name: 'shell', input: { command: `printf %s '${text}' > ${file}`, description: `Write ${file}` } } }),
  },
  {
    agent: 'omp', model: 'fake/fake-1',
    args: () => ['--auto-approve'],
    env: (url) => ({ ...proxied(url), FAKE_MODEL_KEY: KEY }),
    // omp 18.7 retries a 429 and a 5xx with no limit (still at it after 150 s).
    retriesPastTimeout: ['rate-limited', 'overloaded', 'server-error'],
    // omp 18.12 on a cut stream: some runs end at once on ECONNRESET, others retry until the timeout.
    eitherWay: ['cut'],
    files: (url) => ({
      '.omp/agent/models.yml': `providers:\n  fake:\n    baseUrl: ${url}/v1\n    api: openai-completions\n    apiKey: FAKE_MODEL_KEY\n    models:\n      - id: fake-1\n        name: fake-1\n        reasoning: true\n`,
    }),
    write: (file, text) => ({ tool: { name: 'bash', input: { command: `printf %s '${text}' > ${file}` } } }),
  },
];

/** Whether a file is a shell script: a guard, or a wrapper that looks the CLI up on PATH again (a job's, a version manager's). */
function shellScript(file: string): boolean {
  const head = Buffer.alloc(64);
  const fd = openSync(file, 'r');
  try { readSync(fd, head, 0, 64, 0); } finally { closeSync(fd); }
  return /^#!\s*(\S*\/)?(env\s+)?(ba|da|z)?sh\b/.test(head.toString('latin1'));
}

/**
 * The real CLI: `HOPPER_ACCEPTANCE_<AGENT>_BIN` when set, else the first on PATH that is no shell script: not the test
 * isolation's guard (test/support/isolate.ts), and not a wrapper that would find that guard. Undefined: not installed
 * here, and its tests skip.
 */
export function realBin(agent: PrintAgent): string | undefined {
  const named = process.env[`HOPPER_ACCEPTANCE_${agent.toUpperCase().replace('-', '_')}_BIN`];
  if (named) return named;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const file = join(dir, agent);
    try { accessSync(file, constants.X_OK); } catch { continue; }
    if (!shellScript(file)) return file;
  }
  return undefined;
}

/** Writes the CLI's config files into HOME, the test isolation's throwaway home. */
export function writeAgentFiles(a: RealAgent, url: string): void {
  for (const [path, text] of Object.entries(a.files?.(url) ?? {})) {
    const file = join(process.env.HOME!, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}
