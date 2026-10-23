// Issue #2146 (the bastion path, part 3), through the real composition root and the real HTTP server: a template's
// bastion targets. A template names the targets (`<cluster>/<namespace>/<svc|pod|deploy>/<name>:<port>`) a bastion of it
// may forward to, each on a namespace or cluster it has an observe on. They are part of what a person approves with the
// template: a new target waits for a person, and only an approved one is a bastion's.
//
// Feature: a template's bastion targets
//   Scenario: a bastion target waits for a person with the template; the approval names it
//   Scenario: a new target waits again; a save that leaves the targets out keeps them; a target removed needs no approval
//   Scenario: a target that is not one, or that no observe of the template reaches, is refused
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const GRAFANA = 'utility/monitoring/svc/grafana:80';
const PROMETHEUS = 'utility/monitoring/svc/prometheus-server:9090';
const OBSERVE = { operation: 'observe', asset: { kind: 'namespace', name: 'utility/monitoring' } };

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<{ a: TestApp; session: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  t = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY } });
  return { a: t, session: await t.login() };
}

type Template = { name: string; bastionTargets?: string[]; approval?: { bastionTargets?: string[] }; pending: { bastionTargets: string[] } };
const edit = (a: TestApp, session: string, body: Record<string, unknown>) => a.ui<{ error?: string }>('/ui/api/vault', body, { token: session });
const save = (a: TestApp, session: string, more: Record<string, unknown>) => edit(a, session, { action: 'save-template', name: 'observe-utility', image: IMAGE, secrets: [], profiles: [OBSERVE], ...more });
const template = async (a: TestApp, name: string): Promise<Template | undefined> =>
  ((await a.api('GET', '/api/vault')).body.templates as Template[]).find((x) => x.name === name);

describe('a template\'s bastion targets (issue #2146, part 3)', () => {
  it('wait for a person with the template; the approval names them', async () => {
    const { a, session } = await boot();
    expect((await save(a, session, { bastionTargets: [PROMETHEUS, GRAFANA, GRAFANA] })).status).toBe(200);
    expect(await template(a, 'observe-utility')).toMatchObject({ bastionTargets: [GRAFANA, PROMETHEUS], pending: { bastionTargets: [GRAFANA, PROMETHEUS] } });
    expect((await edit(a, session, { action: 'approve-template', name: 'observe-utility' })).status).toBe(200);
    expect(await template(a, 'observe-utility')).toMatchObject({ approval: { bastionTargets: [GRAFANA, PROMETHEUS] }, pending: { bastionTargets: [] } });
    const events = await a.events();
    expect(events.find((e) => e.type === 'template.saved')?.data).toMatchObject({ bastionTargets: [GRAFANA, PROMETHEUS] });
    expect(events.find((e) => e.type === 'vault.approved')?.data).toMatchObject({ bastionTargets: [GRAFANA, PROMETHEUS] });
  });

  it('a new target waits again; a save that leaves them out keeps them; a target removed needs no approval', async () => {
    const { a, session } = await boot();
    await save(a, session, { bastionTargets: [GRAFANA] });
    await edit(a, session, { action: 'approve-template', name: 'observe-utility' });
    await save(a, session, { bastionTargets: [GRAFANA, PROMETHEUS] });
    expect(await template(a, 'observe-utility')).toMatchObject({ pending: { bastionTargets: [PROMETHEUS] } });
    await save(a, session, {});
    expect(await template(a, 'observe-utility')).toMatchObject({ bastionTargets: [GRAFANA, PROMETHEUS] });
    await save(a, session, { bastionTargets: [GRAFANA] });
    expect(await template(a, 'observe-utility')).toMatchObject({ bastionTargets: [GRAFANA], pending: { bastionTargets: [] } });
  });

  it('refuses a target that is not one, and one no observe of the template reaches', async () => {
    const { a, session } = await boot();
    for (const target of ['utility/monitoring/grafana:80', 'utility/monitoring/svc/grafana', 'utility/monitoring/secret/grafana:80']) {
      const r = await save(a, session, { bastionTargets: [target] });
      expect(r.status, target).toBe(400);
      expect(r.body.error, target).toMatch(/target/);
    }
    const r = await save(a, session, { bastionTargets: ['prod/monitoring/svc/grafana:80'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('observe/namespace/prod/monitoring');
  });
});
