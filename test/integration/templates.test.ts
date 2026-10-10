// Issue #558, slice 2, through the real composition root and the real HTTP server: templates. A template is an
// image and the vault secrets its boxes may ask for. The scope comes only from the template, never from a job. A new
// template, or one whose scope widened or whose image changed, gives nothing until a person approves it once; what it
// gives is what was approved. A sandbox box's join line names its template, so the box joins as an instance of it
// (design.md "The vault").
//
// Feature: templates, approved once
//   Scenario: a new template is saved and gives nothing until a person approves it
//     Given the vault secrets KUBE_TOKEN and PROD_KEY
//     When an admin saves the template kube: an image, and KUBE_TOKEN
//     Then the vault lists kube as waiting for approval of KUBE_TOKEN, and its boxes may be given nothing
//     When an admin approves kube
//     Then its boxes may be given KUBE_TOKEN, and the approval is recorded: who, the image, the secrets
//   Scenario: widening the scope waits for a person again; what was approved still holds
//   Scenario: a new image waits for a person again, and gives nothing meanwhile
//   Scenario: narrowing needs no approval
//   Scenario: a template naming a secret the vault does not hold is refused
//   Scenario: a sandbox box joins with a line that names its template, and is an instance of it
//   Scenario: a template with an attached box is not removed; the answer names the box (issue #604)
//   Scenario: a join line whose template was removed is refused, and adds no machine
//   Scenario: a machine is not set to a template that does not exist
//
// Feature: template approval gates job placement (issue #602)
//   Scenario: a box of a template not approved takes no job until a person approves it; a revoke stops new jobs
//     Given the template kube, saved and not approved, and a box joined as kube
//     Then Machines shows the box waiting for template approval
//     When a job is queued
//     Then the hopper holds it, and its timeline says it waits for template approval
//     When an admin approves kube
//     Then the hopper places the job on the box
//     When an admin revokes the approval of kube
//     Then Machines shows the box waiting again, and the hopper places no new job on it
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { boxes } from '../support/vault-box.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
const saved = { ...process.env };
const box = boxes();

afterEach(async () => {
  await box.end();
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
});

async function boot(): Promise<{ a: TestApp; session: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  t = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_TOKEN_KEY: KEY }, plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } } });
  const session = await t.login();
  for (const name of ['KUBE_TOKEN', 'PROD_KEY']) await t.ui('/ui/api/vault', { action: 'set', name, value: `${name}-value-0123456789` }, { token: session });
  return { a: t, session };
}

type Template = { name: string; image: string; secrets: string[]; approval?: { image: string; secrets: string[]; by: string; at: string }; pending: { secrets: string[]; image: boolean }; gives: string[] };
const edit = (a: TestApp, session: string, body: Record<string, unknown>) => a.ui<{ templates: Template[]; error?: string }>('/ui/api/vault', body, { token: session });
/** A box joined as an instance of `template` (no client started: the config record is what is checked). */
async function joinBox(a: TestApp, session: string, name: string, template: string): Promise<void> {
  const code = (await a.ui<{ code: string }>('/ui/api/machines/join', { template }, { token: session })).body.code;
  const dir = mkdtempSync(join(tmpdir(), 'hopper-box-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await joinHopper({ line: `${a.url}#${code}`, name, dir });
}
const machineNames = async (a: TestApp): Promise<string[]> =>
  ((await a.api('GET', '/api/machines/config')).body as { machines: { name: string }[] }).machines.map((m) => m.name);
const template = async (a: TestApp, name: string): Promise<Template | undefined> =>
  ((await a.api('GET', '/api/vault')).body.templates as Template[]).find((x) => x.name === name);

describe('templates', () => {
  it('a new template gives nothing until a person approves it; then exactly what was approved', async () => {
    const { a, session } = await boot();
    const r = await edit(a, session, { action: 'save-template', name: 'kube', image: IMAGE, secrets: ['KUBE_TOKEN'] });
    expect(r.status).toBe(200);
    expect(await template(a, 'kube')).toMatchObject({ name: 'kube', image: IMAGE, secrets: ['KUBE_TOKEN'], pending: { secrets: ['KUBE_TOKEN'], image: true }, gives: [] });
    expect((await template(a, 'kube'))!.approval).toBeUndefined();

    expect((await edit(a, session, { action: 'approve-template', name: 'kube' })).status).toBe(200);
    const approved = (await template(a, 'kube'))!;
    expect(approved).toMatchObject({ pending: { secrets: [], image: false }, gives: ['KUBE_TOKEN'], approval: { image: IMAGE, secrets: ['KUBE_TOKEN'], by: expect.any(String), at: expect.any(String) } });
    const types = (await a.events()).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['template.saved', 'vault.approved']));
  });

  it('widening the scope waits for a person again; what was approved still holds meanwhile', async () => {
    const { a, session } = await boot();
    await edit(a, session, { action: 'save-template', name: 'kube', image: IMAGE, secrets: ['KUBE_TOKEN'] });
    await edit(a, session, { action: 'approve-template', name: 'kube' });
    await edit(a, session, { action: 'save-template', name: 'kube', image: IMAGE, secrets: ['KUBE_TOKEN', 'PROD_KEY'] });
    expect(await template(a, 'kube')).toMatchObject({ pending: { secrets: ['PROD_KEY'], image: false }, gives: ['KUBE_TOKEN'] });
    await edit(a, session, { action: 'approve-template', name: 'kube' });
    expect(await template(a, 'kube')).toMatchObject({ pending: { secrets: [], image: false }, gives: ['KUBE_TOKEN', 'PROD_KEY'] });
  });

  it('a new image waits for a person again, and gives nothing meanwhile', async () => {
    const { a, session } = await boot();
    await edit(a, session, { action: 'save-template', name: 'kube', image: IMAGE, secrets: ['KUBE_TOKEN'] });
    await edit(a, session, { action: 'approve-template', name: 'kube' });
    await edit(a, session, { action: 'save-template', name: 'kube', image: 'localhost/box-kubectl:1', secrets: ['KUBE_TOKEN'] });
    expect(await template(a, 'kube')).toMatchObject({ pending: { secrets: [], image: true }, gives: [] });
  });

  it('narrowing needs no approval', async () => {
    const { a, session } = await boot();
    await edit(a, session, { action: 'save-template', name: 'kube', image: IMAGE, secrets: ['KUBE_TOKEN', 'PROD_KEY'] });
    await edit(a, session, { action: 'approve-template', name: 'kube' });
    await edit(a, session, { action: 'save-template', name: 'kube', image: IMAGE, secrets: ['KUBE_TOKEN'] });
    expect(await template(a, 'kube')).toMatchObject({ pending: { secrets: [], image: false }, gives: ['KUBE_TOKEN'] });
  });

  it('a template naming a secret the vault does not hold, or a bad name, is refused; removing one works once', async () => {
    const { a, session } = await boot();
    expect((await edit(a, session, { action: 'save-template', name: 'kube', image: IMAGE, secrets: ['NOPE'] })).status).toBe(400);
    expect((await edit(a, session, { action: 'save-template', name: 'bad name', image: IMAGE, secrets: [] })).status).toBe(400);
    expect((await edit(a, session, { action: 'approve-template', name: 'none' })).status).toBe(404);
    await edit(a, session, { action: 'save-template', name: 'kube', image: IMAGE, secrets: [] });
    expect((await edit(a, session, { action: 'remove-template', name: 'kube' })).status).toBe(200);
    expect(await template(a, 'kube')).toBeUndefined();
    expect((await edit(a, session, { action: 'remove-template', name: 'kube' })).status).toBe(404);
  });

  it('a sandbox box joins with a line that names its template, and is an instance of it', async () => {
    const { a, session } = await boot();
    await edit(a, session, { action: 'save-template', name: 'kube', image: IMAGE, secrets: ['KUBE_TOKEN'] });
    expect((await a.ui('/ui/api/machines/join', { template: 'nope' }, { token: session })).status).toBe(404);
    const code = (await a.ui<{ code: string }>('/ui/api/machines/join', { template: 'kube' }, { token: session })).body.code;
    const dir = mkdtempSync(join(tmpdir(), 'hopper-box-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    await joinHopper({ line: `${a.url}#${code}`, name: 'hopper-sandbox-kube', dir });
    const cfg = (await a.api('GET', '/api/machines/config')).body as { machines: { name: string; options: Record<string, unknown> }[] };
    expect(cfg.machines.find((m) => m.name === 'hopper-sandbox-kube')!.options).toMatchObject({ template: 'kube' });
    // A computer's line names none.
    const plain = (await a.ui<{ code: string }>('/ui/api/machines/join', {}, { token: session })).body.code;
    const other = mkdtempSync(join(tmpdir(), 'hopper-box-'));
    cleanups.push(() => rmSync(other, { recursive: true, force: true }));
    await joinHopper({ line: `${a.url}#${plain}`, name: 'laptop', dir: other });
    const cfg2 = (await a.api('GET', '/api/machines/config')).body as { machines: { name: string; options: Record<string, unknown> }[] };
    expect(cfg2.machines.find((m) => m.name === 'laptop')!.options.template).toBeUndefined();
    // The scope a machine gets is its template's approved scope: nothing yet.
    // (The vault reaches the hopper through its edges since issue #586: the scope is read as the vault shows it.)
    const gives = async (): Promise<string[]> => ((await a.api('GET', '/api/vault')).body.templates as { name: string; gives: string[] }[]).find((t) => t.name === 'kube')!.gives;
    expect(cfg2.machines.find((m) => m.name === 'hopper-sandbox-kube')!.options.template).toBe('kube');
    expect(await gives()).toEqual([]);
    await edit(a, session, { action: 'approve-template', name: 'kube' });
    expect(await gives()).toEqual(['KUBE_TOKEN']);
  });

  it('a template with an attached box is not removed: the answer names the box; once the box leaves, it is removed (issue #604)', async () => {
    const { a, session } = await boot();
    await edit(a, session, { action: 'save-template', name: 'kube', image: IMAGE, secrets: ['KUBE_TOKEN'] });
    await joinBox(a, session, 'hopper-sandbox-kube', 'kube');
    const refused = await edit(a, session, { action: 'remove-template', name: 'kube' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/hopper-sandbox-kube/);
    expect(await template(a, 'kube')).toBeDefined();
    expect((await a.events()).map((e) => e.type)).not.toContain('template.removed');

    const version = (await a.api('GET', '/api/machines/config')).body.version as string;
    expect((await a.ui('/ui/api/plugins', { action: 'remove', role: 'machine-source', name: 'hopper-sandbox-kube', version }, { token: session })).status).toBe(200);
    expect((await edit(a, session, { action: 'remove-template', name: 'kube' })).status).toBe(200);
    expect(await template(a, 'kube')).toBeUndefined();
  });

  it('a join line whose template was removed is refused, and adds no machine (issue #604)', async () => {
    const { a, session } = await boot();
    await edit(a, session, { action: 'save-template', name: 'kube', image: IMAGE, secrets: [] });
    const code = (await a.ui<{ code: string }>('/ui/api/machines/join', { template: 'kube' }, { token: session })).body.code;
    expect((await edit(a, session, { action: 'remove-template', name: 'kube' })).status).toBe(200);
    const dir = mkdtempSync(join(tmpdir(), 'hopper-box-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    await expect(joinHopper({ line: `${a.url}#${code}`, name: 'hopper-sandbox-kube', dir })).rejects.toThrow(/no template kube/);
    expect(await machineNames(a)).not.toContain('hopper-sandbox-kube');
  });

  it('a machine is not set to a template that does not exist (issue #604)', async () => {
    const { a, session } = await boot();
    await edit(a, session, { action: 'save-template', name: 'kube', image: IMAGE, secrets: [] });
    await joinBox(a, session, 'hopper-sandbox-kube', 'kube');
    const cfg = (await a.api('GET', '/api/machines/config')).body as { version: string; machines: { name: string; options: Record<string, unknown> }[] };
    const options = { ...cfg.machines.find((m) => m.name === 'hopper-sandbox-kube')!.options, template: 'gone' };
    const r = await a.ui<{ error: string }>('/ui/api/plugins', { action: 'options', role: 'machine-source', name: 'hopper-sandbox-kube', options, version: cfg.version }, { token: session });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/no template gone/);
  });

  it('a box of a template not approved takes no job until a person approves it; a revoke stops new jobs at once (issue #602)', async () => {
    const { a, session } = await boot();
    process.env.FAKE_HERDR_RUNNING = '1';
    await edit(a, session, { action: 'save-template', name: 'kube', image: IMAGE, secrets: ['KUBE_TOKEN'] });
    await box.join(a, session, 'hopper-sandbox-kube', 'kube');
    const machine = async (): Promise<MachineSnapshot> => ((await a.api('GET', '/api/machines')).body.machines as MachineSnapshot[]).find((m) => m.id === 'hopper-sandbox-kube')!;
    expect((await machine()).template).toEqual({ name: 'kube', waiting: expect.stringContaining('waiting for template approval') });

    const first = await a.pull({ op: 'sleep', ms: 100 });
    const held = await waitFor(async () => { const j = await a.job(first.id); return j.status === 'held' && j.holdReason?.includes('waiting for template approval') ? j : undefined; }, { timeoutMs: 10000, what: 'the job held for template approval' });
    expect(held.laneId).toBeUndefined();
    const heldEvents = (await a.events()).filter((e) => e.type === 'job.held' && e.jobId === first.id);
    expect(heldEvents.map((e) => (e.data as { reason: string }).reason)).toContainEqual(expect.stringContaining('waiting for template approval'));

    expect((await edit(a, session, { action: 'approve-template', name: 'kube' })).status).toBe(200);
    expect((await machine()).template).toEqual({ name: 'kube' });
    expect((await a.waitForStatus(first.id, 'finished', 10000)).laneId).toBe('hopper-sandbox-kube/lane-1');

    expect((await edit(a, session, { action: 'revoke-template', name: 'kube' })).status).toBe(200);
    expect((await template(a, 'kube'))!.approval).toBeUndefined();
    expect((await a.events()).map((e) => e.type)).toContain('vault.revoked');
    expect((await machine()).template).toEqual({ name: 'kube', waiting: expect.stringContaining('waiting for template approval') });
    const second = await a.pull({ op: 'sleep', ms: 100 });
    await waitFor(async () => { const j = await a.job(second.id); return j.status === 'held' && j.holdReason?.includes('waiting for template approval') ? j : undefined; }, { timeoutMs: 10000, what: 'the second job held for template approval' });
    // Several Decisions later it is still not placed.
    await new Promise((r) => setTimeout(r, 500));
    expect((await a.job(second.id)).status).toBe('held');
    expect((await edit(a, session, { action: 'revoke-template', name: 'none' })).status).toBe(404);
  });
});
