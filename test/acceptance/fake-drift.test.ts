// Issue #1958: the schema-drift check of the print-mode CLIs' fake (test/adapters/fake-print-agent.mjs). The real CLI,
// against the fake model server, and its fake answer the same turn; every field of every event the fake prints must
// be in the events of that kind the real CLI prints, or the check fails and names the field. The fake may leave fields
// out (the hopper reads few); it must never print a shape the real CLI no longer does.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIALECTS } from '../../src/executors/print-agents.ts';
import { startFakeModelServer, type FakeModelServer } from '../support/fake-model-server.ts';
import { REAL_AGENTS, realBin, writeAgentFiles } from '../support/real-agents.ts';
import { driftOf } from '../support/event-drift.ts';

const FAKE = join(import.meta.dirname, '..', 'adapters', 'fake-print-agent.mjs');
const REPLY = 'I wrote greeting.txt.\n\nHOPPER_DONE';

let server: FakeModelServer;
let dir: string;
beforeAll(async () => {
  server = await startFakeModelServer();
  dir = mkdtempSync(join(tmpdir(), 'jh-drift-'));
});
afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** What a CLI prints on stdout for one turn, run in `cwd` with `env` over this process's; `stdin`, the text it reads there (else none). */
function stdoutOf(argv: string[], cwd: string, env: Record<string, string>, stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // PWD too: opencode takes its directory from it, not from its cwd.
    const c = spawn(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, ...env, PWD: cwd }, stdio: ['pipe', 'pipe', 'ignore'] });
    c.stdin.end(stdin ?? '');
    let out = '';
    c.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    c.on('error', reject);
    c.on('close', () => resolve(out));
  });
}

describe.each(REAL_AGENTS)('the fake $agent CLI', (a) => {
  const bin = realBin(a.agent);
  beforeAll(() => { if (bin) writeAgentFiles(a, server.url); });

  it.skipIf(!bin)('prints only fields the real CLI prints, in events of the same kind', async () => {
    const cwd = join(dir, a.agent);
    mkdirSync(cwd, { recursive: true });
    // The turn the fake plays: a tool call, then the answer after the model's reasoning.
    server.script([a.write('greeting.txt', 'Hello'), { text: REPLY, thinking: 'The file is written.' }]);
    const call = { args: a.args(server.url), cwd, model: a.model, text: 'Write greeting.txt.' };
    const stdin = DIALECTS[a.agent].textOnStdin ? call.text : undefined;
    const real = await stdoutOf(DIALECTS[a.agent].argv({ ...call, bin: bin! }), cwd, a.env(server.url), stdin);
    expect(DIALECTS[a.agent].read(real)).toMatchObject({ text: REPLY });
    const fake = await stdoutOf(DIALECTS[a.agent].argv({ ...call, bin: FAKE }), cwd, { FAKE_AGENT_KIND: a.agent, FAKE_AGENT_DIR: dir, FAKE_AGENT_REPLY: REPLY }, stdin);
    expect(driftOf(fake, real)).toEqual([]);
  }, 120_000);
});
