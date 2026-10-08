// The built-in usage source `claude-plan` (design.md "Usage and accounts (issue #18)"): Claude
// subscription usage from `claude -p /usage` (a local slash command: zero turns, zero tokens),
// refreshed in the background, and the account from `claude auth status`. The parser is pure;
// the plugin runs against a fake `claude` (fake-claude-plan.mjs), never the real one.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageSource } from '../../src/domain/ports.ts';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import { optionsJsonSchema, parseOptions } from '../../src/plugins/options.ts';
import claudePlan from '../../src/plugins/usage-source/claude-plan/index.ts';
import { parseAuthStatus, parseUsageEnvelope, parseUsageText, resetsAtOf } from '../../src/plugins/usage-source/claude-plan/parse.ts';
import { mintToken } from '../../src/client/signature.ts';
import { startTestClient, type TestClient } from '../support/client.ts';
import { testSshAuth } from '../support/ssh.ts';
import { waitFor } from '../support/wait.ts';
import { fakeKit, useTempDirs } from './support.ts';

const BIN = join(import.meta.dirname, 'fake-claude-plan.mjs');
const FAKE_SSH = join(import.meta.dirname, '..', 'herdr', 'fake-ssh-bin.mjs');
// 2026-08-08 12:00 in Chicago (CDT, UTC-5).
const AUG8_NOON = new Date('2026-08-08T17:00:00.000Z');

describe('claude-plan parser', () => {
  it('reads the three line shapes: the session, the week of all models, and a week of one model (informational)', () => {
    const text = [
      'You are currently using your subscription to power your Claude Code usage',
      '',
      'Current session: 1% used - resets Aug 8, 2:10pm (America/Chicago)',
      'Current week (Fable): 16% used - resets Aug 11, 12pm (America/Chicago)',
      'Current week (all models): 27% used - resets Aug 11, 12pm (America/Chicago)',
      '',
      "What's contributing to your limits usage?",
      '  68% of your usage came from subagent-heavy sessions',
    ].join('\n');
    expect(parseUsageText(text, AUG8_NOON)).toEqual([
      { window: 'session', used: 1, resetsAt: '2026-08-08T19:10:00.000Z' },
      { window: 'week', used: 27, resetsAt: '2026-08-11T17:00:00.000Z' },
      { window: 'week (Fable)', used: 16, resetsAt: '2026-08-11T17:00:00.000Z', informational: true },
    ]);
  });

  it('accepts the middle dot the current CLI prints, decimals, and a 24-hour time', () => {
    const text = 'Current session: 8.5% used · resets Aug 8, 14:30 (America/Chicago)\nCurrent week (all models): 12% used · resets Aug 11, 12pm (America/Chicago)';
    expect(parseUsageText(text, AUG8_NOON)).toEqual([
      { window: 'session', used: 8.5, resetsAt: '2026-08-08T19:30:00.000Z' },
      { window: 'week', used: 12, resetsAt: '2026-08-11T17:00:00.000Z' },
    ]);
  });

  it('a reset in January seen in December lands in the next year; an unknown time zone or no reset leaves resetsAt out', () => {
    expect(resetsAtOf('Jan 2, 9am (America/Chicago)', new Date('2026-12-30T12:00:00.000Z'))).toBe('2027-01-02T15:00:00.000Z');
    expect(resetsAtOf('Aug 11, 12pm (Not/AZone)', AUG8_NOON)).toBeUndefined();
    expect(parseUsageText('Current session: 3% used', AUG8_NOON)).toEqual([{ window: 'session', used: 3 }]);
  });

  it('a window it does not know is shown but informational: it never throttles on a guess', () => {
    expect(parseUsageText('Current month (Opus): 5% used · resets Sep 1, 12am (UTC)', AUG8_NOON)).toEqual([
      { window: 'month (Opus)', used: 5, resetsAt: '2026-09-01T00:00:00.000Z', informational: true },
    ]);
  });

  it('the envelope: its result text parsed; header-only, is_error, empty or not JSON → a problem, never readings', () => {
    const ok = JSON.stringify({ type: 'result', is_error: false, result: 'Current session: 4% used · resets Aug 8, 2:10pm (America/Chicago)' });
    expect(parseUsageEnvelope(ok, AUG8_NOON)).toEqual({ windows: [{ window: 'session', used: 4, resetsAt: '2026-08-08T19:10:00.000Z' }] });
    expect(parseUsageEnvelope(JSON.stringify({ is_error: false, result: 'You are currently using your subscription to power your Claude Code usage' }), AUG8_NOON))
      .toEqual({ problem: 'usage unavailable: You are currently using your subscription to power your Claude Code usage' });
    expect(parseUsageEnvelope(JSON.stringify({ is_error: true, result: 'Usage is not available right now' }), AUG8_NOON))
      .toEqual({ problem: 'usage unavailable: Usage is not available right now' });
    expect(parseUsageEnvelope(JSON.stringify({ is_error: false, result: '' }), AUG8_NOON)).toEqual({ problem: 'usage unavailable: empty result' });
    expect(parseUsageEnvelope('', AUG8_NOON)).toEqual({ problem: 'claude output is not JSON' });
    expect(parseUsageEnvelope('Error {', AUG8_NOON)).toEqual({ problem: 'claude output is not JSON' });
  });

  it('auth status: the email, plan, organisation and sign-in method — nothing else (no ids, no tokens)', () => {
    const json = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'h@example.com', orgId: 'o1', orgName: 'Org', subscriptionType: 'max', accessToken: 'sk-SECRET' });
    expect(parseAuthStatus(json)).toEqual({ service: 'claude', identity: 'h@example.com', detail: { plan: 'max', organization: 'Org', authMethod: 'claude.ai' } });
    expect(parseAuthStatus(JSON.stringify({ loggedIn: false }))).toEqual({ service: 'claude', detail: {}, problem: 'not logged in' });
    expect(parseAuthStatus('nope')).toEqual({ service: 'claude', detail: {}, problem: 'claude auth status: output is not JSON' });
  });
});

describe('claude-plan plugin', () => {
  const temp = useTempDirs();
  let control: string;
  let scratch: string;
  let now: Date;
  const sources: UsageSource[] = [];
  const saved = process.env.FAKE_PLAN_DIR;

  beforeEach(() => {
    control = temp();
    scratch = join(temp(), 'plugin-data', 'claude-plan');
    mkdirSync(scratch, { recursive: true });
    process.env.FAKE_PLAN_DIR = control;
    // Oct 3, 12:00 in Chicago: the fake's session resets at 12:15pm, its weeks on Oct 6.
    now = new Date('2026-10-03T17:00:00.000Z');
  });
  afterEach(() => {
    for (const s of sources.splice(0)) s.stop?.();
    if (saved === undefined) delete process.env.FAKE_PLAN_DIR; else process.env.FAKE_PLAN_DIR = saved;
  });

  /** This machine, the hopper's own: in the machine list like any other, named `local` (issue #174). */
  const LOCAL: MachineSnapshot = { id: 'local', label: 'local', maxLanes: 4, online: true, executors: ['herdr-claude'] };
  const ctx = () => ({ clock: { now: () => now }, logger: { info() {}, warn() {} }, dataDir: scratch, userEnv: {}, secretName: (n: string) => n, scratchDir: scratch, instanceName: 'claude', env: () => undefined, machine: async (id: string) => (id === 'local' ? LOCAL : undefined) });
  async function create(raw: Record<string, unknown> = {}): Promise<UsageSource> {
    const p = parseOptions(claudePlan, { bin: BIN, machine: 'local', ...raw });
    if (!p.ok) throw new Error(p.error);
    const s = await claudePlan.create(ctx(), p.options as never);
    sources.push(s);
    return s;
  }
  const calls = () => (existsSync(join(control, 'calls.jsonl')) ? readFileSync(join(control, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; cwd: string }) : []);

  it('is a usage source; options machine (required), bin (command-bearing, default claude), intervalSeconds (default 600, at least 120) and executors (default the built-in herdr-claude)', () => {
    expect(claudePlan).toMatchObject({ id: 'claude-plan', role: 'usage-source' });
    expect(parseOptions(claudePlan, {})).toEqual({ ok: false, error: expect.stringContaining('machine') });
    expect(parseOptions(claudePlan, { machine: 'local' })).toEqual({ ok: true, options: { machine: 'local', bin: 'claude', intervalSeconds: 600, sshBin: 'ssh', dockerBin: 'docker', executors: ['herdr-claude'] } });
    expect(parseOptions(claudePlan, { machine: 'local', executors: ['claude-big'] })).toMatchObject({ ok: true, options: { executors: ['claude-big'] } });
    expect(parseOptions(claudePlan, { machine: 'local', intervalSeconds: 60 }).ok).toBe(false);
    const schema = optionsJsonSchema(claudePlan) as { properties: Record<string, { commandBearing?: boolean; machine?: boolean }>; required?: string[] };
    expect(schema.properties.machine!.machine).toBe(true);
    expect(schema.required).toContain('machine');
    expect(schema.properties.bin!.commandBearing).toBe(true);
    expect(schema.properties.intervalSeconds!.commandBearing).toBeUndefined();
    expect(schema.properties.machine!.commandBearing).toBeUndefined();
    expect(schema.properties.sshBin!.commandBearing).toBe(true);
    expect(schema.properties.dockerBin!.commandBearing).toBe(true);
  });

  it('detection never calls claude nor looks for it: claude runs on the machine the source names, this one too (#174)', async () => {
    let ran = false;
    const kit = fakeKit({ which: async () => undefined, version: async () => { ran = true; return 'x'; }, succeeds: async () => { ran = true; return true; } });
    expect(await claudePlan.detect(kit, { bin: 'claude', intervalSeconds: 600, machine: 'laptop', sshBin: 'ssh', dockerBin: 'docker', executors: ['herdr-claude'] }))
      .toEqual({ status: 'available', detail: 'claude on machine laptop' });
    expect(ran).toBe(false);
  });

  it('poll never waits for claude: no readings and a reason until the first read lands, then every window as a % reading', async () => {
    writeFileSync(join(control, 'mode'), 'ok');
    const s = await create();
    expect(await s.poll()).toEqual([]);
    expect(s.state!()).toMatchObject({ problem: 'not read yet' });
    const readings = await waitFor(async () => { const r = await s.poll(); return r.length ? r : undefined; }, { what: 'readings' });
    const at = now.toISOString();
    expect(readings).toEqual([
      { source: 'claude', machineId: 'local', window: 'session', used: 80, limit: 100, unit: '%', resetsAt: '2026-10-03T17:15:00.000Z', executors: ['herdr-claude'], at },
      { source: 'claude', machineId: 'local', window: 'week', used: 30, limit: 100, unit: '%', resetsAt: '2026-10-06T17:00:00.000Z', executors: ['herdr-claude'], at },
      { source: 'claude', machineId: 'local', window: 'week (Fable)', used: 99, limit: 100, unit: '%', resetsAt: '2026-10-06T17:00:00.000Z', informational: true, executors: ['herdr-claude'], at },
    ]);
    await waitFor(() => s.state!().account, { what: 'account' });
    expect(s.state!()).toEqual({
      refreshedAt: at,
      account: { service: 'claude', identity: 'user@example.com', detail: { plan: 'max', organization: 'Example Org', authMethod: 'claude.ai', machine: 'local' } },
    });
    expect(JSON.stringify(s.state!())).not.toContain('SECRET');
  });

  it('runs `-p /usage` (no session persistence) and `auth status --json` in a private 0700 probe dir, and removes the project dir claude leaves', async () => {
    const s = await create();
    await waitFor(() => s.state!().account, { what: 'a refresh' });
    const probe = join(scratch, 'probe');
    expect(calls()).toEqual([
      { argv: ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'], cwd: probe },
      { argv: ['auth', 'status', '--json'], cwd: probe },
    ]);
    expect(statSync(probe).mode & 0o777).toBe(0o700);
    expect(existsSync(join(homedir(), '.claude', 'projects', probe.replace(/[^A-Za-z0-9]/g, '-')))).toBe(false);
  });

  it('claude failing: no readings, the reason in state; logged out: the account says so', async () => {
    writeFileSync(join(control, 'mode'), 'exit1');
    const s = await create();
    await waitFor(() => (s.state!().problem !== 'not read yet' ? true : undefined), { what: 'the first read' });
    expect(await s.poll()).toEqual([]);
    expect(s.state!().problem).toMatch(/^claude -p \/usage failed: .*not logged in/);

    writeFileSync(join(control, 'mode'), 'header-only');
    const t = await create();
    await waitFor(() => (t.state!().problem !== 'not read yet' ? true : undefined), { what: 'the first read' });
    expect(t.state!().problem).toBe('usage unavailable: You are currently using your subscription to power your Claude Code usage');

    writeFileSync(join(control, 'mode'), 'logged-out');
    const u = await create();
    await waitFor(() => u.state!().account, { what: 'the account' });
    expect(u.state!().account).toEqual({ service: 'claude', detail: { machine: 'local' }, problem: 'not logged in' });
  });

  it('a window past its reset is left out; readings older than 3 intervals are stale: none, and the reason', async () => {
    const s = await create();
    await waitFor(async () => ((await s.poll()).length ? true : undefined), { what: 'readings' });
    now = new Date('2026-10-03T17:20:00.000Z');
    expect((await s.poll()).map((r) => r.window)).toEqual(['week', 'week (Fable)']);
    now = new Date('2026-10-03T17:31:00.000Z');
    expect(await s.poll()).toEqual([]);
    expect(s.state!().problem).toBe('stale: last read 2026-10-03T17:00:00.000Z');
    expect(s.state!().refreshedAt).toBe('2026-10-03T17:00:00.000Z');
  });
});

describe('claude-plan on an attached machine (issue #139)', () => {
  const temp = useTempDirs();
  let control: string;
  let scratch: string;
  let ssh: string;
  const sources: UsageSource[] = [];
  const saved = { plan: process.env.FAKE_PLAN_DIR, herdr: process.env.FAKE_HERDR_DIR };
  let now = new Date('2026-10-03T17:00:00.000Z');
  const LAPTOP: MachineSnapshot = { id: 'laptop', label: 'laptop', maxLanes: 1, online: true, executors: ['herdr-claude'], ssh: 'laptop' };

  beforeEach(() => {
    control = temp();
    ssh = temp();
    scratch = join(temp(), 'plugin-data', 'claude-plan');
    mkdirSync(scratch, { recursive: true });
    process.env.FAKE_PLAN_DIR = control;
    process.env.FAKE_HERDR_DIR = ssh;
    now = new Date('2026-10-03T17:00:00.000Z');
  });
  afterEach(() => {
    for (const s of sources.splice(0)) s.stop?.();
    for (const [k, v] of [['FAKE_PLAN_DIR', saved.plan], ['FAKE_HERDR_DIR', saved.herdr]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  async function create(machines: MachineSnapshot[]): Promise<UsageSource> {
    const auth = testSshAuth(join(ssh, 'auth'))();
    const ctx = {
      clock: { now: () => now }, logger: { info() {}, warn() {} }, dataDir: scratch, userEnv: {}, secretName: (n: string) => n, scratchDir: scratch, instanceName: 'laptop-claude',
      env: (n: string) => (n === 'HOPPER_SSH_KEY_FILE' ? auth.identityFile : undefined),
      machine: async (id: string) => machines.find((m) => m.id === id),
    };
    const p = parseOptions(claudePlan, { bin: BIN, machine: 'laptop', sshBin: FAKE_SSH });
    if (!p.ok) throw new Error(p.error);
    const s = await claudePlan.create(ctx, p.options as never);
    sources.push(s);
    return s;
  }
  const sshCalls = () => readFileSync(join(ssh, 'ssh-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[] });

  it('reads usage and the account over the machine\'s connection; every reading is that machine\'s', async () => {
    const s = await create([LAPTOP]);
    const readings = await waitFor(async () => { const r = await s.poll(); return r.length ? r : undefined; }, { what: 'readings' });
    expect(readings.map((r) => [r.window, r.used, r.machineId])).toEqual([['session', 80, 'laptop'], ['week', 30, 'laptop'], ['week (Fable)', 99, 'laptop']]);
    await waitFor(() => s.state!().account, { what: 'account' });
    expect(s.state!().account).toEqual({ service: 'claude', identity: 'user@example.com', detail: { plan: 'max', organization: 'Example Org', authMethod: 'claude.ai', machine: 'laptop' } });
    const calls = sshCalls();
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.argv.slice(c.argv.indexOf('--') + 1, -1)).toEqual(['laptop.example']);
    // On the machine: a fresh private dir, removed with the project dir claude keeps for it.
    const ran = readFileSync(join(control, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; cwd: string });
    expect(ran.map((c) => c.argv)).toEqual([['-p', '/usage', '--output-format', 'json', '--no-session-persistence'], ['auth', 'status', '--json']]);
    for (const c of ran) {
      expect(existsSync(c.cwd)).toBe(false);
      expect(existsSync(join(homedir(), '.claude', 'projects', c.cwd.replace(/[^A-Za-z0-9]/g, '-')))).toBe(false);
    }
  });

  it('a machine not ready yet (offline at the first read, before its probe) is read again 30 s later, not an interval later', async () => {
    const machines = [{ ...LAPTOP, online: false }];
    const s = await create(machines);
    await waitFor(() => (s.state!().problem === 'machine laptop is offline' ? true : undefined), { what: 'the first read' });
    machines[0] = LAPTOP;
    expect(await s.poll()).toEqual([]);
    now = new Date(now.getTime() + 31_000);
    await s.poll();
    const readings = await waitFor(async () => { const r = await s.poll(); return r.length ? r : undefined; }, { what: 'readings after the retry' });
    expect(readings[0]).toMatchObject({ machineId: 'laptop', window: 'session' });
  });

  it('a machine not configured or offline: no readings, and the reason', async () => {
    const gone = await create([]);
    await waitFor(() => (gone.state!().problem !== 'not read yet' ? true : undefined), { what: 'the first read' });
    expect(await gone.poll()).toEqual([]);
    expect(gone.state!().problem).toBe('machine laptop is not configured');

    const offline = await create([{ ...LAPTOP, online: false }]);
    await waitFor(() => (offline.state!().problem !== 'not read yet' ? true : undefined), { what: 'the first read' });
    expect(offline.state!().problem).toBe('machine laptop is offline');
  });
});

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
      machine: async (id: string) => (id === 'studio' ? STUDIO : undefined),
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
