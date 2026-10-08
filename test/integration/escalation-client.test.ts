// Issue #482 through the real composition root, the real HTTP server and a real joined client: a hopper in
// a container (HOPPER_LOCAL_MACHINE=false, so no `local` machine, issue #141) whose only machine is a client
// target. Its claude-cli levels run through the client, which runs its own claude (the fake), locked down.
//
// Feature: escalation on a client target
//   Scenario: both levels name the client
//     Given a container hopper whose only machine joined as a client
//     And two claude-cli levels that name it
//     When a job asks a question
//     Then the first level answers it through the client, and the job finishes with that answer
//   Scenario: the level names no machine
//     Then the client is picked, and the trail says which machine and why
//   Scenario: the client goes offline
//     Then Settings shows the level as unable to run, with the reason and how to fix it
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startLinkedClient } from '../../src/client/main.ts';
import { joinHopper } from '../../src/client/join.ts';
import type { Client } from '../../src/client/server.ts';
import type { PluginsReport } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const CLAUDE = fileURLToPath(new URL('../plugins/fake-claude.mjs', import.meta.url));

let t: TestApp | undefined;
const clients: Client[] = [];
const cleanups: (() => void)[] = [];
const saved = { ...process.env };

afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop();
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
});

const level = (name: string, model: string, machine?: string) => ({ name, plugin: 'claude-cli', options: { model, timeoutMs: 10_000, ...(machine ? { machine } : {}) } });

/** A container hopper with the levels given, and one machine joined to it as a client target, online. */
async function containerWithClient(levels: unknown[]): Promise<{ a: TestApp; client: Client }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const scratch = mkdtempSync(join(tmpdir(), 'jh-esc-client-'));
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
  process.env.FAKE_HERDR_DIR = scratch;
  process.env.FAKE_HERDR_RUNNING = '1';
  process.env.FAKE_CLAUDE_OUT = join(scratch, 'claude.json');
  process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify({ answer: 'use sqlite', escalate: false, reason: 'routine' });
  t = await startTestApp({
    dbPath: db.dbPath, env: { HOPPER_LOCAL_MACHINE: 'false' }, realLevels: true,
    plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 2, executors: ['test'] }, escalationLevels: levels },
  });
  const session = await t.login();
  const code = (await t.ui<{ code: string }>('/ui/api/machines/join', {}, { token: session })).body.code;
  const dir = mkdtempSync(join(tmpdir(), 'hopper-machine-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await joinHopper({ line: `${t.url}#${code}`, name: 'studio', dir });
  const client = startLinkedClient({ dir, herdrBin: HERDR, claudeBin: CLAUDE, session: 'hopper', installDir: testInstallDir(), backoffMs: [50] });
  clients.push(client);
  const a = t;
  await waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[]).find((m) => m.id === 'studio' && m.online), { timeoutMs: 10000, what: 'studio online' });
  return { a, client };
}

const report = async (a: TestApp): Promise<PluginsReport> => (await a.api<PluginsReport>('GET', '/api/plugins')).body;

describe('escalation on a client target, in a container hopper (#482)', () => {
  it('both levels name the client: the first answers through it, and the job finishes with that answer', async () => {
    const { a } = await containerWithClient([level('level-1', 'opus', 'studio'), level('level-2', 'fable', 'studio')]);
    const job = await a.pull({ op: 'ask', message: 'Which database?' }, { title: 'pick a db' });
    const done = await a.waitForStatus(job.id, 'finished', 20000);
    expect(done.result).toEqual({ answer: 'use sqlite' });
    const [q] = await a.questionsOf(job.id);
    expect(q).toMatchObject({ status: 'answered', answeredBy: 'level-1' });
    expect(q!.attempts).toEqual([expect.objectContaining({ tier: 'level-1', outcome: 'accepted', model: 'claude-opus-resolved' })]);
    expect(JSON.stringify(q!.attempts)).not.toMatch(/client target|herdr only/);
    const levels = (await report(a)).escalationLevels;
    expect(levels.map((l) => [l.instance.name, l.active, l.machine])).toEqual([['level-1', 'claude-cli', undefined], ['level-2', 'claude-cli', undefined]]);
  });

  it('the level names no machine: the client is picked, and the trail names it and why; Settings says it runs there', async () => {
    const { a } = await containerWithClient([level('level-1', 'opus')]);
    expect((await report(a)).escalationLevels[0]!.machine).toEqual({ machine: 'studio', needsMachine: false, note: 'names no machine: runs on studio, the only machine that can run claude' });
    const job = await a.pull({ op: 'ask', message: 'Which database?' }, { title: 'pick a db' });
    await a.waitForStatus(job.id, 'finished', 20000);
    const [q] = await a.questionsOf(job.id);
    expect(q!.attempts).toEqual([expect.objectContaining({ tier: 'level-1', outcome: 'accepted', machine: { id: 'studio', why: expect.any(String) } })]);
  });

  it('the client offline: Settings shows the level as unable to run, with the reason and how to fix it', async () => {
    const { a, client } = await containerWithClient([level('level-1', 'opus', 'studio')]);
    await client.stop();
    clients.splice(clients.indexOf(client), 1);
    const st = await waitFor(async () => {
      const l = (await report(a)).escalationLevels[0]!;
      return l.machine?.cannotRun ? l : undefined;
    }, { timeoutMs: 15000, what: 'the level shown as unable to run' });
    expect(st.machine).toEqual({ needsMachine: false, cannotRun: true, note: expect.stringMatching(/^machine studio is offline: questions skip this level until it is back.*hopper-client/) });
  });
});
