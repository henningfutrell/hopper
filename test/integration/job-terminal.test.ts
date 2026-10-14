// Issue #1128 part 4: a person views a running job's herdr pane from the hopper and types into it — the job's terminal —
// through the job's own machine connection, with no terminal on that machine. Access (OpenFGA) decides each use; a
// terminal session is audited as events on the job's timeline, which never carry what was typed. Real daemon over the
// fake herdr; OpenFGA is the double at its port.
//
// Feature: the job's terminal
//   Scenario: a person views and types into a running job's pane
//     Given a job that runs in a herdr pane
//     When a person reads its terminal
//     Then they see the pane's screen, and a terminal session opens on the job's timeline
//     When they type text and press keys
//     Then the text and the keys reach the pane, and the events say how much was typed, never what
//   Scenario: no terminal without a pane, a valid input or Access
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient, type FakeTurn } from '../../src/executors/herdr/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeAuthorizationServer, type FakeAuthorizationServer } from '../support/fake-authorization-server.ts';
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

interface Screen { jobId: string; sessionId: string; screen: string; at: string }

async function boot(herdr: FakeHerdrClient, fga = createFakeAuthorizationServer()): Promise<{ a: TestApp; fga: FakeAuthorizationServer }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = await startTestApp({
    dbPath: db.dbPath, source: createManualSource(), plugins: { executors: EXECUTORS, machines: lanes(2) },
    seams: { herdr, levels: [], authorizationServer: fga },
  });
  apps.push(a);
  return { a, fga };
}

const ofJob = async (a: TestApp, jobId: string): Promise<DomainEvent[]> => (await a.events('limit=2000')).filter((e) => e.jobId === jobId);

describe('the job terminal', () => {
  it('a person views a running job\'s pane and types into it; the session is on the job\'s timeline without the text', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [LONG] });
    const { a } = await boot(herdr);
    const token = await a.login();
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'running', 8000);
    await waitFor(() => herdr.prompts.length === 1);

    const first = await a.ui<Screen>(`/ui/api/jobs/${job.id}/terminal/screen`, {}, { token });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ jobId: job.id, sessionId: expect.any(String), at: expect.any(String) });
    expect(first.body.screen).toContain('● Checking port');
    const again = await a.ui<Screen>(`/ui/api/jobs/${job.id}/terminal/screen`, { lines: 50 }, { token });
    expect(again.body.sessionId).toBe(first.body.sessionId);

    const typed = await a.ui<{ sessionId: string }>(`/ui/api/jobs/${job.id}/terminal/input`, { text: SECRET_TEXT }, { token });
    expect(typed.status).toBe(200);
    expect(typed.body.sessionId).toBe(first.body.sessionId);
    const pressed = await a.ui(`/ui/api/jobs/${job.id}/terminal/input`, { keys: ['esc', 'enter'] }, { token });
    expect(pressed.status).toBe(200);
    expect(herdr.texts.map((t) => t.text)).toContain(SECRET_TEXT);
    expect(herdr.keys.at(-1)!.keys).toEqual(['esc', 'enter']);

    const events = await ofJob(a, job.id);
    const opened = events.filter((e) => e.type === 'terminal.opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]!.data).toMatchObject({ sessionId: first.body.sessionId, person: expect.any(String), via: 'ui' });
    const inputs = events.filter((e) => e.type === 'terminal.typed').map((e) => e.data);
    expect(inputs).toEqual([
      { sessionId: first.body.sessionId, person: expect.any(String), via: 'ui', chars: SECRET_TEXT.length },
      { sessionId: first.body.sessionId, person: expect.any(String), via: 'ui', keys: ['esc', 'enter'] },
    ]);
    expect(JSON.stringify(events)).not.toContain(SECRET_TEXT);
  });

  it('refuses a job with no pane, an input that is not one, a key herdr has no name for, and a use Access denies', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [LONG] });
    const { a, fga } = await boot(herdr);
    const token = await a.login();
    const paneless = await a.pull({ op: 'sleep', ms: 60_000 });
    await a.waitForStatus(paneless.id, 'running', 8000);
    expect((await a.ui(`/ui/api/jobs/${paneless.id}/terminal/screen`, {}, { token })).status).toBe(409);
    expect((await a.ui('/ui/api/jobs/nope/terminal/screen', {}, { token })).status).toBe(404);

    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'running', 8000);
    expect((await a.ui(`/ui/api/jobs/${job.id}/terminal/input`, {}, { token })).status).toBe(400);
    expect((await a.ui(`/ui/api/jobs/${job.id}/terminal/input`, { keys: ['rm -rf'] }, { token })).status).toBe(400);
    expect((await a.ui(`/ui/api/jobs/${job.id}/terminal/input`, { text: 'x'.repeat(4001) }, { token })).status).toBe(400);

    fga.reachable = false;
    const denied = await a.ui<{ error: string }>(`/ui/api/jobs/${job.id}/terminal/screen`, {}, { token });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).toContain('OpenFGA');
    expect((await a.ui(`/ui/api/jobs/${job.id}/terminal/input`, { text: 'hi' }, { token })).status).toBe(403);
    expect(herdr.texts.map((t) => t.text)).not.toContain('hi');
  });
});
