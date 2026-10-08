// claude-plan on a client target (issue #366, design.md "Usage and accounts (issue #18)"): the hopper
// cannot run a command there, so the client runs its own claude for the two read-only calls of a usage
// read (`POST /claude`), signed like every call on its link. The client is real; claude is the fake.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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

  async function create(client: () => TestClient | undefined): Promise<UsageSource> {
    const ctx = {
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
});
