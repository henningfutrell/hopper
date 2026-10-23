// Draining a machine (issue #1511) through the real daemon, store and HTTP server: an admin drains a machine
// (POST /ui/api/machines/drain, one machine.drained); the job on it runs to its end, a new job is held there with why, and
// GET /api/machines shows it drained; undrained (one machine.undrained), the held job starts. The drain is kept in the
// user's settings, so a restart keeps it. `hopper machine list|drain|undrain` does the same through the same routes.
// Issue #2499: a drain names its reason and ends by itself (`hours`, a day when not named); one with no reason is refused.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import { databaseUrlFor } from '../support/database.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

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
  const a = await startTestApp({ dbPath: path, plugins: { machines: lanes(2) } });
  apps.push(a);
  return a;
}

const local = async (a: TestApp): Promise<MachineSnapshot> =>
  ((await a.api('GET', '/api/machines')).body.machines as MachineSnapshot[]).find((m) => m.id === 'local')!;

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: () => {} };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, out: out.join('') };
}

describe('draining a machine', () => {
  it('stops new placement, lets the running job end, shows drained; undrained, the held job starts', async () => {
    const a = await boot();
    const admin = await a.login();
    const running = await a.waitForStatus((await a.pull({ op: 'sleep', ms: 1500 })).id, 'running');

    const drained = await a.ui('/ui/api/machines/drain', { machineId: 'local', drained: true, reason: 'seat rebuild', hours: 2 }, { token: admin });
    expect(drained.status).toBe(200);
    expect(drained.body).toEqual({ machineId: 'local', drained: true, jobs: 1 });
    const mark = (await local(a)).drained!;
    expect(mark).toEqual({ person: expect.any(String), via: 'ui', at: expect.any(String), reason: 'seat rebuild', until: expect.any(String) });
    expect(Date.parse(mark.until!) - Date.parse(mark.at)).toBe(2 * 3_600_000);

    const waiting = await a.pull({ op: 'echo' });
    await waitFor(async () => (await a.job(waiting.id)).holdReason === 'local is drained: no new job is claimed there' || undefined);
    await a.waitForStatus(running.id, 'finished');
    expect((await a.job(waiting.id)).status).toBe('held');

    // Again: nothing changes, nothing is recorded.
    expect((await a.ui('/ui/api/machines/drain', { machineId: 'local', drained: true, reason: 'other' }, { token: admin })).status).toBe(200);
    expect((await local(a)).drained?.reason).toBe('seat rebuild');
    const undrained = await a.ui('/ui/api/machines/drain', { machineId: 'local', drained: false }, { token: admin });
    expect(undrained.body).toEqual({ machineId: 'local', drained: false, jobs: expect.any(Number) });
    await a.waitForStatus(waiting.id, 'finished');
    expect((await local(a)).drained).toBeUndefined();
    expect((await a.events('types=machine.drained,machine.undrained')).map((e) => [e.type, e.data])).toEqual([
      ['machine.drained', { machineId: 'local', person: expect.any(String), via: 'ui', reason: 'seat rebuild', until: mark.until }],
      ['machine.undrained', { machineId: 'local', person: expect.any(String), via: 'ui' }],
    ]);
  });

  it('refuses a machine it does not know, and a session that is not an admin\'s', async () => {
    const a = await boot();
    const admin = await a.login();
    expect((await a.ui('/ui/api/machines/drain', { machineId: 'nowhere', drained: true, reason: 'rebuild' }, { token: admin })).status).toBe(404);
    // Issue #2499: a drain names why; its hours are 1 to 720.
    expect((await a.ui('/ui/api/machines/drain', { machineId: 'local', drained: true }, { token: admin })).status).toBe(400);
    expect((await a.ui('/ui/api/machines/drain', { machineId: 'local', drained: true, reason: '  ' }, { token: admin })).status).toBe(400);
    expect((await a.ui('/ui/api/machines/drain', { machineId: 'local', drained: true, reason: 'x', hours: 0 }, { token: admin })).status).toBe(400);
    expect((await a.ui('/ui/api/machines/drain', { machineId: 'local', drained: true, reason: 'x', hours: 721 }, { token: admin })).status).toBe(400);
    expect((await local(a)).drained).toBeUndefined();
    expect((await a.ui('/ui/api/machines/drain', { machineId: 'local' }, { token: admin })).status).toBe(400);
    expect([401, 403]).toContain((await a.ui('/ui/api/machines/drain', { machineId: 'local', drained: true, reason: 'rebuild' })).status);
  });

  it('a restart keeps the drain', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const first = await boot(db.dbPath);
    await first.ui('/ui/api/machines/drain', { machineId: 'local', drained: true, reason: 'rebuild' }, { token: await first.login() });
    await first.stop();
    apps.splice(apps.indexOf(first), 1);
    const again = await boot(db.dbPath);
    expect((await local(again)).drained).toMatchObject({ via: 'ui', reason: 'rebuild', until: expect.any(String) });
  });

  it('hopper machine drain, list and undrain act as the UI does', async () => {
    const a = await boot();
    expect((await hopper(a, ['machine', 'drain', 'local'])).code).toBe(2);
    const drain = await hopper(a, ['machine', 'drain', 'local', '--reason', 'seat rebuild', '--hours', '3']);
    expect(drain.code).toBe(0);
    expect(JSON.parse(drain.out)).toEqual({ machineId: 'local', drained: true, jobs: 0 });
    const list = await hopper(a, ['machine', 'list']);
    expect(JSON.parse(list.out)).toEqual([expect.objectContaining({ id: 'local', drained: expect.objectContaining({ via: 'cli', reason: 'seat rebuild', until: expect.any(String) }) })]);
    expect(JSON.parse((await hopper(a, ['machine', 'undrain', 'local'])).out)).toMatchObject({ drained: false });
    expect(JSON.parse((await hopper(a, ['machine', 'list'])).out)[0]).not.toHaveProperty('drained');
    expect((await hopper(a, ['machine', 'drain'])).code).toBe(2);
  });
});
