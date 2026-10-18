// Issue #1875, through the real composition root and the real HTTP server: a template's egress hosts. A template names
// the hosts (host:port) its boxes may reach past the egress proxy, beyond AWS's and the minted clusters'. They are part
// of what a person approves, with the image: a new host waits for a person, and the template is not ready meanwhile.
// They count in its blast radius.
//
// Feature: a template's egress hosts
//   Scenario: a template with an egress host waits for a person, and is rated for it
//     Given the vault secret E2E_PASSWORD
//     When an admin saves the template e2e with that secret and the egress host auth.example.test:443
//     Then the vault lists e2e as waiting for approval of that host, and its boxes may be given nothing
//     And its blast radius names the host
//     When an admin approves e2e
//     Then the approval names the host, and nothing of e2e waits
//   Scenario: a new egress host waits for a person again, and gives nothing meanwhile; a host removed needs no approval
//   Scenario: an egress host that is not host:port is refused
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const HOST = 'auth.example.test:443';

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
  const session = await t.login();
  await t.ui('/ui/api/vault', { action: 'set', name: 'E2E_PASSWORD', value: 'E2E_PASSWORD-value-0123456789' }, { token: session });
  return { a: t, session };
}

type Template = {
  name: string; egress?: string[]; approval?: { egress?: string[] }; gives: string[];
  pending: { secrets: string[]; image: boolean; egress: string[] }; radius: { level: string; reasons: string[] };
};
const edit = (a: TestApp, session: string, body: Record<string, unknown>) => a.ui<{ error?: string }>('/ui/api/vault', body, { token: session });
const template = async (a: TestApp, name: string): Promise<Template | undefined> =>
  ((await a.api('GET', '/api/vault')).body.templates as Template[]).find((x) => x.name === name);

describe('a template\'s egress hosts (issue #1875)', () => {
  it('wait for a person with the template, and count in its blast radius', async () => {
    const { a, session } = await boot();
    expect((await edit(a, session, { action: 'save-template', name: 'e2e', image: IMAGE, secrets: ['E2E_PASSWORD'], egress: [HOST, 'AUTH.example.test:443'] })).status).toBe(200);
    const saved = (await template(a, 'e2e'))!;
    expect(saved).toMatchObject({ egress: [HOST], pending: { egress: [HOST] }, gives: [] });
    expect(saved.radius.reasons.join('\n')).toContain(`egress host ${HOST}`);

    expect((await edit(a, session, { action: 'approve-template', name: 'e2e' })).status).toBe(200);
    expect(await template(a, 'e2e')).toMatchObject({ approval: { egress: [HOST] }, pending: { secrets: [], image: false, egress: [] }, gives: ['E2E_PASSWORD'] });
    const events = await a.events();
    expect(events.find((e) => e.type === 'template.saved')?.data).toMatchObject({ egress: [HOST] });
    expect(events.find((e) => e.type === 'vault.approved')?.data).toMatchObject({ egress: [HOST] });
  });

  it('a new host waits for a person again and gives nothing meanwhile; a host removed needs no approval', async () => {
    const { a, session } = await boot();
    await edit(a, session, { action: 'save-template', name: 'e2e', image: IMAGE, secrets: ['E2E_PASSWORD'], egress: [HOST] });
    await edit(a, session, { action: 'approve-template', name: 'e2e' });
    await edit(a, session, { action: 'save-template', name: 'e2e', image: IMAGE, secrets: ['E2E_PASSWORD'], egress: [HOST, 'pypi.org:443'] });
    expect(await template(a, 'e2e')).toMatchObject({ pending: { egress: ['pypi.org:443'] }, gives: [] });

    await edit(a, session, { action: 'save-template', name: 'e2e', image: IMAGE, secrets: ['E2E_PASSWORD'], egress: [] });
    expect(await template(a, 'e2e')).toMatchObject({ pending: { egress: [] }, gives: ['E2E_PASSWORD'] });
    // A save that leaves egress out keeps the hosts it has, as tools.
    await edit(a, session, { action: 'save-template', name: 'e2e', image: IMAGE, secrets: ['E2E_PASSWORD'], egress: [HOST] });
    await edit(a, session, { action: 'save-template', name: 'e2e', image: IMAGE, secrets: ['E2E_PASSWORD'] });
    expect(await template(a, 'e2e')).toMatchObject({ egress: [HOST] });
  });

  it('refuses an egress host that is not host:port', async () => {
    const { a, session } = await boot();
    for (const host of ['auth.example.test', 'https://auth.example.test:443', 'auth.example.test:0', 'auth.example.test:70000', '*.example.test:443', 'a b:443', ':443']) {
      const r = await edit(a, session, { action: 'save-template', name: 'e2e', image: IMAGE, secrets: [], egress: [host] });
      expect(r.status, host).toBe(400);
      expect(r.body.error, host).toMatch(/egress host/);
    }
  });
});
