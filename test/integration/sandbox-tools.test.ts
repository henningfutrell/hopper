// Issue #716, item 2, through the real composition root and the real HTTP server: a box's tools are assembled per run.
// A template names the tools its boxes get, as part of what a person approves with its image; a launch gets them, or
// names fewer. The hopper builds the image — the template's image with those tools added — through the container
// runtime, once per base image and set of tools, and the box runs it. The container runtime is a double at its port
// (test/support/fake-container-runtime.ts); the real build is test/adapters/podman-runtime.test.ts.
//
// Feature: tools assembled per run
//   Scenario: a box of a template with tools runs the image the hopper builds from the template's image
//     Given a template kube with image example.org/kube-box:1 and tools kubectl and helm, approved
//     When an admin launches a box of it
//     Then the hopper builds an image from example.org/kube-box:1 with kubectl and helm, and the box runs it
//     And the box's record keeps the tools
//     When a second box of it is launched with only kubectl
//     Then the hopper builds the image with kubectl alone; a third launch with the same tools builds nothing
//   Scenario: a change of tools waits for a person, as a change of image does
//   Scenario: a tool the template does not add, or one the hopper does not know, is refused, and nothing starts
//   Scenario: a box of no template may name tools: they are added to the published box image
//   Scenario: a build that fails starts nothing and leaves nothing
import { afterEach, describe, expect, it } from 'vitest';
import type { VaultView } from '../../src/domain/types.ts';
import { TOOLS_IMAGE } from '../../src/sandbox/tools.ts';
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
const KUBE_IMAGE = 'example.org/kube-box:1';
const BOX_IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';

async function boot(runtime: FakeContainerRuntime): Promise<{ a: TestApp; session: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  t = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: PLUGINS, seams: { containerRuntime: runtime } });
  return { a: t, session: await t.login() };
}

interface Box { name: string; image: string; params: { tools?: string[] } }
const boxes = async (a: TestApp, session: string): Promise<Box[]> => ((await a.api('GET', '/api/sandboxes', undefined, { 'x-hopper-session': session })).body as { boxes: Box[] }).boxes;
const launch = (a: TestApp, session: string, body: unknown) => a.ui<{ container: string; error: string }>('/ui/api/machines/sandbox', body, { token: session });
const vault = (a: TestApp, session: string, body: unknown) => a.ui<{ error: string }>('/ui/api/vault', body, { token: session });
const template = async (a: TestApp, session: string) => (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': session })).body.templates.find((x) => x.name === 'kube')!;

async function kube(a: TestApp, session: string, tools: string[]): Promise<void> {
  expect((await vault(a, session, { action: 'save-template', name: 'kube', image: KUBE_IMAGE, secrets: [], tools })).status).toBe(200);
  expect((await vault(a, session, { action: 'approve-template', name: 'kube' })).status).toBe(200);
}

/** The Containerfile of the image a box runs. */
const containerfileOf = (runtime: FakeContainerRuntime, box: string): string => runtime.images.get(runtime.boxes.get(box)!.spec.image)!;

describe('tools assembled per run (issue #716)', () => {
  it('a box of a template with tools runs the image the hopper builds from the template\'s image', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await boot(runtime);
    await kube(a, session, ['kubectl', 'helm']);
    expect(await template(a, session)).toMatchObject({ tools: ['helm', 'kubectl'], approval: { image: KUBE_IMAGE, tools: ['helm', 'kubectl'] }, pending: { image: false } });

    expect((await launch(a, session, { template: 'kube' })).status).toBe(200);
    const image = runtime.boxes.get('hopper-sandbox-kube')!.spec.image;
    expect(image.startsWith(`${TOOLS_IMAGE}:`)).toBe(true);
    const both = containerfileOf(runtime, 'hopper-sandbox-kube');
    expect(both).toContain(`FROM ${KUBE_IMAGE}\n`);
    expect(both).toContain('io.hopper.tools="helm kubectl"');
    expect((await boxes(a, session))[0]).toMatchObject({ name: 'hopper-sandbox-kube', image, params: { tools: ['helm', 'kubectl'] } });

    expect((await launch(a, session, { template: 'kube', params: { tools: ['kubectl'] } })).status).toBe(200);
    expect(containerfileOf(runtime, 'hopper-sandbox-kube-2')).toContain('io.hopper.tools="kubectl"');
    expect(runtime.builds).toBe(2);
    expect((await launch(a, session, { template: 'kube', params: { tools: ['kubectl'] } })).status).toBe(200);
    expect(runtime.builds).toBe(2);
    expect(runtime.boxes.get('hopper-sandbox-kube-3')!.spec.image).toBe(runtime.boxes.get('hopper-sandbox-kube-2')!.spec.image);
  });

  it('a change of tools waits for a person, as a change of image does', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await boot(runtime);
    await kube(a, session, ['kubectl']);
    expect((await vault(a, session, { action: 'save-template', name: 'kube', image: KUBE_IMAGE, secrets: [], tools: ['kubectl', 'aws'] })).status).toBe(200);
    expect((await template(a, session)).pending.image).toBe(true);
    const refused = await launch(a, session, { template: 'kube' });
    expect(refused.status).toBe(409);
    expect(runtime.boxes.size).toBe(0);

    // A save that names no tools keeps the ones it has.
    expect((await vault(a, session, { action: 'save-template', name: 'kube', image: KUBE_IMAGE, secrets: [] })).status).toBe(200);
    expect((await template(a, session)).tools).toEqual(['aws', 'kubectl']);
    expect((await vault(a, session, { action: 'approve-template', name: 'kube' })).status).toBe(200);
    expect((await launch(a, session, { template: 'kube' })).status).toBe(200);
    expect(containerfileOf(runtime, 'hopper-sandbox-kube')).toContain('io.hopper.tools="aws kubectl"');
    const events = (await a.events()).filter((e) => e.type === 'template.saved' || e.type === 'vault.approved').map((e) => e.data as { tools?: string[] });
    expect(events.at(-1)).toMatchObject({ tools: ['aws', 'kubectl'] });
  });

  it('a tool the template does not add, or one the hopper does not know, is refused, and nothing starts', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await boot(runtime);
    await kube(a, session, ['kubectl']);
    const r = await launch(a, session, { template: 'kube', params: { tools: ['terraform'] } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('the template kube does not add terraform: it adds kubectl');
    const bad = await vault(a, session, { action: 'save-template', name: 'kube', image: KUBE_IMAGE, secrets: [], tools: ['nmap'] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('nmap is not a tool the hopper adds to a box: it adds aws, helm, kubectl, terraform');
    expect(runtime.boxes.size).toBe(0);
    expect(runtime.builds).toBe(0);
  });

  it('a box of no template may name tools: they are added to the published box image', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await boot(runtime);
    expect((await launch(a, session, { params: { tools: ['terraform'] } })).status).toBe(200);
    expect(containerfileOf(runtime, 'hopper-sandbox-claude')).toContain(`FROM ${BOX_IMAGE}\n`);
    expect((await launch(a, session, {})).status).toBe(200);
    expect(runtime.boxes.get('hopper-sandbox-claude-2')!.spec.image).toBe(BOX_IMAGE);
  });

  it('a build that fails starts nothing and leaves nothing', async () => {
    const runtime = createFakeContainerRuntime();
    runtime.buildFails = 'sha256sum: WARNING: 1 computed checksum did NOT match';
    const { a, session } = await boot(runtime);
    const r = await launch(a, session, { params: { tools: ['kubectl'] } });
    expect(r.status).toBe(502);
    expect(r.body.error).toContain('did NOT match');
    expect(runtime.boxes.size).toBe(0);
    expect(runtime.volumes.size).toBe(0);
    expect(await boxes(a, session)).toEqual([]);
  });
});
