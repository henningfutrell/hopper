// Issue #716, part 1: an agent sets up the vault and its sandboxes without a UI session. `hopper vault|template|sandbox …`
// makes the same POST /ui/api/vault calls the UI makes, on the running daemon, under a
// session the CLI mints for the one call (issue #374). Real daemon, real CLI; the container runtime and OpenFGA are
// doubles at their ports.
//
// Feature: the vault, templates and sandboxes from the operator CLI
//   Scenario: a vault secret is set from stdin, listed without its value, and removed
//     Given a hopper with a master key
//     When the operator pipes a value into `hopper vault set DEPLOY_KEY --scope deploy`
//     Then `hopper vault` lists DEPLOY_KEY with its scope and no value
//     When the operator runs `hopper vault remove DEPLOY_KEY`
//     Then the vault holds no DEPLOY_KEY
//   Scenario: a value as an argument, or no value on stdin, is refused
//   Scenario: --mints is checked as on Vault (issue #872): a name a credential cannot mint for is refused before
//     any call, the set is a vault.secret_set event with what it mints for, and the vault refuses to mark a secret that a
//     template gives out
//   Scenario: a template is saved with its secrets and profiles, waits for a person, and is approved
//     When the operator saves the template kube with KUBE_TOKEN, a read profile and a write profile
//     Then kube waits for approval of KUBE_TOKEN, the image and both profiles
//     When the operator approves kube, and then the write profile
//     Then kube gives KUBE_TOKEN and nothing waits
//     When the operator saves kube again with only a new image
//     Then its secrets and profiles stay, and the new image waits
//   Scenario: a profile that is not <operation>/<kind>/<asset> is refused before any call
//   Scenario: the CLI launches no sandbox box; `hopper sandbox list` lists the sandbox runs (issue #1349)
//   Scenario: revoke and remove a template
//   Scenario: a template's tools are saved with --tool, and a later save keeps them (issue #716, item 2)
//   Scenario: a terraform workspace's state backend is saved with --backend, and kept by a later save (issue #715)
//   Scenario: the read policy is shown, set and cleared (issue #716, item 1); an entry it cannot read is refused
//   Scenario: a template's agent credential is saved with --agent-credential, kept by a later save, and dropped with none
//     (issue #708, part 10)
//   Scenario: a read probe is marked with --mark, a later save keeps the marks, none drops one; a write probe takes no mark (issue #916)
//   Scenario: a job is granted the vault and the grant is taken back, with no browser (issue #1089)
//     Given a job of the hopper's user
//     When the operator runs `hopper vault grant <job>`
//     Then the vault's view lists the job's grant, by the operator CLI
//     When the operator runs `hopper vault revoke <job>`
//     Then the job has no grant, and a second revoke is refused
//     And a job the hopper does not know is refused
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
  expect((await hopper(a, ['template', 'save', 'kube', '--image', IMAGE, '--secret', 'KUBE_TOKEN', '--cpus', '2:4'])).code).toBe(0);
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

  it('sets what a minting credential mints for with --mints; a later set without it keeps it, none clears it (issue #791)', async () => {
    const { a } = await boot();
    type Mints = { secrets: { name: string; mints?: { kind: string; name: string } }[] };
    const mints = async () => json<Mints>(await hopper(a, ['vault'])).secrets.find((s) => s.name === 'AWS_MINT')?.mints;
    const aws = JSON.stringify({ AccessKeyId: 'AKIAEXAMPLE0123456789', SecretAccessKey: 'secret-0123456789abcdef' });

    expect(await hopper(a, ['vault', 'set', 'AWS_MINT', '--mints', 'aws-account/123456789012'], aws)).toMatchObject({ code: 0 });
    expect(await mints()).toEqual({ kind: 'aws-account', name: '123456789012' });
    expect(await hopper(a, ['vault', 'set', 'AWS_MINT'], aws)).toMatchObject({ code: 0 });
    expect(await mints()).toEqual({ kind: 'aws-account', name: '123456789012' });
    expect(await hopper(a, ['vault', 'set', 'AWS_MINT', '--mints', 'none'], aws)).toMatchObject({ code: 0 });
    expect(await mints()).toBeUndefined();

    expect(await hopper(a, ['vault', 'set', 'AWS_MINT', '--mints', 'namespace/lab/web'], aws)).toMatchObject({ code: 2, err: expect.stringContaining('--mints namespace/lab/web: write aws-account/<account id> or cluster/<name>, or none') });
    expect(await hopper(a, ['vault', 'set', 'AWS_MINT', '--mints', 'cluster/lab', '--shared'], aws)).toMatchObject({ code: 2, err: expect.stringContaining('a shared secret mints nothing') });
  });

  it('checks --mints as Vault does: a bad name before the call, a secret in a template\'s scope by the vault (issue #872)', async () => {
    const { a } = await boot();
    type Mints = { secrets: { name: string; mints?: { kind: string; name: string } }[] };
    const mints = async () => json<Mints>(await hopper(a, ['vault'])).secrets.find((s) => s.name === 'KUBE_MINT')?.mints;

    expect(await hopper(a, ['vault', 'set', 'KUBE_MINT', '--mints', 'cluster/la b'], VALUE)).toMatchObject({ code: 2, err: expect.stringContaining('is not a name') });
    expect(json<Mints>(await hopper(a, ['vault'])).secrets).toEqual([]);

    const set = await hopper(a, ['vault', 'set', 'KUBE_MINT', '--mints', 'cluster/lab'], VALUE);
    expect(set).toMatchObject({ code: 0 });
    expect(set.out).not.toContain(VALUE);
    expect(a.user().store.events.since(0, 100_000).filter((e) => e.type === 'vault.secret_set').at(-1)?.data).toMatchObject({ mints: { kind: 'cluster', name: 'lab' } });

    // A secret a template gives out is never a minting credential: the vault refuses it, as for a click.
    expect(await hopper(a, ['vault', 'set', 'KUBE_MINT', '--mints', 'none'], VALUE)).toMatchObject({ code: 0 });
    expect((await hopper(a, ['template', 'save', 'kube', '--image', IMAGE, '--secret', 'KUBE_MINT'])).code).toBe(0);
    const refused = await hopper(a, ['vault', 'set', 'KUBE_MINT', '--mints', 'cluster/lab'], VALUE);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain('in a template\'s scope');
    expect(await mints()).toBeUndefined();
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

  it('launches no sandbox box; sandbox list lists the sandbox runs (issue #1349)', async () => {
    const { a, runtime } = await boot();
    await approvedKube(a);
    expect(await hopper(a, ['sandbox', 'launch'])).toMatchObject({ code: 2, err: expect.stringContaining('sandbox list | requests') });
    expect((await hopper(a, ['sandbox', 'launch', '--template', 'kube'])).code).not.toBe(0);
    expect(runtime.boxes.size).toBe(0);
    expect(json<{ runs: unknown[]; problems: unknown[] }>(await hopper(a, ['sandbox', 'list']))).toEqual({ runs: [], problems: [] });
  });

  it('saves a template\'s tools with --tool, and a later save keeps them (issue #716, item 2)', async () => {
    const { a } = await boot();
    const saved = kube(await hopper(a, ['template', 'save', 'kube', '--image', IMAGE, '--tool', 'kubectl', '--tool', 'helm']));
    expect(saved).toMatchObject({ tools: ['helm', 'kubectl'], pending: { image: true } });
    expect((await hopper(a, ['template', 'approve', 'kube'])).code).toBe(0);
    // A save that names no tool keeps the ones it has.
    expect(kube(await hopper(a, ['template', 'save', 'kube', '--image', IMAGE]))).toMatchObject({ tools: ['helm', 'kubectl'], pending: { image: false } });
  });

  it('saves a template\'s agent credential with --agent-credential; a later save keeps it, none drops it (issue #708)', async () => {
    const { a } = await boot();
    const token = 'sk-ant-oat01-cli-agent-credential-0123456789';
    expect((await hopper(a, ['vault', 'set', 'CLAUDE'], token)).code).toBe(0);
    expect(kube(await hopper(a, ['template', 'save', 'kube', '--image', IMAGE, '--secret', 'CLAUDE', '--agent-credential', 'CLAUDE']))).toMatchObject({ agentCredential: 'CLAUDE' });
    expect((await hopper(a, ['template', 'approve', 'kube'])).code).toBe(0);
    expect(kube(await hopper(a, ['template', 'save', 'kube', '--image', IMAGE]))).toMatchObject({ agentCredential: 'CLAUDE' });
    expect(kube(await hopper(a, ['template', 'save', 'kube', '--image', IMAGE, '--agent-credential', 'none']))!.agentCredential).toBeUndefined();
    expect(await hopper(a, ['template', 'save', 'kube', '--image', IMAGE, '--agent-credential', 'OTHER'])).toMatchObject({ code: 2, err: expect.stringContaining('not one of the template\'s secrets') });
  });

  it('marks a read probe with --mark; a later save keeps the marks, none drops one, and a write probe takes none (issue #916)', async () => {
    const { a } = await boot();
    const marks = (r: Awaited<ReturnType<typeof hopper>>) => kube(r)!.probeMarks;
    expect(marks(await hopper(a, ['template', 'save', 'kube', '--image', IMAGE, '--mark', 'helm.list=expect-denied', '--mark', 'kube.get=skip']))).toEqual({ 'helm.list': 'expect-denied', 'kube.get': 'skip' });
    expect(marks(await hopper(a, ['template', 'save', 'kube', '--image', IMAGE]))).toEqual({ 'helm.list': 'expect-denied', 'kube.get': 'skip' });
    expect(marks(await hopper(a, ['template', 'save', 'kube', '--image', IMAGE, '--mark', 'kube.get=none']))).toEqual({ 'helm.list': 'expect-denied' });
    expect(await hopper(a, ['template', 'save', 'kube', '--image', IMAGE, '--mark', 'helm.install=skip'])).toMatchObject({ code: 2, err: expect.stringContaining('helm.install is a write probe') });
    expect(await hopper(a, ['template', 'save', 'kube', '--image', IMAGE, '--mark', 'helm.list'])).toMatchObject({ code: 2 });
    expect(marks(await hopper(a, ['template', 'save', 'kube', '--image', IMAGE, '--mark', 'helm.list=none']))).toBeUndefined();
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
    // Issue #2226: it says when the check runs, or why it does not: this template's image is not approved yet.
    expect(json(r)).toEqual({ template: 'asked', check: 'asked for: it does not run until its image is approved (hopper template approve asked)' });
    expect(vault.view().templates.find((x) => x.name === 'asked')!.check).toBeUndefined();
    expect((await hopper(a, ['template', 'approve', 'asked'])).code).toBe(0);
    expect(json(await hopper(a, ['template', 'check', 'asked']))).toEqual({ template: 'asked', check: 'asked for: the next read-only check pass runs it' });
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

  it('grants a job the vault and takes the grant back, with no browser (issue #1089)', async () => {
    const { a } = await boot();
    const job = await a.pull({ op: 'sleep', ms: 60000 });
    type Grants = { grants: { key: string; job: string; by: string }[] };

    const granted = await hopper(a, ['vault', 'grant', job.id]);
    expect(granted).toMatchObject({ code: 0 });
    expect(json<Grants>(granted).grants).toEqual([expect.objectContaining({ job: job.id, key: job.source!.key, by: 'operator CLI' })]);
    expect(json<Grants>(await hopper(a, ['vault'])).grants.map((g) => g.job)).toEqual([job.id]);
    // Issue #1124: what the grant covers — the item's newest job and its status — and that the operator CLI made it, by which command.
    expect(json<Grants>(await hopper(a, ['vault'])).grants[0]).toMatchObject({
      made: 'grant', via: 'cli', command: `hopper vault grant ${job.id}`,
      item: { title: expect.any(String), job: job.id, status: expect.any(String), stale: false },
    });
    expect((await a.events()).find((e) => e.type === 'vault.granted')).toMatchObject({ jobId: job.id });

    expect(json<Grants>(await hopper(a, ['vault', 'revoke', job.id])).grants).toEqual([]);
    expect(await hopper(a, ['vault', 'revoke', job.id])).toMatchObject({ code: 2, err: expect.stringContaining('has no vault grant to revoke') });
    expect(await hopper(a, ['vault', 'grant', 'no-such-job'])).toMatchObject({ code: 2, err: expect.stringContaining('job no-such-job not found') });
    expect(await hopper(a, ['vault', 'grant'])).toMatchObject({ code: 2, err: expect.stringContaining('usage: hopper vault grant|revoke <job>') });
  });
});
