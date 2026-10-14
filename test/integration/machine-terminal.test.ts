// Issue #1128 part 6: a person reaches a machine's herdr session from the hopper — the machine's terminal —, not only a
// running job's pane: they list the panes of the hopper's herdr session there, the ones no job holds too, view one and
// type into it, over the machine's own connection. Admin only. Access (OpenFGA) decides each use; a terminal session is
// audited as events, which never carry what was typed. Real daemon over the fake herdr; OpenFGA is the double at its port.
//
// Feature: the machine's terminal
//   Scenario: a person views and types into a pane no job holds
//     Given a machine whose herdr session holds a pane no job holds, and a running job's pane
//     When a person lists the machine's panes
//     Then they see both, and the job's pane names its job
//     When they read the free pane and type into it
//     Then they see its screen, the text and the keys reach it, and the events say how much was typed, never what
//   Scenario: no terminal for an unknown machine or pane, an operator, or a use Access denies
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, MachineSnapshot } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient, type FakeTurn } from '../../src/executors/herdr/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeAuthorizationServer, type FakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { rawRequest } from '../support/http.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
  cleanup = undefined;
});

const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 60_000, promptSteadyMs: 100 } }];
const LONG: FakeTurn = { steps: Array.from({ length: 400 }, (_, i) => `● Checking port ${i + 1}`), output: ['  HOPPER_DONE'] };
const item = { executor: 'herdr-claude', prompt: 'Reach the service', cwd: '/tmp', env: {} };
const SECRET_TEXT = 'claude auth login';

interface Pane { paneId: string; tabId: string; title?: string; agent?: string; agentStatus: string; jobId?: string }
interface Screen { machineId: string; paneId: string; sessionId: string; screen: string; at: string }

async function boot(herdr: FakeHerdrClient, fga = createFakeAuthorizationServer()): Promise<{ a: TestApp; fga: FakeAuthorizationServer; machineId: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = await startTestApp({
    dbPath: db.dbPath, source: createManualSource(), plugins: { executors: EXECUTORS, machines: lanes(2) },
    seams: { herdr, levels: [], authorizationServer: fga },
  });
  apps.push(a);
  const machines = (await a.api<{ machines: MachineSnapshot[] }>('GET', '/api/machines', undefined, { 'x-hopper-session': await a.login() })).body.machines;
  return { a, fga, machineId: machines[0]!.id };
}

describe('the machine terminal', () => {
  it('a person lists a machine\'s panes, views one no job holds and types into it; the session is audited without the text', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [LONG] });
    const free = herdr.openPane({ title: 'my shell', lines: ['$ ls', 'notes.txt'] });
    const { a, machineId } = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'running', 8000);
    await waitFor(() => herdr.prompts.length === 1);

    const base = `/ui/api/machines/${encodeURIComponent(machineId)}/terminal`;
    const listed = await a.ui<{ machineId: string; panes: Pane[] }>(`${base}/panes`, {}, { token });
    expect(listed.status).toBe(200);
    expect(listed.body.panes).toContainEqual(expect.objectContaining({ paneId: free, title: 'my shell' }));
    expect(listed.body.panes.find((p) => p.paneId === free)!.jobId).toBeUndefined();
    expect(listed.body.panes).toContainEqual(expect.objectContaining({ jobId: job.id, agent: expect.any(String) }));

    const first = await a.ui<Screen>(`${base}/screen`, { paneId: free }, { token });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ machineId, paneId: free, sessionId: expect.any(String), at: expect.any(String) });
    expect(first.body.screen).toContain('notes.txt');
    const again = await a.ui<Screen>(`${base}/screen`, { paneId: free, lines: 50 }, { token });
    expect(again.body.sessionId).toBe(first.body.sessionId);

    const typed = await a.ui<{ sessionId: string }>(`${base}/input`, { paneId: free, text: SECRET_TEXT }, { token });
    expect(typed.status).toBe(200);
    expect(typed.body.sessionId).toBe(first.body.sessionId);
    expect((await a.ui(`${base}/input`, { paneId: free, keys: ['enter'] }, { token })).status).toBe(200);
    expect(herdr.texts).toContainEqual({ paneId: free, text: SECRET_TEXT });
    expect(herdr.keys.at(-1)).toEqual({ paneId: free, keys: ['enter'] });

    const events = (await a.events('limit=2000')).filter((e: DomainEvent) => e.type.startsWith('terminal.'));
    const opened = events.filter((e) => e.type === 'terminal.opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]!.jobId).toBeUndefined();
    expect(opened[0]!.data).toMatchObject({ sessionId: first.body.sessionId, via: 'ui', machineId, paneId: free });
    expect(events.filter((e) => e.type === 'terminal.typed').map((e) => e.data)).toEqual([
      { sessionId: first.body.sessionId, person: expect.any(String), via: 'ui', machineId, paneId: free, chars: SECRET_TEXT.length },
      { sessionId: first.body.sessionId, person: expect.any(String), via: 'ui', machineId, paneId: free, keys: ['enter'] },
    ]);
    expect(JSON.stringify(events)).not.toContain(SECRET_TEXT);

    // A pane a job holds, reached from the machine: its session is on that job's timeline too.
    const held = listed.body.panes.find((p) => p.jobId === job.id)!;
    expect((await a.ui(`${base}/screen`, { paneId: held.paneId }, { token })).status).toBe(200);
    const onJob = (await a.events('limit=2000')).filter((e) => e.type === 'terminal.opened' && e.jobId === job.id);
    expect(onJob).toHaveLength(1);
  });

  it('refuses an unknown machine or pane, a bad input, an operator, and a use Access denies', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test' });
    const free = herdr.openPane({ title: 'my shell', lines: ['$ '] });
    const { a, fga, machineId } = await boot(herdr);
    const token = await a.login();
    const base = `/ui/api/machines/${encodeURIComponent(machineId)}/terminal`;
    expect((await a.ui('/ui/api/machines/nope/terminal/panes', {}, { token })).status).toBe(404);
    expect((await a.ui(`${base}/screen`, { paneId: 'w9:p9' }, { token })).status).toBe(409);
    expect((await a.ui(`${base}/input`, { paneId: free }, { token })).status).toBe(400);
    expect((await a.ui(`${base}/input`, { paneId: free, keys: ['rm -rf'] }, { token })).status).toBe(400);

    // An operator's token, every scope and a box grant: the machine's terminal is an admin's.
    const minted = await a.ui<{ token: string }>('/ui/api/api-tokens', { action: 'mint', label: 'operator', role: 'operator', box: true, scopes: ['*'] }, { token });
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    const asOperator = await rawRequest(a.url, { method: 'POST', path: `${base}/screen`, headers: { authorization: `Bearer ${minted.body.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ paneId: free }) });
    expect(asOperator.status).toBe(403);

    fga.reachable = false;
    const denied = await a.ui<{ error: string }>(`${base}/screen`, { paneId: free }, { token });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).toContain('OpenFGA');
    expect((await a.ui(`${base}/input`, { paneId: free, text: 'hi' }, { token })).status).toBe(403);
    expect(herdr.texts.map((t) => t.text)).not.toContain('hi');
  });
});
