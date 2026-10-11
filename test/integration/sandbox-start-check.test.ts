// Issue #708 part 3, through the real composition root and the real HTTP server: the start check of a sandbox box. It
// is the box's health check, run in the box; here the runtime double (test/support/fake-container-runtime.ts) runs it
// as a real fetch of the test hopper at the box's address. The real one: test/adapters/podman-sandbox.test.ts.
//
// Feature: a sandbox box proves it reaches the hopper, from inside
//   Scenario: a box that cannot reach the hopper from inside does not start, and says why: nothing is left
//   Scenario: a box that loses the hopper is unreachable, not ready, until its start check passes again
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { KEY } from '../support/webhooks.ts';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

const PLUGINS = { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['test'] } };

async function boot(runtime: FakeContainerRuntime): Promise<{ a: TestApp; session: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  t = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: PLUGINS, seams: { containerRuntime: runtime, startCheckMs: 1000 } });
  return { a: t, session: await t.login() };
}

interface Box { name: string; state: string; check?: { passed: boolean; at: string; output?: string } }
const view = async (a: TestApp, session: string): Promise<{ boxes: Box[] }> => (await a.api('GET', '/api/sandboxes', undefined, { 'x-hopper-session': session })).body as { boxes: Box[] };
const launch = (a: TestApp, session: string, body: unknown) => a.ui<{ container: string; error: string }>('/ui/api/machines/sandbox', body, { token: session });

/** The box's client: joins with the line the hopper put in the box's environment. */
async function boxJoins(runtime: FakeContainerRuntime, name: string): Promise<void> {
  const { HOPPER_JOIN: line, HOPPER_CLIENT_NAME: client } = runtime.boxes.get(name)!.spec.env;
  const dir = mkdtempSync(join(tmpdir(), 'hopper-box-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await joinHopper({ line: line!, name: client!, dir });
}

/** Two checks: a box is removed only when it is found with no machine twice in a row. */
async function reconcile(a: TestApp): Promise<void> {
  await a.app.sandboxes.reconcile();
  await a.app.sandboxes.reconcile();
}

describe('the start check of a sandbox box', () => {
  it('a box that cannot reach the hopper from inside does not start, and says why: nothing is left', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await boot(runtime);
    runtime.unreachable = "curl: (6) Could not resolve host: hopper";
    const r = await launch(a, session, {});
    expect(r.status).toBe(502);
    expect(r.body.error).toBe(`the sandbox box did not start: from inside the box hopper-sandbox-claude, the hopper does not answer at ${a.url}: curl: (6) Could not resolve host: hopper`);
    expect(runtime.boxes.size).toBe(0);
    expect(runtime.volumes.size).toBe(0);
    expect((await view(a, session)).boxes).toEqual([]);
  });

  it('a box that loses the hopper is unreachable, not ready, until its start check passes again', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await boot(runtime);
    await launch(a, session, {});
    await boxJoins(runtime, 'hopper-sandbox-claude');
    await reconcile(a);
    expect((await view(a, session)).boxes.map((b) => b.state)).toEqual(['ready']);

    // Every reconcile pass runs the check again, in the box.
    runtime.unreachable = 'curl: (7) Failed to connect to hopper port 4790';
    await a.app.sandboxes.reconcile();
    const lost = (await view(a, session)).boxes[0]!;
    expect(lost.state).toBe('unreachable');
    expect(lost.check).toEqual({ passed: false, at: expect.any(String), output: 'curl: (7) Failed to connect to hopper port 4790' });
    // It is not idle: its machine still names it, so it stays, and says why it is not ready.
    await reconcile(a);
    expect(runtime.boxes.has('hopper-sandbox-claude')).toBe(true);

    runtime.unreachable = undefined;
    await a.app.sandboxes.reconcile();
    expect((await view(a, session)).boxes.map((b) => [b.state, b.check?.passed])).toEqual([['ready', true]]);
  });
});
