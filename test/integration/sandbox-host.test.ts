// The sandbox host (issue #2272) through the real daemon, store and HTTP server: an admin names the machines the user's
// sandboxes start on (POST /ui/api/machines/sandbox-host, one machine.sandbox_host_set), GET /api/machines shows it and
// marks each machine of it with its place, and clearing it records one more event. A machine it does not know is
// refused, and so is a list that names a machine twice. It is kept in the user's settings, so a restart keeps it.
// `hopper machine sandbox-host` does the same through the same routes.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import { databaseUrlFor } from '../support/database.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(dbPath?: string): Promise<TestApp> {
  let path = dbPath;
  if (!path) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    path = db.dbPath;
  }
  const a = await startTestApp({ dbPath: path, plugins: { machines: lanes(1) } });
  apps.push(a);
  return a;
}

const machines = async (a: TestApp): Promise<{ machines: MachineSnapshot[]; sandboxHost?: string[] }> => (await a.api('GET', '/api/machines')).body as { machines: MachineSnapshot[]; sandboxHost?: string[] };

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: () => {} };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, out: out.join('') };
}

describe('the sandbox host (issue #2272)', () => {
  it('an admin names it, Machines shows it, and clearing it records one more event', async () => {
    const a = await boot();
    const admin = await a.login();
    expect((await machines(a)).sandboxHost).toBeUndefined();
    const set = await a.ui('/ui/api/machines/sandbox-host', { hosts: ['local'] }, { token: admin });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ hosts: ['local'] });
    const view = await machines(a);
    expect(view.sandboxHost).toEqual(['local']);
    expect(view.machines.find((m) => m.id === 'local')!.sandboxHost).toBe(1);
    // Again: nothing changes, nothing is recorded.
    expect((await a.ui('/ui/api/machines/sandbox-host', { hosts: ['local'] }, { token: admin })).status).toBe(200);
    expect((await a.ui('/ui/api/machines/sandbox-host', { hosts: [] }, { token: admin })).body).toEqual({ hosts: [] });
    expect((await machines(a)).sandboxHost).toBeUndefined();
    expect((await a.events('types=machine.sandbox_host_set')).map((e) => e.data)).toEqual([
      { hosts: ['local'], was: [], person: expect.any(String), via: 'ui' },
      { hosts: [], was: ['local'], person: expect.any(String), via: 'ui' },
    ]);
  });

  it('refuses a machine it does not know, a machine named twice, and a session that is not an admin\'s', async () => {
    const a = await boot();
    const admin = await a.login();
    expect((await a.ui('/ui/api/machines/sandbox-host', { hosts: ['nowhere'] }, { token: admin })).status).toBe(404);
    expect((await a.ui('/ui/api/machines/sandbox-host', { hosts: ['local', 'local'] }, { token: admin })).status).toBe(400);
    expect((await a.ui('/ui/api/machines/sandbox-host', { hosts: 'local' }, { token: admin })).status).toBe(400);
    expect([401, 403]).toContain((await a.ui('/ui/api/machines/sandbox-host', { hosts: ['local'] })).status);
  });

  it('a restart keeps it', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const first = await boot(db.dbPath);
    await first.ui('/ui/api/machines/sandbox-host', { hosts: ['local'] }, { token: await first.login() });
    await first.stop();
    apps.splice(apps.indexOf(first), 1);
    expect((await machines(await boot(db.dbPath))).sandboxHost).toEqual(['local']);
  });

  it('hopper machine sandbox-host names it, prints it and clears it as the UI does', async () => {
    const a = await boot();
    expect(JSON.parse((await hopper(a, ['machine', 'sandbox-host'])).out)).toEqual({ hosts: [] });
    const set = await hopper(a, ['machine', 'sandbox-host', 'local']);
    expect(set.code).toBe(0);
    expect(JSON.parse(set.out)).toEqual({ hosts: ['local'] });
    expect(JSON.parse((await hopper(a, ['machine', 'sandbox-host'])).out)).toEqual({ hosts: ['local'] });
    expect(JSON.parse((await hopper(a, ['machine', 'sandbox-host', '--clear'])).out)).toEqual({ hosts: [] });
    expect((await a.events('types=machine.sandbox_host_set')).map((e) => e.data.via)).toEqual(['cli', 'cli']);
    expect((await hopper(a, ['machine', 'sandbox-host', '--bogus'])).code).toBe(2);
  });
});
