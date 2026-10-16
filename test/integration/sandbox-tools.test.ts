// Issue #716, item 2, through the real composition root and the real HTTP server: a template names the tools its
// sandboxes get, as part of what a person approves with its image. A step's sandbox runs the template's image with those
// tools added (the build: test/sandbox/tools.test.ts; a check box with tools: test/integration/read-only-check.test.ts).
//
// Feature: a template's tools
//   Scenario: a change of tools waits for a person, as a change of image does; a save that names no tools keeps them
//   Scenario: a tool the hopper does not know is refused at the save
import { afterEach, describe, expect, it } from 'vitest';
import type { VaultView } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { KEY } from '../support/webhooks.ts';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

const PLUGINS = { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['test'] } };
const KUBE_IMAGE = 'example.org/kube-box:1';

async function boot(): Promise<{ a: TestApp; session: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  t = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: PLUGINS, seams: { containerRuntime: createFakeContainerRuntime() } });
  return { a: t, session: await t.login() };
}

const vault = (a: TestApp, session: string, body: unknown) => a.ui<{ error: string }>('/ui/api/vault', body, { token: session });
const template = async (a: TestApp, session: string) => (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': session })).body.templates.find((x) => x.name === 'kube')!;

describe('a template\'s tools (issue #716)', () => {
  it('a change of tools waits for a person, as a change of image does; a save that names no tools keeps them', async () => {
    const { a, session } = await boot();
    expect((await vault(a, session, { action: 'save-template', name: 'kube', image: KUBE_IMAGE, secrets: [], tools: ['kubectl'] })).status).toBe(200);
    expect((await vault(a, session, { action: 'approve-template', name: 'kube' })).status).toBe(200);
    expect((await vault(a, session, { action: 'save-template', name: 'kube', image: KUBE_IMAGE, secrets: [], tools: ['kubectl', 'aws'] })).status).toBe(200);
    expect((await template(a, session)).pending.image).toBe(true);

    expect((await vault(a, session, { action: 'save-template', name: 'kube', image: KUBE_IMAGE, secrets: [] })).status).toBe(200);
    expect((await template(a, session)).tools).toEqual(['aws', 'kubectl']);
    expect((await vault(a, session, { action: 'approve-template', name: 'kube' })).status).toBe(200);
    expect((await template(a, session)).pending.image).toBe(false);
    const events = (await a.events()).filter((e) => e.type === 'template.saved' || e.type === 'vault.approved').map((e) => e.data as { tools?: string[] });
    expect(events.at(-1)).toMatchObject({ tools: ['aws', 'kubectl'] });
  });

  it('a tool the hopper does not know is refused at the save', async () => {
    const { a, session } = await boot();
    const r = await vault(a, session, { action: 'save-template', name: 'kube', image: KUBE_IMAGE, secrets: [], tools: ['nmap'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('nmap is not a tool the hopper adds');
  });
});
