// claude-plan on a client target (issue #366, design.md "Usage and accounts (issue #18)"): the hopper
// cannot run a command there, so the client runs its own claude for the two read-only calls of a usage
// read (`POST /claude`), signed like every call on its link. The client is real; claude is the fake.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintToken } from '../../src/client/signature.ts';
import type { UsageSource } from '../../src/domain/ports.ts';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import { parseOptions } from '../../src/plugins/options.ts';
import claudePlan from '../../src/plugins/usage-source/claude-plan/index.ts';
import { startTestClient, type TestClient } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';
import { useTempDirs } from './support.ts';

const BIN = join(import.meta.dirname, 'fake-claude-plan.mjs');

describe('claude-plan on a client target (issue #366)', () => {
  const temp = useTempDirs();
  const TOKEN = mintToken();
  let control: string;
  let scratch: string;
  let tc: TestClient | undefined;
  const sources: UsageSource[] = [];
  const saved = { plan: process.env.FAKE_PLAN_DIR, herdr: process.env.FAKE_HERDR_DIR };
  const STUDIO: MachineSnapshot = { id: 'studio', label: 'studio', maxLanes: 1, online: true, executors: ['herdr-claude'], client: {} };

  beforeEach(() => {
    control = temp();
    scratch = join(temp(), 'plugin-data', 'claude-plan');
    mkdirSync(scratch, { recursive: true });
    process.env.FAKE_PLAN_DIR = control;
    process.env.FAKE_HERDR_DIR = temp();
  });
  afterEach(async () => {
    for (const s of sources.splice(0)) s.stop?.();
    await tc?.stop();
    tc = undefined;
    for (const [k, v] of [['FAKE_PLAN_DIR', saved.plan], ['FAKE_HERDR_DIR', saved.herdr]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  type SignIn = { variable: string; value: string } | { none: true } | { refused: string };
  async function create(client: () => TestClient | undefined, agentSignIn?: (machine: string) => Promise<SignIn>): Promise<UsageSource> {
    const ctx = {
      ...(agentSignIn ? { agentSignIn } : {}),
      clock: { now: () => new Date('2026-10-03T17:00:00.000Z') }, logger: { info() {}, warn() {} }, dataDir: scratch, userEnv: {}, secretName: (n: string) => n, scratchDir: scratch,
      instanceName: 'studio-claude', env: () => undefined,
      machine: async (id: string) => (id === 'studio' ? STUDIO : undefined), machines: async () => [STUDIO],
      client: (id: string) => (id === 'studio' ? client()?.transport(TOKEN, 'studio') : undefined),
    };
    // `bin` names the hopper's claude; a client target runs its own (the client's claudeBin).
    const p = parseOptions(claudePlan, { bin: '/nonexistent/claude', machine: 'studio' });
    if (!p.ok) throw new Error(p.error);
    const s = await claudePlan.create(ctx, p.options as never);
    sources.push(s);
    return s;
  }

  it('reads usage and the account through the client, with the client\'s own claude; every reading is that machine\'s', async () => {
    tc = await startTestClient({ token: () => TOKEN, herdrBin: '/nonexistent/herdr', claudeBin: BIN, session: 'hopper' });
    const s = await create(() => tc);
    const readings = await waitFor(async () => { const r = await s.poll(); return r.length ? r : undefined; }, { what: 'readings' });
    expect(readings.map((r) => [r.window, r.used, r.machineId])).toEqual([['session', 80, 'studio'], ['week', 30, 'studio'], ['week (Fable)', 99, 'studio']]);
    await waitFor(() => s.state!().account, { what: 'account' });
    expect(s.state!().account).toEqual({ service: 'claude', identity: 'user@example.com', detail: { plan: 'max', organization: 'Example Org', authMethod: 'claude.ai', machine: 'studio' } });
    // On the client: a fresh private dir, removed with the project dir claude keeps for it.
    const ran = readFileSync(join(control, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; cwd: string });
    expect(ran.map((c) => c.argv)).toEqual([['-p', '/usage', '--output-format', 'json', '--no-session-persistence'], ['auth', 'status', '--json']]);
    for (const c of ran) {
      expect(c.cwd.startsWith(scratch)).toBe(false);
      expect(existsSync(c.cwd)).toBe(false);
      expect(existsSync(join(homedir(), '.claude', 'projects', c.cwd.replace(/[^A-Za-z0-9]/g, '-')))).toBe(false);
    }
  });

  it('a client not dialled in: no readings, the reason, and read again 30 s later like any machine not ready', async () => {
    const s = await create(() => undefined);
    await waitFor(() => (s.state!().problem !== 'not read yet' ? true : undefined), { what: 'the first read' });
    expect(await s.poll()).toEqual([]);
    expect(s.state!().problem).toMatch(/^machine studio: .*not dialled in/);
  });

  // Issue #1287, design.md "The agent's sign-in in a lane pod": a lane pod keeps no sign-in of its own; its jobs start
  // with the user's setup token. Its usage read takes the same token, else it reads the pod signed out and holds its jobs.
  const SETUP_TOKEN = 'sk-ant-oat01-usage-read-0123456789abcdef';

  it('a lane pod: the read runs with the user\'s token, so a pod with no sign-in of its own reads signed in', async () => {
    writeFileSync(join(control, 'mode'), 'token-only');
    tc = await startTestClient({ token: () => TOKEN, herdrBin: '/nonexistent/herdr', claudeBin: BIN, session: 'hopper' });
    const asked: string[] = [];
    const s = await create(() => tc, async (machine) => { asked.push(machine); return { variable: 'CLAUDE_CODE_OAUTH_TOKEN', value: SETUP_TOKEN }; });
    const readings = await waitFor(async () => { const r = await s.poll(); return r.length ? r : undefined; }, { what: 'readings' });
    expect(readings.map((r) => [r.window, r.used])).toEqual([['session', 80], ['week', 30], ['week (Fable)', 99]]);
    await waitFor(() => s.state!().account, { what: 'account' });
    expect(s.state!().account).toEqual({ service: 'claude', detail: { authMethod: 'oauth_token', machine: 'studio' } });
    expect(s.state!().problem).toBeUndefined();
    const ran = readFileSync(join(control, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { token?: boolean });
    expect(ran.map((c) => c.token)).toEqual([true, true]);
    expect(asked).toEqual(['studio', 'studio']);
    expect(JSON.stringify(s.state!())).not.toContain(SETUP_TOKEN);
  });

  it('a machine with no token to give reads with its own sign-in, as before', async () => {
    tc = await startTestClient({ token: () => TOKEN, herdrBin: '/nonexistent/herdr', claudeBin: BIN, session: 'hopper' });
    const s = await create(() => tc, async () => ({ none: true }));
    await waitFor(() => s.state!().account, { what: 'account' });
    expect(s.state!().account).toMatchObject({ identity: 'user@example.com' });
    const ran = readFileSync(join(control, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { token?: boolean });
    expect(ran.map((c) => c.token)).toEqual([undefined, undefined]);
  });

  it('a token the vault refuses: no claude runs, and the read says why', async () => {
    tc = await startTestClient({ token: () => TOKEN, herdrBin: '/nonexistent/herdr', claudeBin: BIN, session: 'hopper' });
    const s = await create(() => tc, async () => ({ refused: 'CLAUDE_TOKEN is not a Claude token' }));
    await waitFor(() => (s.state!().problem !== 'not read yet' ? true : undefined), { what: 'the first read' });
    expect(await s.poll()).toEqual([]);
    expect(s.state!().problem).toMatch(/the agent credential: CLAUDE_TOKEN is not a Claude token/);
    expect(existsSync(join(control, 'calls.jsonl'))).toBe(false);
  });
});
