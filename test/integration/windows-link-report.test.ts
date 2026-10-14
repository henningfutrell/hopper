// The Windows link report (issue #712, the path "The Windows keep-alive loop reports the Windows link"): the keep-alive
// loop on Windows tests whether Windows opens the hopper at localhost and reports it with `hopper windows-link report`.
// The CLI action is one POST /ui/api/windows-link, an admin's; the daemon keeps the report in memory, /api/machines
// carries it for the banner, and a broken link is told once as the machine `windows`. Real daemon, real database, real CLI.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { WindowsLink } from '../../src/domain/types.ts';
import { databaseUrlFor } from '../support/database.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const URL_ = 'http://localhost:4790/job/address';

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath });
  apps.push(a);
  return a;
}

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, out: out.join(''), err: err.join('') };
}

const machinesView = async (a: TestApp) => (await a.api<{ windowsLink?: WindowsLink }>('GET', '/api/machines')).body;

describe('the Windows link report', () => {
  it('the CLI reports a broken link: /api/machines carries it, and machine.windows_link_broken is told once', async () => {
    const a = await boot();
    expect(await machinesView(a)).not.toHaveProperty('windowsLink');
    const r = await hopper(a, ['windows-link', 'report', '--link', URL_, '--mode', 'mirrored', '--error', 'The operation has timed out.']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).windowsLink).toMatchObject({ url: URL_, mode: 'mirrored', ok: false, error: 'The operation has timed out.' });
    expect((await machinesView(a)).windowsLink).toMatchObject({ url: URL_, mode: 'mirrored', ok: false });
    const broken = await waitFor(async () => (await a.events('types=machine.windows_link_broken'))[0]);
    expect(broken.data).toEqual({ machineId: 'windows', url: URL_, mode: 'mirrored', error: 'The operation has timed out.' });

    expect((await hopper(a, ['windows-link', 'report', '--link', URL_, '--mode', 'mirrored', '--error', 'The operation has timed out.'])).code).toBe(0);
    expect(await a.events('types=machine.windows_link_broken')).toHaveLength(1);

    // Any HTTP answer means the hopper answered, an error status too.
    expect((await hopper(a, ['windows-link', 'report', '--link', URL_, '--status', '401'])).code).toBe(0);
    expect((await machinesView(a)).windowsLink).toMatchObject({ ok: true, status: 401 });
    await waitFor(async () => (await a.events('types=machine.windows_link_restored'))[0]);

    // Only 127.0.0.1 answered; a loop written before the address check reports the health route at localhost.
    for (const link of ['http://127.0.0.1:4790/job/address', 'http://localhost:4790/api/health']) {
      expect((await hopper(a, ['windows-link', 'report', '--link', link, '--status', '204'])).code).toBe(0);
      expect((await machinesView(a)).windowsLink).toMatchObject({ url: link, ok: true });
    }
  });

  it('refuses a report that is not the address check at localhost or 127.0.0.1 with one status or one error', async () => {
    const a = await boot();
    for (const argv of [
      ['--link', 'http://10.0.0.1:4790/job/address', '--status', '200'],
      ['--link', 'http://127.0.0.1:4790/api/health', '--status', '200'],
      ['--link', URL_],
      ['--link', URL_, '--status', '200', '--error', 'both'],
      ['--link', URL_, '--status', '42'],
      ['--link', URL_, '--status', '200', '--mode', 'Not A Mode'],
    ]) {
      const r = await hopper(a, ['windows-link', 'report', ...argv]);
      expect(r.code, argv.join(' ')).toBe(2);
    }
    expect(await machinesView(a)).not.toHaveProperty('windowsLink');
  });

  it('is an admin\'s: the route refuses another body and no session', async () => {
    const a = await boot();
    const admin = await a.login();
    expect((await a.ui('/ui/api/windows-link', { url: URL_, status: 200 })).status).toBe(403);
    expect((await a.ui('/ui/api/windows-link', { url: URL_, status: 200, ok: true }, { token: admin })).status).toBe(400);
    expect((await a.ui('/ui/api/windows-link', { url: URL_, status: 200 }, { token: admin })).status).toBe(200);
  });
});
