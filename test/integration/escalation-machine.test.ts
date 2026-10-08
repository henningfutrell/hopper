// Issue #442: an escalation level that names no machine. The real claude-cli level against a fake
// `claude`, the real HTTP server and database: a question is answered on the one machine that can run
// claude, and its trail says which and why; with none, Settings says so in plain words, never an
// options-validation text; the default escalation machine is set, followed and guarded like a machine
// option.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NO_MACHINE_FOR_LEVEL } from '../../src/domain/machine-pick.ts';
import type { PluginsReport } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { readConfig } from '../support/files.ts';

const FAKE_CLAUDE = join(import.meta.dirname, '..', 'plugins', 'fake-claude.mjs');
const KEYS = ['FAKE_CLAUDE_OUT', 'FAKE_CLAUDE_STRUCTURED', 'FAKE_CLAUDE_MODE'] as const;
const saved: Record<string, string | undefined> = {};

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.FAKE_CLAUDE_OUT = join(mkdtempSync(join(tmpdir(), 'jh-claude-')), 'rec.json');
  process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify({ answer: 'use sqlite', escalate: false, reason: 'routine' });
  delete process.env.FAKE_CLAUDE_MODE;
});
afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

/** A claude-cli level that names no machine, as a fresh store writes it. */
const UNNAMED = [{ name: 'level-1', plugin: 'claude-cli', options: { bin: FAKE_CLAUDE, model: 'opus', timeoutMs: 10_000 } }];

async function start(plugins: Record<string, unknown>): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins, realLevels: true, seams: { machineProbe: async () => ({ online: false }) } });
  return t;
}

const report = async (a: TestApp): Promise<PluginsReport> => (await a.api<PluginsReport>('GET', '/api/plugins')).body;
type Reply = PluginsReport & { error: string };

describe('a level that names no machine (#442)', () => {
  it('no question rules, one machine that can run claude: the question is answered on it, and the trail names it and why', async () => {
    const a = await start({ machines: lanes(2), escalationLevels: UNNAMED });
    const job = await a.pull({ op: 'ask', message: 'Which database?' }, { title: 'pick a db' });
    const done = await a.waitForStatus(job.id, 'finished');
    expect(done.result).toEqual({ answer: 'use sqlite' });
    const [q] = await a.questionsOf(job.id);
    expect(q).toMatchObject({ status: 'answered', answeredBy: 'level-1' });
    expect(q!.attempts).toEqual([expect.objectContaining({
      tier: 'level-1', outcome: 'accepted', machine: { id: 'local', why: 'the job\'s machine' }, reason: 'routine (no rules yet)',
    })]);
    // Settings: the level runs; which machine it uses is said, nothing flagged.
    const level = (await report(a)).escalationLevels[0]!;
    expect(level).toMatchObject({ active: 'claude-cli', machine: { machine: 'local', needsMachine: false } });
  });

  it('no question rules, no machine that can run claude: Settings says so in plain words, never an options-validation text', async () => {
    const a = await start({ machines: [], escalationLevels: UNNAMED });
    const level = (await report(a)).escalationLevels[0]!;
    expect(level.active).toBe('claude-cli');
    expect(level.reason).toBeUndefined();
    expect(level.machine).toEqual({ needsMachine: true, note: NO_MACHINE_FOR_LEVEL });
    expect(JSON.stringify(level)).not.toMatch(/invalid options|expected string/);
  });
});

describe('the default escalation machine (#442)', () => {
  const TWO = [...lanes(2), { name: 'desk', plugin: 'ssh', options: { ssh: 'desk', lanes: 1, executors: ['test'] } }];

  it('is set from Settings to a configured machine, and a level that names none is no longer flagged', async () => {
    const a = await start({ machines: TWO, escalationLevels: UNNAMED });
    const token = await a.login();
    expect((await report(a)).escalationLevels[0]!.machine).toMatchObject({ needsMachine: true });
    const unknown = await a.ui<Reply>('/ui/api/plugins', { action: 'escalation-machine', machine: 'nowhere', version: (await report(a)).config.version }, { token });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/machine nowhere is not a configured machine: pick one of local, desk/);
    const set = await a.ui<Reply>('/ui/api/plugins', { action: 'escalation-machine', machine: 'desk', version: (await report(a)).config.version }, { token });
    expect(set.status).toBe(200);
    expect((readConfig(a.dbPath, 'plugins') as { escalationMachine?: string }).escalationMachine).toBe('desk');
    expect(set.body.escalationMachine).toBe('desk');
    expect(set.body.escalationLevels[0]!.machine).toMatchObject({ needsMachine: false, note: expect.stringMatching(/desk, the default escalation machine/) });
    const cleared = await a.ui<Reply>('/ui/api/plugins', { action: 'escalation-machine', machine: null, version: set.body.config.version }, { token });
    expect(cleared.status).toBe(200);
    expect((readConfig(a.dbPath, 'plugins') as { escalationMachine?: string }).escalationMachine).toBeUndefined();
  });

  it('the machine it names is not removed while it does, and a rename follows', async () => {
    const a = await start({ machines: TWO, escalationLevels: UNNAMED, escalationMachine: 'desk' });
    const token = await a.login();
    const removed = await a.ui<Reply>('/ui/api/plugins', { action: 'remove', role: 'machine-source', name: 'desk', version: (await report(a)).config.version }, { token });
    expect(removed.status).toBe(409);
    expect(removed.body.error).toMatch(/the default escalation machine/);
    const renamed = await a.ui<Reply>('/ui/api/plugins', { action: 'options', role: 'machine-source', name: 'desk', rename: 'study', options: { ssh: 'desk', lanes: 1, executors: ['test'] }, version: (await report(a)).config.version }, { token });
    expect(renamed.status).toBe(200);
    expect((readConfig(a.dbPath, 'plugins') as { escalationMachine?: string }).escalationMachine).toBe('study');
  });
});
