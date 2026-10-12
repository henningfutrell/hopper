// Issue #716, part 1: an agent sets up the vault and its sandboxes without a UI session. `hopper vault|template|sandbox …`
// makes the same POST /ui/api/vault and POST /ui/api/machines/sandbox calls the UI makes, on the running daemon, under a
// session the CLI mints for the one call (issue #374). Real daemon, real CLI; the container runtime and OpenFGA are
// doubles at their ports.
//
// Feature: the vault, templates and sandbox boxes from the operator CLI
//   Scenario: a vault secret is set from stdin, listed without its value, and removed
//     Given a hopper with a master key
//     When the operator pipes a value into `hopper vault set DEPLOY_KEY --scope deploy`
//     Then `hopper vault` lists DEPLOY_KEY with its scope and no value
//     When the operator runs `hopper vault remove DEPLOY_KEY`
//     Then the vault holds no DEPLOY_KEY
//   Scenario: a value as an argument, or no value on stdin, is refused
//   Scenario: a template is saved with its secrets and profiles, waits for a person, and is approved
//     When the operator saves the template kube with KUBE_TOKEN, a read profile and a write profile
//     Then kube waits for approval of KUBE_TOKEN, the image and both profiles
//     When the operator approves kube, and then the write profile
//     Then kube gives KUBE_TOKEN and nothing waits
//     When the operator saves kube again with only a new image
//     Then its secrets and profiles stay, and the new image waits
//   Scenario: a profile that is not <operation>/<kind>/<asset> is refused before any call
//   Scenario: a sandbox box of an approved template is launched with parameters, and listed
//   Scenario: a parameter outside the template's limits is refused with the daemon's reason; nothing starts
//   Scenario: revoke and remove a template
//   Scenario: a template's tools are saved with --tool, and a launch names fewer of them (issue #716, item 2)
//   Scenario: a terraform workspace's state backend is saved with --backend, and kept by a later save (issue #715)
//   Scenario: the read policy is shown, set and cleared (issue #716, item 1); an entry it cannot read is refused
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { TemplateView } from '../../src/domain/types.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const NEW_IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude-2';
const VALUE = 'deploy-value-0123456789abcdef-never-read-back';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<{ a: TestApp; runtime: FakeContainerRuntime }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const runtime = createFakeContainerRuntime();
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: { machines: lanes(1) },
    seams: { authorizationServer: createFakeAuthorizationServer(), containerRuntime: runtime },
  });
  return { a: t, runtime };
}

async function hopper(a: TestApp, argv: string[], stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => stdin, out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, out: out.join(''), err: err.join('') };
}

const json = <T>(r: { out: string }): T => JSON.parse(r.out) as T;
type VaultAnswer = { secrets: { name: string; scope?: string }[]; templates: TemplateView[] };
/** The template commands answer the templates, as `hopper template list` does. */
const kube = (r: { out: string }) => json<TemplateView[]>(r).find((x) => x.name === 'kube');

async function approvedKube(a: TestApp): Promise<void> {
  expect((await hopper(a, ['vault', 'set', 'KUBE_TOKEN'], 'kube-value-0123456789')).code).toBe(0);
  expect((await hopper(a, ['template', 'save', 'kube', '--image', IMAGE, '--secret', 'KUBE_TOKEN', '--cpus', '2:4', '--ttl-minutes', '30:120'])).code).toBe(0);
  expect((await hopper(a, ['template', 'approve', 'kube'])).code).toBe(0);
}

describe('the vault, templates and sandbox boxes from the operator CLI (issue #716)', () => {
  it('sets a vault secret from stdin, lists it without its value, and removes it', async () => {
    const { a } = await boot();
    const set = await hopper(a, ['vault', 'set', 'DEPLOY_KEY', '--scope', 'deploy'], `${VALUE}\n`);
    expect(set).toMatchObject({ code: 0 });
    expect(set.out).not.toContain(VALUE);
    const list = await hopper(a, ['vault']);
    expect(json<VaultAnswer>(list).secrets).toEqual([expect.objectContaining({ name: 'DEPLOY_KEY', scope: 'deploy' })]);
    expect(list.out).not.toContain(VALUE);
    expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(VALUE);

    expect((await hopper(a, ['vault', 'remove', 'DEPLOY_KEY'])).code).toBe(0);
    expect(json<VaultAnswer>(await hopper(a, ['vault'])).secrets).toEqual([]);
  });

  it('refuses a value as an argument, and an empty stdin', async () => {
    const { a } = await boot();
    expect(await hopper(a, ['vault', 'set', 'DEPLOY_KEY', VALUE], VALUE)).toMatchObject({ code: 2, err: expect.stringContaining('usage: hopper vault set <name>') });
    expect(await hopper(a, ['vault', 'set', 'DEPLOY_KEY'], '  \n')).toMatchObject({ code: 2, err: expect.stringContaining('no value on stdin') });
    expect(json<VaultAnswer>(await hopper(a, ['vault'])).secrets).toEqual([]);
  });

  it('saves a template with secrets and profiles; it waits for a person, is approved, and keeps what a later save leaves out', async () => {
    const { a } = await boot();
    await hopper(a, ['vault', 'set', 'KUBE_TOKEN'], 'kube-value-0123456789');
    const saved = await hopper(a, ['template', 'save', 'kube', '--image', IMAGE, '--secret', 'KUBE_TOKEN', '--profile', 'read/cluster/x', '--profile', 'write/namespace/x/apps']);
    expect(saved).toMatchObject({ code: 0 });
    expect(kube(saved)).toMatchObject({
      image: IMAGE, secrets: ['KUBE_TOKEN'], gives: [],
      profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'x' } }, { operation: 'write', asset: { kind: 'namespace', name: 'x/apps' } }],
      pending: { secrets: ['KUBE_TOKEN'], image: true },
    });

    expect(kube(await hopper(a, ['template', 'approve', 'kube']))).toMatchObject({ gives: ['KUBE_TOKEN'], pending: { secrets: [], image: false, profiles: [{ operation: 'write' }] } });
    const write = await hopper(a, ['template', 'approve-profile', 'kube', 'write/namespace/x/apps']);
    expect(kube(write)).toMatchObject({ pending: { secrets: [], image: false, profiles: [] } });

    const list = json<TemplateView[]>(await hopper(a, ['template', 'list']));
    expect(list.map((x) => x.name)).toEqual(['kube']);

    const moved = kube(await hopper(a, ['template', 'save', 'kube', '--image', NEW_IMAGE]));
    expect(moved).toMatchObject({ image: NEW_IMAGE, secrets: ['KUBE_TOKEN'], pending: { image: true } });
    expect(moved!.profiles).toHaveLength(2);
  });

  it('refuses a profile that is not <operation>/<kind>/<asset>, before any call', async () => {
    const { a } = await boot();
    expect(await hopper(a, ['template', 'save', 'kube', '--image', IMAGE, '--profile', 'read/cluster'])).toMatchObject({ code: 2, err: expect.stringContaining('--profile read/cluster') });
    expect(await hopper(a, ['template', 'save', 'kube', '--image', IMAGE, '--profile', 'delete/cluster/x'])).toMatchObject({ code: 2, err: expect.stringContaining('read, write, sync, apply') });
    expect(await hopper(a, ['template', 'save', 'kube', '--image', IMAGE, '--cpus', 'two'])).toMatchObject({ code: 2, err: expect.stringContaining('--cpus') });
    expect(json<VaultAnswer>(await hopper(a, ['vault'])).templates).toEqual([]);
  });

  it('launches a sandbox box of an approved template with parameters, and lists it', async () => {
    const { a, runtime } = await boot();
    await approvedKube(a);
    const r = await hopper(a, ['sandbox', 'launch', '--template', 'kube', '--cpus', '3', '--ttl-minutes', '60', '--secret', 'KUBE_TOKEN']);
    expect(r).toMatchObject({ code: 0 });
    const { container } = json<{ container: string }>(r);
    expect(runtime.boxes.get(container)?.spec.image).toBe(IMAGE);

    const boxes = json<{ boxes: { name: string; template?: { name: string }; params: Record<string, unknown> }[] }>(await hopper(a, ['sandbox', 'list'])).boxes;
    expect(boxes).toEqual([expect.objectContaining({ name: container, template: expect.objectContaining({ name: 'kube' }), params: expect.objectContaining({ cpus: 3, ttlMinutes: 60, secrets: ['KUBE_TOKEN'] }) })]);
  });

  it('refuses a parameter outside the template\'s limits with the daemon\'s reason; nothing starts', async () => {
    const { a, runtime } = await boot();
    await approvedKube(a);
    expect(await hopper(a, ['sandbox', 'launch', '--template', 'kube', '--cpus', '8'])).toMatchObject({ code: 2, err: expect.stringContaining('at most 4') });
    expect(await hopper(a, ['sandbox', 'launch', '--template', 'kube', '--cpus', 'many'])).toMatchObject({ code: 2, err: expect.stringContaining('--cpus') });
    expect(runtime.boxes.size).toBe(0);
  });

  it('saves a template\'s tools with --tool, and a launch names fewer of them (issue #716, item 2)', async () => {
    const { a, runtime } = await boot();
    const saved = kube(await hopper(a, ['template', 'save', 'kube', '--image', IMAGE, '--tool', 'kubectl', '--tool', 'helm']));
    expect(saved).toMatchObject({ tools: ['helm', 'kubectl'], pending: { image: true } });
    expect((await hopper(a, ['template', 'approve', 'kube'])).code).toBe(0);
    // A save that names no tool keeps the ones it has.
    expect(kube(await hopper(a, ['template', 'save', 'kube', '--image', IMAGE]))).toMatchObject({ tools: ['helm', 'kubectl'], pending: { image: false } });
    const r = await hopper(a, ['sandbox', 'launch', '--template', 'kube', '--tool', 'kubectl']);
    expect(r).toMatchObject({ code: 0 });
    expect(runtime.images.get(runtime.boxes.get(json<{ container: string }>(r).container)!.spec.image)).toContain('io.hopper.tools="kubectl"');
    expect(await hopper(a, ['sandbox', 'launch', '--template', 'kube', '--tool', 'aws'])).toMatchObject({ code: 2, err: expect.stringContaining('does not add aws') });
  });

  it('saves a terraform workspace\'s state backend with --backend, and a later save keeps it (issue #715)', async () => {
    const { a } = await boot();
    const ws = (r: Awaited<ReturnType<typeof hopper>>) => json<TemplateView[]>(r).find((x) => x.name === 'tf')!.profiles;
    const saved = await hopper(a, ['template', 'save', 'tf', '--image', IMAGE, '--profile', 'read/terraform-workspace/shop-prod', '--profile', 'read/aws-role/1/r', '--backend', 'shop-prod=shop-state/env/prod@eu-west-1']);
    expect(saved).toMatchObject({ code: 0 });
    const backend = { bucket: 'shop-state', region: 'eu-west-1', keyPrefix: 'env/prod' };
    expect(ws(saved)).toEqual([{ operation: 'read', asset: { kind: 'terraform-workspace', name: 'shop-prod' }, backend }, { operation: 'read', asset: { kind: 'aws-role', name: '1/r' } }]);
    // Profiles named again with no --backend keep the backend; --backend alone changes it on the profiles the template has.
    expect(ws(await hopper(a, ['template', 'save', 'tf', '--image', IMAGE, '--profile', 'read/terraform-workspace/shop-prod']))).toEqual([{ operation: 'read', asset: { kind: 'terraform-workspace', name: 'shop-prod' }, backend }]);
    expect(ws(await hopper(a, ['template', 'save', 'tf', '--image', IMAGE, '--backend', 'shop-prod=other-state@us-east-1']))[0]!.backend).toEqual({ bucket: 'other-state', region: 'us-east-1' });
    expect(await hopper(a, ['template', 'save', 'tf', '--image', IMAGE, '--backend', 'shop-prod'])).toMatchObject({ code: 2, err: expect.stringContaining('<workspace>=<bucket>[/<key prefix>]@<region>') });
    expect(await hopper(a, ['template', 'save', 'tf', '--image', IMAGE, '--backend', 'other=b-1@us-east-1'])).toMatchObject({ code: 2, err: expect.stringContaining('no terraform-workspace profile other') });
    expect(await hopper(a, ['template', 'save', 'tf', '--image', IMAGE, '--backend', 'shop-prod=Bad_Bucket@us-east-1'])).toMatchObject({ code: 2, err: expect.stringContaining('not an S3 bucket name') });
  });

  it('revokes and removes a template', async () => {
    const { a } = await boot();
    await approvedKube(a);
    expect(kube(await hopper(a, ['template', 'revoke', 'kube']))).toMatchObject({ gives: [] });
    expect((await hopper(a, ['template', 'remove', 'kube'])).code).toBe(0);
    expect(json<TemplateView[]>(await hopper(a, ['template', 'list']))).toEqual([]);
  });

  it('runs a template\'s read-only check again; a template that takes none is refused (issue #716, item 4)', async () => {
    const { a } = await boot();
    await approvedKube(a);
    expect(await hopper(a, ['template', 'check', 'kube'])).toMatchObject({ code: 2, err: expect.stringContaining('kube takes no read-only check') });
    // As a job's request makes one: read needs only.
    const vault = a.user().vault;
    expect(await vault.saveTemplate({ name: 'asked', image: IMAGE, secrets: [], readOnly: true }, 'job 1')).toEqual({ ok: true });
    const t = vault.view().templates.find((x) => x.name === 'asked')!;
    expect(vault.recordCheck('asked', { version: t.savedAt, state: 'failed', at: t.savedAt, probes: [], problem: 'the check box did not run' })).toBe(true);
    const r = await hopper(a, ['template', 'check', 'asked']);
    expect(r.code, r.err).toBe(0);
    expect(json<TemplateView[]>(r).find((x) => x.name === 'asked')).toMatchObject({ readOnly: true });
    expect(json<TemplateView[]>(r).find((x) => x.name === 'asked')!.check).toBeUndefined();
  });

  it('shows, sets and clears the read policy; an entry it cannot read is refused', async () => {
    const { a } = await boot();
    expect(json<string[]>(await hopper(a, ['template', 'read-policy']))).toEqual([]);
    const set = await hopper(a, ['template', 'read-policy', 'set', 'cluster/lab', 'aws-account/*']);
    expect(set.code, set.err).toBe(0);
    expect(json<string[]>(set)).toEqual(['cluster/lab', 'aws-account/*']);
    expect(json<string[]>(await hopper(a, ['template', 'read-policy']))).toEqual(['cluster/lab', 'aws-account/*']);
    expect(await hopper(a, ['template', 'read-policy', 'set', 'planet/mars'])).toMatchObject({ code: 2, err: expect.stringContaining('the asset kind is one of') });
    expect(json<string[]>(await hopper(a, ['template', 'read-policy', 'set']))).toEqual([]);
  });
});
