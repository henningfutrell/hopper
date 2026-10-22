// Issue #2272 part 2: the user's Podman hosts through the real daemon, store and HTTP server. An admin adds one with the
// host key they confirmed (POST /ui/api/podman-hosts, the whole list against the version read), GET /api/podman-hosts
// shows it, and the sandbox host may then name it. A record that is not one, and an edit against an old version, are
// refused. `hopper machine podman-host` lists, adds and removes them through the same routes; without --host-key, add
// only reads the host's key for the person to compare, and adds nothing. GET /api/podman-hosts/status reads each host now.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { PodmanHostsStatusView, PodmanHostsView } from '../../src/domain/podman-hosts.ts';
import { databaseUrlFor } from '../support/database.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(1) } });
  apps.push(a);
  return a;
}

const view = async (a: TestApp): Promise<PodmanHostsView> => (await a.api('GET', '/api/podman-hosts')).body as PodmanHostsView;

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: () => {} };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, out: out.join('') };
}

describe('the Podman hosts (issue #2272)', () => {
  it('an admin adds one, and the sandbox host may name it', async () => {
    const a = await boot();
    const admin = await a.login();
    const empty = await view(a);
    expect(empty.hosts).toEqual([]);
    const host = { name: 'box-vm', ssh: 'sandbox@box-vm', hostKey: KEY, cpus: 4, memoryMb: 8192 };
    const saved = await a.ui('/ui/api/podman-hosts', { hosts: [host], version: empty.version }, { token: admin });
    expect(saved.status).toBe(200);
    expect((saved.body as PodmanHostsView).hosts).toEqual([host]);
    expect((await view(a)).hosts).toEqual([host]);
    // An edit against the old version is refused; so is a host that is not one.
    expect((await a.ui('/ui/api/podman-hosts', { hosts: [], version: empty.version }, { token: admin })).status).toBe(409);
    expect((await a.ui('/ui/api/podman-hosts', { hosts: [{ ...host, name: 'local' }], version: (await view(a)).version }, { token: admin })).status).toBe(400);
    expect([401, 403]).toContain((await a.ui('/ui/api/podman-hosts', { hosts: [], version: (await view(a)).version })).status);
    // The sandbox host names it now; a Podman host it does not have is still not found.
    expect((await a.ui('/ui/api/machines/sandbox-host', { hosts: ['box-vm', 'local'] }, { token: admin })).body).toEqual({ hosts: ['box-vm', 'local'] });
    expect((await a.ui('/ui/api/machines/sandbox-host', { hosts: ['other-vm'] }, { token: admin })).status).toBe(404);
  });

  it('hopper machine podman-host lists, adds with a confirmed key, and removes', async () => {
    const a = await boot();
    expect(JSON.parse((await hopper(a, ['machine', 'podman-host', 'list'])).out)).toEqual([]);
    const added = await hopper(a, ['machine', 'podman-host', 'add', 'box-vm', 'sandbox@box-vm', '--host-key', KEY, '--cpus', '2', '--memory-mb', '4096']);
    expect(added.code).toBe(0);
    expect(JSON.parse(added.out)).toEqual([{ name: 'box-vm', ssh: 'sandbox@box-vm', hostKey: KEY, cpus: 2, memoryMb: 4096 }]);
    expect((await view(a)).hosts.map((h) => h.name)).toEqual(['box-vm']);
    expect((await hopper(a, ['machine', 'podman-host', 'add', 'box-vm', 'sandbox@box-vm', '--host-key', KEY])).code).toBe(2);
    expect(JSON.parse((await hopper(a, ['machine', 'podman-host', 'remove', 'box-vm'])).out)).toEqual([]);
    expect((await hopper(a, ['machine', 'podman-host', 'remove', 'box-vm'])).code).toBe(2);
    expect((await hopper(a, ['machine', 'podman-host', 'add', 'box-vm'])).code).toBe(2);
  });

  it('the status of no Podman host is an empty list', async () => {
    const a = await boot();
    const r = await a.api('GET', '/api/podman-hosts/status');
    expect(r.status).toBe(200);
    expect(r.body as PodmanHostsStatusView).toEqual({ hosts: [] });
  });
});
