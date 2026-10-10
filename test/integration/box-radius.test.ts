// Issue #605, through the real composition root, the real HTTP server and a real joined client: a box's blast radius
// is at least its template's rating. The box's own reach comes from its discovery (here a double at the MachineShell
// port, which finds nothing); its template's rating from the template's scope (issue #584). The higher of the two
// rates the box, and the gate (issue #542) keeps jobs off it as off any machine rated so.
//
// Feature: a box's blast radius includes its template's rating
//   Scenario: a box of a high template, on a machine of low reach, is rated high and gated
//     Given the template kube with a prod vault secret in its scope, rated high
//     And a box joined as kube, whose discovery finds nothing
//     Then Machines shows the box rated high, by its template, and gated
//     And a job whose only machine is the box is held at the blast-radius gate
//   Scenario: a template widened to high rates its existing boxes again and gates them
//     Given a box of the template kube, rated low, and a job that ran on it
//     When an admin adds a prod vault secret to kube
//     Then the box is rated high, by its template, and gated
//     And the next job is held at the gate
//   Scenario: a box of a low template, on a machine of low reach, stays low
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor, MachineShell } from '../../src/domain/ports.ts';
import type { BlastRadiusView, DiscoveryFacts } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { boxes } from '../support/vault-box.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

const NOTHING: DiscoveryFacts = { path: ['/usr/bin'], bins: [{ dir: '/usr/bin', name: 'sh' }], versions: {}, aws: [], kube: [], credentials: { env: [], files: [] } };

/** An executor that runs nothing and reaches each machine through a shell whose discovery finds nothing. */
function reacher(): Executor {
  const shell: MachineShell = {
    async reap() { return { kept: [] }; },
    async survey() { return { scopes: [], processes: [], scratch: [] }; },
    async keepCredential() {},
    async discover() { return NOTHING; },
  };
  return { name: 'reach', validate: () => null, run: async () => ({ kind: 'failed', error: 'not run' }), machineShell: () => shell };
}

let t: TestApp | undefined;
const box = boxes();
const cleanups: (() => void)[] = [];
const saved = { ...process.env };

afterEach(async () => {
  await box.end();
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
});

/** A hopper with no machine but the box to come, and the template kube with `secrets` in its scope. */
async function boot(secrets: string[]): Promise<{ a: TestApp; session: string; edit: (body: Record<string, unknown>) => Promise<unknown> }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY },
    plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted', 'reach'] } },
    seams: { executors: [reacher()] },
  });
  const session = await t.login();
  const edit = (body: Record<string, unknown>) => t!.ui('/ui/api/vault', body, { token: session });
  await edit({ action: 'set', name: 'LAB_TOKEN', scope: 'lab cluster', value: 'lab-token-0123456789abcdef' });
  await edit({ action: 'set', name: 'PROD_KEY', scope: 'prod cluster', value: 'prod-key-fedcba9876543210' });
  await edit({ action: 'save-template', name: 'kube', image: 'localhost/box-kubectl:1', secrets });
  await edit({ action: 'approve-template', name: 'kube' });
  return { a: t, session, edit };
}

const boxView = async (a: TestApp, name: string) =>
  (await a.api<BlastRadiusView>('GET', '/api/blast-radius')).body.machines.find((m) => m.machineId === name);
const discovered = (a: TestApp, name: string) =>
  waitFor(async () => { const m = await boxView(a, name); return m?.discovery?.facts ? m : undefined; }, { what: `${name} discovered` });

describe('a box\'s blast radius includes its template\'s rating (issue #605)', () => {
  it('a box of a high template, on a machine of low reach, is rated high by its template and gated', async () => {
    const { a, session } = await boot(['PROD_KEY']);
    await box.join(a, session, 'sbx', 'kube');
    const m = await discovered(a, 'sbx');
    expect(m).toMatchObject({
      rating: { level: 'low' },
      template: { name: 'kube', radius: { level: 'high', reasons: ['vault secret PROD_KEY (prod cluster), prod: what it reaches is not discovered; counted as write'] } },
      radius: { level: 'high', source: 'template' },
      gated: 'rated high',
    });
    const j = await a.pull({ op: 'echo' });
    expect((await a.waitForStatus(j.id, 'held')).holdReason).toBe('held at the blast-radius gate: sbx is rated high; only a job let through the gate runs there');
  });

  it('a template widened to high rates its existing boxes again and gates them', async () => {
    const { a, session, edit } = await boot([]);
    await box.join(a, session, 'sbx', 'kube');
    expect(await discovered(a, 'sbx')).toMatchObject({ radius: { level: 'low', source: 'both' } });
    const first = await a.pull({ op: 'echo' });
    await a.waitForStatus(first.id, 'finished');

    await edit({ action: 'save-template', name: 'kube', image: 'localhost/box-kubectl:1', secrets: ['PROD_KEY'] });
    const m = await boxView(a, 'sbx');
    expect(m).toMatchObject({ rating: { level: 'low' }, template: { name: 'kube', radius: { level: 'high' } }, radius: { level: 'high', source: 'template' }, gated: 'rated high' });
    const next = await a.pull({ op: 'echo' });
    expect((await a.waitForStatus(next.id, 'held')).holdReason).toBe('held at the blast-radius gate: sbx is rated high; only a job let through the gate runs there');
  });

  it('a box of a low template, on a machine of low reach, stays low and takes jobs', async () => {
    const { a, session } = await boot([]);
    await box.join(a, session, 'sbx', 'kube');
    const m = await discovered(a, 'sbx');
    expect(m).toMatchObject({ rating: { level: 'low' }, template: { name: 'kube', radius: { level: 'low' } }, radius: { level: 'low', source: 'both' } });
    expect(m?.gated).toBeUndefined();
    const j = await a.pull({ op: 'echo' });
    await a.waitForStatus(j.id, 'finished');
  });
});
