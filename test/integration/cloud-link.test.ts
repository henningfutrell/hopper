// The cloud link (issue #467, design.md "The cloud link"): the hopper's admin links this install to an account at
// hopper.io, and unlinks it, in Settings, while it runs. A real daemon over the real database.
//   Scenario: a link and an unlink during a running job apply at once, end no job and are each an event
//   Scenario: a link is kept across a restart; a second link is 409; a bad account is 400; only the admin links
import { afterEach, describe, expect, it } from 'vitest';
import type { CloudLinkView } from '../../src/domain/cloud-link.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

async function boot(dbPath?: string): Promise<TestApp> {
  if (!dbPath) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    dbPath = db.dbPath;
  }
  t = await startTestApp({ dbPath });
  return t;
}

const view = async (a: TestApp, token: string): Promise<CloudLinkView> => (await a.api('GET', '/api/cloud-link', undefined, { 'x-hopper-session': token })).body as CloudLinkView;

describe('the cloud link', () => {
  it('a link and an unlink during a running job apply at once, end no job and are each an event', async () => {
    const a = await boot();
    const token = await a.login();
    const job = await a.pull({ op: 'sleep', ms: 30_000 });
    await a.waitForStatus(job.id, 'running');
    expect(await view(a, token)).toEqual({ link: null });

    const linked = await a.ui<CloudLinkView>('/ui/api/cloud-link', { account: ' Octo-Cat ' }, { token });
    expect(linked.status).toBe(200);
    expect(linked.body.link).toMatchObject({ account: 'octo-cat', state: 'pending', installId: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(await view(a, token)).toEqual(linked.body);
    expect((await a.job(job.id)).status).toBe('running');

    expect((await a.ui<CloudLinkView>('/ui/api/cloud-link/unlink', {}, { token })).body).toEqual({ link: null });
    expect((await a.ui<CloudLinkView>('/ui/api/cloud-link/unlink', {}, { token })).body).toEqual({ link: null });
    expect((await a.job(job.id)).status).toBe('running');
    const installId = linked.body.link!.installId;
    expect((await a.events('types=cloud_link.linked,cloud_link.unlinked')).map((e) => [e.type, e.data])).toEqual(expect.arrayContaining([
      ['cloud_link.linked', { installId, account: 'octo-cat', by: expect.any(String) }],
      ['cloud_link.unlinked', { installId, account: 'octo-cat', by: expect.any(String) }],
    ]));
    expect((await a.events('types=cloud_link.linked,cloud_link.unlinked'))).toHaveLength(2);
  });

  it('a link is kept across a restart; a second link is 409; a bad account is 400; only the admin links', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    let a = await boot(db.dbPath);
    let token = await a.login();
    for (const bad of [{}, { account: '' }, { account: 'a b' }, { account: 'x'.repeat(40) }, { account: 'octo', extra: 1 }]) {
      expect((await a.ui('/ui/api/cloud-link', bad, { token })).status, JSON.stringify(bad)).toBe(400);
    }
    const first = (await a.ui<CloudLinkView>('/ui/api/cloud-link', { account: 'octo' }, { token })).body;
    expect((await a.ui('/ui/api/cloud-link', { account: 'other' }, { token })).status).toBe(409);

    await a.stop();
    a = await boot(db.dbPath);
    token = await a.login();
    expect(await view(a, token)).toEqual(first);

    const other = await a.addUser('octo2');
    const otherToken = await a.login(other.id);
    expect((await a.ui('/ui/api/cloud-link/unlink', {}, { token: otherToken })).status).toBe(403);
    expect((await a.api('GET', '/api/cloud-link', undefined, { 'x-hopper-session': otherToken })).status).toBe(403);
    expect(await view(a, token)).toEqual(first);
  });
});
