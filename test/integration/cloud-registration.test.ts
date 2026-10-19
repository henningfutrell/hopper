// Registering the instance at hopper.io (issue #465, design.md "Registering at hopper.io"): Settings → hopper.io, the
// hopper's admin's. A real daemon over the real database.
//   Scenario: the link's id is the instance id, also after an unlink and a link again; the admin mints a registration
//     code while linked, shown once, and the link shows only when it expires; each mint is an event with no code
//   Scenario: no link, no code (409); a body other than {} is 400; only the admin mints a code
import { afterEach, describe, expect, it } from 'vitest';
import type { CloudLinkView, RegistrationCodeMinted } from '../../src/domain/cloud-link.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  t = await startTestApp({ dbPath: db.dbPath });
  return t;
}

const get = async <T>(a: TestApp, token: string, path: string): Promise<T> => (await a.api('GET', path, undefined, { 'x-hopper-session': token })).body as T;

describe('registering the instance at hopper.io', () => {
  it('the link\'s id is the instance id, also after a link again; the admin mints a code while linked, shown once; each mint is an event', async () => {
    const a = await boot();
    const token = await a.login();
    const { instanceId } = await get<{ instanceId: string }>(a, token, '/api/display-name');

    expect((await a.ui<CloudLinkView>('/ui/api/cloud-link', { account: 'octo-cat' }, { token })).body.link?.installId).toBe(instanceId);
    const minted = await a.ui<RegistrationCodeMinted>('/ui/api/cloud-link/registration-code', {}, { token });
    expect(minted.status).toBe(200);
    expect(minted.body.code).toMatch(/^[0-9a-f]{64}$/);
    const view = await get<CloudLinkView>(a, token, '/api/cloud-link');
    expect(view.registrationCode).toEqual({ expiresAt: minted.body.expiresAt, by: expect.any(String) });
    expect(JSON.stringify(view)).not.toContain(minted.body.code);

    const events = await a.events('types=cloud_link.registration_code_minted');
    expect(events.map((e) => e.data)).toEqual([{ installId: instanceId, account: 'octo-cat', expiresAt: minted.body.expiresAt, by: expect.any(String) }]);
    expect(JSON.stringify(events)).not.toContain(minted.body.code);

    expect((await a.ui<CloudLinkView>('/ui/api/cloud-link/unlink', {}, { token })).body).toEqual({ link: null });
    expect((await a.ui<CloudLinkView>('/ui/api/cloud-link', { account: 'octo-cat' }, { token })).body).toEqual({ link: expect.objectContaining({ installId: instanceId, state: 'pending' }), connection: { state: 'no-pin' } });
  });

  it('no link, no code (409); a body other than {} is 400; only the admin mints a code', async () => {
    const a = await boot();
    const token = await a.login();
    expect((await a.ui('/ui/api/cloud-link/registration-code', {}, { token })).status).toBe(409);
    await a.ui('/ui/api/cloud-link', { account: 'octo-cat' }, { token });
    expect((await a.ui('/ui/api/cloud-link/registration-code', { code: 'x' }, { token })).status).toBe(400);
    const other = await a.addUser('octo2');
    expect((await a.ui('/ui/api/cloud-link/registration-code', {}, { token: await a.login(other.id) })).status).toBe(403);
    expect((await get<CloudLinkView>(a, token, '/api/cloud-link')).registrationCode).toBeUndefined();
  });
});
