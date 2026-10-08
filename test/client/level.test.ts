// An escalation level's run on a client target (issue #482, design.md "Client targets"): the hopper cannot
// run a command there, so the client runs its own claude in print mode for one question — `POST /level`,
// signed like every call on its link. The client builds the argv itself, locked down as on any machine (no
// tools, no MCP, no settings, no session); the prompt comes on stdin; a fresh private dir, removed after with
// the project dir claude keeps for it; killed at its timeout. The client is real; claude is the fake.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { levelArgv, levelCallOf } from '../../src/client/level.ts';
import { mintToken } from '../../src/client/signature.ts';
import { ClientError, clientLevel } from '../../src/executors/client.ts';
import { startTestClient, type TestClient } from '../support/client.ts';

const CLAUDE = join(import.meta.dirname, '..', 'plugins', 'fake-claude.mjs');
const TOKEN = mintToken();
const SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
const CALL = { model: 'opus', jsonSchema: SCHEMA, prompt: 'Which database?\nrules: prefer sqlite' };

let dir: string;
let client: TestClient | undefined;
const saved = { ...process.env };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jh-level-'));
  process.env.FAKE_CLAUDE_OUT = join(dir, 'rec.json');
  delete process.env.FAKE_CLAUDE_MODE;
  process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify({ answer: 'use sqlite' });
  client = await startTestClient({ token: () => TOKEN, herdrBin: '/nonexistent/herdr', claudeBin: CLAUDE, session: 'hopper' });
});
afterEach(async () => {
  await client?.stop();
  client = undefined;
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

const rec = () => JSON.parse(readFileSync(join(dir, 'rec.json'), 'utf8')) as { argv: string[]; stdin: string; cwd: string };

describe('a level\'s run on a client target (issue #482)', () => {
  it('runs the client\'s claude locked down, the prompt on stdin, in a fresh dir removed after with claude\'s project dir', async () => {
    const r = await clientLevel(client!.transport(TOKEN), { ...CALL, effort: 'high' }, 15000);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ structured_output: { answer: 'use sqlite' } });
    expect(rec().argv).toEqual(levelArgv({ model: 'opus', effort: 'high', jsonSchema: SCHEMA }));
    expect(rec().argv.slice(-2)).toEqual(['--tools', '']);
    for (const flag of ['--no-session-persistence', '--strict-mcp-config', '--setting-sources']) expect(rec().argv).toContain(flag);
    expect(rec().stdin).toBe(CALL.prompt);
    expect(existsSync(rec().cwd)).toBe(false);
    expect(existsSync(join(homedir(), '.claude', 'projects', rec().cwd.replace(/[^A-Za-z0-9]/g, '-')))).toBe(false);
  });

  it('a run past its timeout is killed and answered as timed out; its dir is removed all the same', async () => {
    process.env.FAKE_CLAUDE_MODE = 'hang';
    const started = Date.now();
    const r = await clientLevel(client!.transport(TOKEN), CALL, 500);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r).toMatchObject({ code: 124, stderr: 'claude timed out after 500 ms' });
    expect(existsSync(rec().cwd)).toBe(false);
  });

  it('refuses a call the hopper did not sign: claude never runs', async () => {
    const wrong = await clientLevel(client!.transport(mintToken()), CALL, 15000).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(ClientError);
    expect((wrong as Error).message).toMatch(/401/);
    expect(existsSync(join(dir, 'rec.json'))).toBe(false);
  });

  it('refuses a call whose fields could reach claude as anything but a locked-down print run', async () => {
    for (const bad of [{ ...CALL, model: '--dangerously-skip-permissions' }, { ...CALL, model: 'opus x' }, { ...CALL, effort: 'everything' }, { ...CALL, jsonSchema: 'x' }, { ...CALL, prompt: '' }]) {
      await expect(clientLevel(client!.transport(TOKEN), bad as never, 15000)).rejects.toThrow(/400/);
    }
    expect(existsSync(join(dir, 'rec.json'))).toBe(false);
  });
});

describe('levelCallOf: the call a /level body asks for', () => {
  it('the argv is the client\'s own: the body names only the model, the effort, the schema, the prompt and the timeout', () => {
    expect(levelCallOf({ ...CALL, timeoutMs: 1000, args: ['--tools', 'Bash'] })).toEqual({ argv: levelArgv({ model: 'opus', jsonSchema: SCHEMA }), input: CALL.prompt, timeoutMs: 1000 });
  });

  it('the timeout is capped at 15 minutes, and defaults to 3', () => {
    expect(levelCallOf({ ...CALL, timeoutMs: 10 ** 9 })).toMatchObject({ timeoutMs: 15 * 60 * 1000 });
    expect(levelCallOf(CALL)).toMatchObject({ timeoutMs: 180_000 });
  });
});
