// Issue #1958: what the hopper configures for a run reaches the real CLI and works there. The claude plugin's own
// arguments give Claude Code an MCP server (the double, on loopback) and a PostToolUse hook; the fake model server
// scripts a call of the MCP server's tool. The test asserts the tool reached the model, the MCP server took the call,
// the hook fired on it with the job's environment, and the tool's answer went back to the model. Skips where claude is
// not installed (test/support/real-agents.ts).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../src/domain/ports.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { createPrintAgentExecutor } from '../../src/executors/index.ts';
import { startFakeMcpServer, type FakeMcpServer } from '../support/fake-mcp-server.ts';
import { startFakeModelServer, type FakeModelServer } from '../support/fake-model-server.ts';
import { REAL_AGENTS, realBin, writeAgentFiles } from '../support/real-agents.ts';
import { useStandInPodman } from '../support/stand-in-podman.ts';

const HERE: MachineSnapshot = { id: 'local', label: 'here', maxLanes: 1, online: true, executors: ['agent'] };
const TURN_MS = 90_000;
const claude = REAL_AGENTS.find((a) => a.agent === 'claude')!;
const bin = realBin('claude');

let server: FakeModelServer;
let mcp: FakeMcpServer;
let dir: string;
beforeAll(async () => {
  server = await startFakeModelServer();
  mcp = await startFakeMcpServer();
  dir = mkdtempSync(join(tmpdir(), 'jh-hooks-mcp-'));
  useStandInPodman(dir);
  delete process.env.HOPPER_URL;
  if (bin) writeAgentFiles(claude, server.url);
});
afterAll(async () => {
  await server.close();
  await mcp.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** The plugin's arguments a person sets for this run: its permissions, the MCP server and the hook. */
function argsFor(hookFile: string): string[] {
  const hook = `{ printf '%s\\n' "$HOPPER_JOB_ID"; cat; } > '${hookFile}'`;
  return [
    ...claude.args(server.url),
    '--mcp-config', JSON.stringify({ mcpServers: { double: { type: 'http', url: mcp.url } } }),
    '--settings', JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'mcp__double__echo', hooks: [{ type: 'command', command: hook }] }] } }),
  ];
}

describe('the real claude CLI with the MCP server and the hook its plugin gives it', () => {
  it.skipIf(!bin)('calls the MCP server\'s tool, the hook fires on it with the job\'s environment, and the answer reaches the model', async () => {
    const cwd = join(dir, 'work');
    mkdirSync(cwd, { recursive: true });
    const hookFile = join(dir, 'hook.txt');
    server.script([{ tool: { name: 'mcp__double__echo', input: { text: 'hello' } } }, { text: 'The echo answered.\n\nHOPPER_DONE' }]);
    const from = server.requests.length;
    const ex = createPrintAgentExecutor({ agent: 'claude', name: 'claude', bin: bin!, args: argsFor(hookFile), sshAuth: () => { throw new Error('no ssh'); } });
    const job: Job = {
      id: `job-hooks-mcp-${process.pid}`, spec: { executor: 'agent', payload: { prompt: 'Call the echo tool.', cwd, model: claude.model, timeoutMs: TURN_MS, env: { ...claude.env(server.url), ENABLE_TOOL_SEARCH: 'false' } }, machineId: HERE.id },
      priority: 50, status: 'running', approved: false, createdAt: '', updatedAt: '', attempts: 1,
    };
    const ctx: ExecutionContext = { job, laneId: 'local/lane-1', machine: HERE, signal: new AbortController().signal, progress() {}, saveState() {}, workTree() {} };

    expect(await ex.run(ctx)).toMatchObject({ kind: 'finished', result: { summary: 'The echo answered.' } });
    // The MCP server's tool was offered to the model, under the name Claude Code gives it (tool search off: it defers MCP tools).
    const turns = server.requests.slice(from).filter((r) => r.step);
    const tools = (turns[0]!.body.tools as { name: string }[]).map((t) => t.name);
    expect(tools).toContain('mcp__double__echo');
    // The MCP server took the call, as the model asked for it.
    expect(mcp.calls).toEqual([{ name: 'echo', arguments: { text: 'hello' } }]);
    // The hook fired on that call, in the job's environment.
    expect(existsSync(hookFile)).toBe(true);
    const [jobId, ...rest] = readFileSync(hookFile, 'utf8').split('\n');
    expect(jobId).toBe(job.id);
    expect(JSON.parse(rest.join('\n'))).toMatchObject({ hook_event_name: 'PostToolUse', tool_name: 'mcp__double__echo', tool_input: { text: 'hello' } });
    // The tool's answer went back to the model.
    expect(JSON.stringify(turns[1]!.body)).toContain('echo: hello');
  }, TURN_MS * 2);
});
