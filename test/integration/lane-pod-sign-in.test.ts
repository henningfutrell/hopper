// Issue #1287 through the real composition root and the real HTTP server: a lane pod's jobs start signed in from the
// user's vault, as a job pod's do, so a lane pod started again — with its volume or without it — asks for no sign-in, and
// no sign-in needs to be kept on its volume (design.md "The agent's sign-in in a lane pod").
//
// Feature: the agent's sign-in survives lane pod restarts
//   Scenario: a lane pod's job starts with the user's setup token, before and after the pod starts again
//     Given the user's vault secret CLAUDE_TOKEN, what `claude setup-token` printed
//     And a lane pod that joined with the lane pool key
//     When a job runs on it, the pod starts again with a new volume, and a second job runs on it
//     Then each job's pane starts with the token as CLAUDE_CODE_OAUTH_TOKEN
//     And no event or log line holds the token
//   Scenario: a machine that is no lane pod is given no token
//   Scenario: a vault secret that is no setup token fails a lane pod's job before its pane starts
//   Scenario: a usage source on a lane pod reads it signed in with the user's setup token, and holds none of its jobs
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { startLinkedClient } from '../../src/client/main.ts';
import type { Client } from '../../src/client/server.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const PLAN = fileURLToPath(new URL('../plugins/fake-claude-plan.mjs', import.meta.url));
const POOL_KEY = 'a1'.repeat(32);
const TOKEN = 'sk-ant-oat01-lane-sign-in-0123456789abcdef_never-in-a-log';
const DONE = { output: ['● Painted the shed blue.', '  HOPPER_DONE'] };

let t: TestApp | undefined;
const clients: Client[] = [];
const cleanups: (() => void)[] = [];
const saved = { ...process.env };
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  }
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop();
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
  vi.restoreAllMocks();
});

async function boot(herdr: FakeHerdrClient, usageSources: unknown[] = []): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY, HOPPER_LANE_POOL_KEY: POOL_KEY },
    plugins: { executors: [{ name: 'claude', plugin: 'herdr-claude' }], machines: [], machineDefaults: { lanes: 1, executors: ['claude'] }, usageSources },
    seams: { herdr, levels: [] },
  });
  return { a: t, token: await t.login() };
}

/** A pod's volume: where its client dir, with its link key and link, is kept. */
function volume(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hopper-lane-pod-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A machine joined with `code` under `name` on a new volume, dialled in; it stops at `stop()`. */
async function joined(a: TestApp, code: string, name: string, claudeBin?: string): Promise<Client> {
  const dir = volume();
  await joinHopper({ line: `${a.url}#${code}`, name, dir });
  const c = startLinkedClient({ dir, herdrBin: HERDR, ...(claudeBin ? { claudeBin } : {}), session: 'hopper', installDir: testInstallDir(), backoffMs: [50] });
  clients.push(c);
  const machines = async () => (await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[];
  await waitFor(async () => (await machines()).find((m) => m.id === name && m.online), { timeoutMs: 10_000, what: `${name} online` });
  return c;
}

const item = { executor: 'claude', prompt: 'Paint the shed', cwd: '/tmp', env: {} };
const tabEnvs = (herdr: FakeHerdrClient): Record<string, string>[] =>
  herdr.calls.filter((c) => c.method === 'createTab').map((c) => (c.args[0] as { env: Record<string, string> }).env);

describe('the agent\'s sign-in survives lane pod restarts (issue #1287)', () => {
  it('a lane pod\'s job starts with the user\'s setup token, before and after the pod starts again', { timeout: 90_000 }, async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE, DONE] });
    const { a, token } = await boot(herdr);
    expect((await a.ui('/ui/api/vault', { action: 'set', name: 'CLAUDE_TOKEN', value: `${TOKEN}\n` }, { token })).status).toBe(200);
    const first = await joined(a, POOL_KEY, 'hopper-lanes-0');
    const one = await a.pull({}, item);
    await a.waitForStatus(one.id, 'finished', 30_000);
    // The pod starts again, its volume lost: the same machine, joined again with the lane pool key.
    await first.stop();
    await joined(a, POOL_KEY, 'hopper-lanes-0');
    const two = await a.pull({}, { ...item, prompt: 'Paint the fence' });
    await a.waitForStatus(two.id, 'finished', 30_000);
    expect(tabEnvs(herdr).map((e) => e.CLAUDE_CODE_OAUTH_TOKEN)).toEqual([TOKEN, TOKEN]);
    const given = (await a.events()).filter((e) => e.type === 'vault.pod_credential_given');
    expect(given.map((e) => e.data)).toEqual([one, two].map((j) => ({ name: 'CLAUDE_TOKEN', pod: 'hopper-lanes-0', job: j.id })));
    expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(TOKEN);
    expect(logged.join('\n')).not.toContain(TOKEN);
  });

  it('a machine that is no lane pod is given no token', { timeout: 60_000 }, async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE] });
    const { a, token } = await boot(herdr);
    expect((await a.ui('/ui/api/vault', { action: 'set', name: 'CLAUDE_TOKEN', value: TOKEN }, { token })).status).toBe(200);
    const code = (await a.ui<{ code: string }>('/ui/api/machines/join', {}, { token })).body.code;
    await joined(a, code, 'laptop');
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'finished', 30_000);
    expect(tabEnvs(herdr).map((e) => e.CLAUDE_CODE_OAUTH_TOKEN)).toEqual([undefined]);
    expect((await a.events()).some((e) => e.type === 'vault.pod_credential_given')).toBe(false);
  });

  it('a vault secret that is no setup token fails a lane pod\'s job before its pane starts', { timeout: 60_000 }, async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE] });
    const { a, token } = await boot(herdr);
    const file = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-a-0123456789', refreshToken: 'sk-ant-ort01-r-0123456789' } });
    expect((await a.ui('/ui/api/vault', { action: 'set', name: 'CLAUDE_TOKEN', value: file }, { token })).status).toBe(200);
    await joined(a, POOL_KEY, 'hopper-lanes-0');
    const job = await a.pull({}, item);
    const failed = await a.waitForStatus(job.id, 'failed', 30_000);
    expect(failed.error).toMatch(/CLAUDE_TOKEN is not a Claude token: set it to what `claude setup-token` prints/);
    expect(herdr.prompts).toEqual([]);
  });

  it('a usage source on a lane pod reads it signed in with the user\'s setup token, and holds none of its jobs', { timeout: 60_000 }, async () => {
    const plan = volume();
    process.env.FAKE_PLAN_DIR = plan;
    writeFileSync(join(plan, 'mode'), 'token-only');
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE] });
    const { a, token } = await boot(herdr, [{ name: 'claude', plugin: 'claude-plan', options: { machine: 'hopper-lanes-0', executors: ['claude'] } }]);
    expect((await a.ui('/ui/api/vault', { action: 'set', name: 'CLAUDE_TOKEN', value: TOKEN }, { token })).status).toBe(200);
    await joined(a, POOL_KEY, 'hopper-lanes-0', PLAN);
    type Usage = { readings: { source: string; machineId?: string }[]; sources: { name: string; account?: { detail: Record<string, string> }; problem?: string }[] };
    const usage = await waitFor(async () => {
      const u = (await a.api<Usage>('GET', '/api/usage')).body;
      return u.readings.some((r) => r.source === 'claude') && u.sources[0]?.account ? u : undefined;
    }, { timeoutMs: 30_000, what: 'claude readings of the lane pod' });
    expect(usage.sources[0]!.account!.detail).toEqual({ authMethod: 'oauth_token', machine: 'hopper-lanes-0' });
    expect(usage.readings.filter((r) => r.source === 'claude').every((r) => r.machineId === 'hopper-lanes-0')).toBe(true);
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'finished', 30_000);
    expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(TOKEN);
    expect(logged.join('\n')).not.toContain(TOKEN);
  });
});
