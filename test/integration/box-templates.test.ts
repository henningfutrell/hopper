// Issue #558, slice 2, through the real composition root and the real HTTP server: box templates. A box template is an
// image and the vault secrets its boxes may ask for. The scope comes only from the template, never from a job. A new
// template, or one whose scope widened or whose image changed, gives nothing until a person approves it once; what it
// gives is what was approved. A sandbox box's join line names its template, so the box joins as an instance of it
// (design.md "The vault").
//
// Feature: box templates, approved once
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
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
const saved = { ...process.env };

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
});

async function boot(): Promise<{ a: TestApp; session: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  t = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_TOKEN_KEY: KEY }, plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['test'] } } });
  const session = await t.login();
  for (const name of ['KUBE_TOKEN', 'PROD_KEY']) await t.ui('/ui/api/vault', { action: 'set', name, value: `${name}-value-0123456789` }, { token: session });
  return { a: t, session };
}

type Template = { name: string; image: string; secrets: string[]; approval?: { image: string; secrets: string[]; by: string; at: string }; pending: { secrets: string[]; image: boolean }; gives: string[] };
const edit = (a: TestApp, session: string, body: Record<string, unknown>) => a.ui<{ templates: Template[]; error?: string }>('/ui/api/vault', body, { token: session });
const template = async (a: TestApp, name: string): Promise<Template | undefined> =>
  ((await a.api('GET', '/api/vault')).body.templates as Template[]).find((x) => x.name === name);

describe('box templates', () => {
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
    expect(types).toEqual(expect.arrayContaining(['box_template.saved', 'vault.approved']));
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
    expect(a.user().vault.scopeOf('hopper-sandbox-kube')).toEqual({ template: 'kube', secrets: [] });
    await edit(a, session, { action: 'approve-template', name: 'kube' });
    expect(a.user().vault.scopeOf('hopper-sandbox-kube')).toEqual({ template: 'kube', secrets: ['KUBE_TOKEN'] });
    expect(a.user().vault.scopeOf('laptop')).toEqual({ secrets: [] });
  });
});
