// The operator CLI (src/cli.ts, design.md "Operator CLI"): config records read and replaced as JSON in
// the daemon's own database, against their version.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli.ts';
import { openInstanceStore } from '../src/store/index.ts';
import { openAdminStore } from './support/files.ts';
import { testDatabaseUrl } from './support/database.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function db(): string {
  const d = mkdtempSync(`${tmpdir()}/jh-cli-`);
  dirs.push(d);
  return testDatabaseUrl();
}

function cli(url: string | undefined, argv: string[], o: { stdin?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: url ? { HOPPER_DATABASE_URL: url } : {}, stdin: () => o.stdin ?? '', out: (t) => out.push(t), err: (t) => err.push(t) };
  const code = runCli(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

function recordIn(url: string, name: 'plugins' | 'rules'): unknown {
  const s = openAdminStore(url);
  try { return s.config.read(name); } finally { s.close(); }
}

const PLUGINS = { version: 1, executors: [{ name: 'test', plugin: 'test' }] };
const json = (x: unknown): string => JSON.stringify(x);

describe('hopper config', () => {
  it('needs HOPPER_DATABASE_URL and says so', () => {
    const r = cli(undefined, ['config', 'get', 'rules']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/HOPPER_DATABASE_URL is not set/);
  });

  it('reads the database URL from a mounted secret file, HOPPER_DATABASE_URL_FILE (issue #56)', () => {
    const url = db();
    const d = mkdtempSync(`${tmpdir()}/jh-cli-url-`);
    dirs.push(d);
    writeFileSync(`${d}/url`, `${url}\n`, { mode: 0o600 });
    const out: string[] = [];
    const code = runCli(['config', 'version', 'rules'], { env: { HOPPER_DATABASE_URL_FILE: `${d}/url` }, stdin: () => '', out: (t) => out.push(t), err: () => {} });
    expect(code).toBe(0);
    expect(out.join('')).toBe('missing\n');
  });

  it('refuses an unknown record or command', () => {
    expect(cli(db(), ['config', 'get', 'plugins.yaml']).err).toMatch(/unknown config record plugins.yaml; one of plugins, rules, sign-in/);
    expect(cli(db(), ['deploy']).code).toBe(2);
  });

  it('has no edit: config edit prints the usage, exit 2, and writes nothing', () => {
    const url = db();
    const r = cli(url, ['config', 'edit', 'plugins']);
    expect(r).toMatchObject({ code: 2, out: '' });
    expect(r.err).toContain('hopper config set <record>');
    expect(recordIn(url, 'plugins')).toBeUndefined();
  });

  it('set writes a new record against "missing"; get prints it as JSON; version names it', () => {
    const url = db();
    expect(cli(url, ['config', 'get', 'rules'])).toMatchObject({ code: 2, err: expect.stringMatching(/rules: none yet/) });
    expect(cli(url, ['config', 'set', 'rules', '--if-version', 'missing'], { stdin: json('be brief\n') }).code).toBe(0);
    expect(cli(url, ['config', 'get', 'rules'])).toMatchObject({ code: 0, out: `${json('be brief\n')}\n` });
    expect(cli(url, ['config', 'version', 'rules']).out).toMatch(/^[0-9a-f]{64}\n$/);
  });

  it('get plugins prints the plugins config as JSON', () => {
    const url = db();
    expect(cli(url, ['config', 'set', 'plugins', '--if-version', 'missing'], { stdin: json(PLUGINS) }).code).toBe(0);
    const r = cli(url, ['config', 'get', 'plugins']);
    expect(r).toMatchObject({ code: 0, out: `${JSON.stringify(PLUGINS, null, 2)}\n` });
    expect(JSON.parse(r.out)).toEqual(PLUGINS);
  });

  it('set without --if-version writes nothing, and a stale version is refused', () => {
    const url = db();
    expect(cli(url, ['config', 'set', 'rules'], { stdin: json('x') })).toMatchObject({ code: 2, err: expect.stringMatching(/--if-version/) });
    expect(recordIn(url, 'rules')).toBeUndefined();
    cli(url, ['config', 'set', 'rules', '--if-version', 'missing'], { stdin: json('one') });
    const r = cli(url, ['config', 'set', 'rules', '--if-version', 'missing'], { stdin: json('two') });
    expect(r).toMatchObject({ code: 2, err: expect.stringMatching(/rules changed since version missing/) });
    expect(recordIn(url, 'rules')).toBe('one');
  });

  it('a plugins config that would not load, or is not JSON, is refused, nothing written', () => {
    const url = db();
    const r = cli(url, ['config', 'set', 'plugins', '--if-version', 'missing'], { stdin: json({ version: 2 }) });
    expect(r).toMatchObject({ code: 2, err: expect.stringMatching(/plugins refused, nothing written: version/) });
    expect(cli(url, ['config', 'set', 'plugins', '--if-version', 'missing'], { stdin: '{ "executors": [' }).err).toMatch(/plugins refused, nothing written: not valid JSON/);
    expect(cli(url, ['config', 'set', 'plugins', '--if-version', 'missing'], { stdin: 'version: 1\n' }).err).toMatch(/not valid JSON/);
    expect(recordIn(url, 'plugins')).toBeUndefined();
    expect(cli(url, ['config', 'set', 'plugins', '--if-version', 'missing'], { stdin: json(PLUGINS) }).code).toBe(0);
    expect(recordIn(url, 'plugins')).toEqual(PLUGINS);
  });

  it('set replaces the record against the version read', () => {
    const url = db();
    cli(url, ['config', 'set', 'plugins', '--if-version', 'missing'], { stdin: json(PLUGINS) });
    const version = cli(url, ['config', 'version', 'plugins']).out.trim();
    const next = { version: 1, executors: [{ name: 't2', plugin: 'test' }] };
    expect(cli(url, ['config', 'set', 'plugins', '--if-version', version], { stdin: json(next) }).code).toBe(0);
    expect(recordIn(url, 'plugins')).toEqual(next);
    expect(cli(url, ['config', 'set', 'plugins', '--if-version', version], { stdin: json(PLUGINS) }))
      .toMatchObject({ code: 2, err: expect.stringMatching(/plugins changed since version/) });
    expect(recordIn(url, 'plugins')).toEqual(next);
  });
});

describe('hopper login-code', () => {
  it('mints a one-time code into the database and prints it; --link prints the device link', () => {
    const url = db();
    const a = cli(url, ['login-code']);
    expect(a).toMatchObject({ code: 0, out: expect.stringMatching(/^[0-9a-f]{64}\n$/) });
    const b = cli(url, ['login-code', '--link', 'https://hopper.example.com/']);
    expect(b.out).toMatch(/^https:\/\/hopper\.example\.com\/#login=[0-9a-f]{64}\n$/);
    const s = openInstanceStore({ url, clock: { now: () => new Date() } });
    const hash = (c: string) => createHash('sha256').update(c).digest('hex');
    expect(s.loginCodes.take(hash(a.out.trim()), new Date().toISOString())).toBe('admin');
    expect(s.loginCodes.take(hash(a.out.trim()), new Date().toISOString())).toBeUndefined();
    s.close();
  });
});

describe('hopper config set sign-in (issue #200)', () => {
  it('refuses password accounts in the record: Settings → Sign-in keeps them', () => {
    const url = db();
    const version = cli(url, ['config', 'version', 'sign-in']).out.trim();
    const record = { version: 1, realms: [{ name: 'staff', type: 'password', users: [{ username: 'ada', passwordHash: '$argon2id$x', role: 'admin' }] }] };
    expect(cli(url, ['config', 'set', 'sign-in', '--if-version', version], { stdin: JSON.stringify(record) }))
      .toMatchObject({ code: 2, err: expect.stringMatching(/realms\.0\.users: password accounts are not part of the record/) });
    expect(cli(url, ['config', 'set', 'sign-in', '--if-version', version], { stdin: JSON.stringify({ version: 1, local: { enabled: true }, realms: [{ name: 'staff', type: 'password' }] }) }).code).toBe(0);
  });
});

describe('hopper help (issue #68)', () => {
  it.each([['help'], ['--help'], ['-h']])('%s prints every command with what it does, and where to read on; needs no database', (arg) => {
    const r = cli(undefined, [arg]);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    for (const command of ['config get', 'config version', 'config set', 'login-code', 'users', 'user add', 'help']) {
      expect(r.out).toContain(`hopper ${command}`);
    }
    expect(r.out).toMatch(/HOPPER_DATABASE_URL/);
    expect(r.out).toMatch(/node src\/main\.ts --help/);
    expect(r.out).toMatch(/\/docs\//);
    expect(r.out).not.toContain('config edit');
  });

  it('no command or an unknown one: the same text on stderr, exit 2', () => {
    for (const argv of [[], ['frobnicate']]) {
      const r = cli(undefined, argv);
      expect(r.code).toBe(2);
      expect(r.out).toBe('');
      expect(r.err).toContain('hopper config set');
    }
  });
});

describe('several users (issue #158)', () => {
  const hash = (c: string) => createHash('sha256').update(c).digest('hex');

  it('hopper users lists every user; hopper user add adds one under a free name', () => {
    const url = db();
    expect(cli(url, ['users'])).toMatchObject({ code: 0, out: expect.stringMatching(/^admin\tadmin\t\S+\n$/) });
    expect(cli(url, ['user', 'add', 'Bea Smith'])).toMatchObject({ code: 0, out: 'bea_smith\n' });
    expect(cli(url, ['user', 'add', 'bea smith'])).toMatchObject({ code: 2, err: expect.stringMatching(/name bea smith is taken/) });
    expect(cli(url, ['user', 'add'])).toMatchObject({ code: 2, err: expect.stringMatching(/user add <name>/) });
    expect(cli(url, ['users']).out.split('\n').filter(Boolean).map((l) => l.split('\t').slice(0, 2))).toEqual([['admin', 'admin'], ['bea_smith', 'Bea Smith']]);
  });

  it('login-code --user mints a code for that user; an unknown user is refused', () => {
    const url = db();
    cli(url, ['user', 'add', 'bea']);
    const code = cli(url, ['login-code', '--user', 'bea']).out.trim();
    const s = openInstanceStore({ url, clock: { now: () => new Date() } });
    expect(s.loginCodes.take(hash(code), new Date().toISOString())).toBe('bea');
    s.close();
    expect(cli(url, ['login-code', '--user', 'nobody'])).toMatchObject({ code: 2, err: expect.stringMatching(/no user nobody/) });
  });

  it('config --user edits that user\'s records; sign-in is the instance\'s and refuses --user', () => {
    const url = db();
    cli(url, ['user', 'add', 'bea']);
    expect(cli(url, ['config', 'set', 'rules', '--user', 'bea', '--if-version', 'missing'], { stdin: json('bea rules') }).code).toBe(0);
    expect(cli(url, ['config', 'get', 'rules', '--user', 'bea']).out).toBe(`${json('bea rules')}\n`);
    expect(recordIn(url, 'rules')).toBeUndefined();
    expect(cli(url, ['config', 'get', 'sign-in', '--user', 'bea'])).toMatchObject({ code: 2, err: expect.stringMatching(/sign-in is the instance's/) });
    expect(cli(url, ['config', 'get', 'rules', '--user', 'nobody'])).toMatchObject({ code: 2, err: expect.stringMatching(/no user nobody/) });
  });
});

describe('hopper user transfer (issue #212)', () => {
  const instanceOf = (url: string) => openInstanceStore({ url, clock: { now: () => new Date() } });

  /** admin with work (a job, its rules), and `bea`, signing in on the password realm, with none. */
  function adminAndBea(): string {
    const url = db();
    cli(url, ['user', 'add', 'bea']);
    const s = instanceOf(url);
    s.identities.link('password', 'bea', 'bea');
    s.close();
    const admin = openAdminStore(url);
    admin.jobs.create({ executor: 'test', payload: {} }, 5);
    admin.close();
    expect(cli(url, ['config', 'set', 'rules', '--if-version', 'missing'], { stdin: json('admin rules') }).code).toBe(0);
    return url;
  }

  it('bea takes over everything admin held; bea\'s own empty record is gone', () => {
    const url = adminAndBea();
    const r = cli(url, ['user', 'transfer', 'admin', 'bea']);
    expect(r).toMatchObject({ code: 0, err: expect.stringMatching(/bea now holds admin's work/) });
    expect(cli(url, ['users']).out).toMatch(/^admin\tbea\t\S+\n$/);
    const s = instanceOf(url);
    expect(s.identities.userOf('password', 'bea')).toBe('admin');
    const store = s.userStore(s.users.admin());
    expect(store.jobs.list()).toHaveLength(1);
    store.close();
    s.close();
    expect(cli(url, ['config', 'get', 'rules']).out).toBe(`${json('admin rules')}\n`);
  });

  it('moves the sessions and login codes of the user that takes over', () => {
    const url = adminAndBea();
    const code = cli(url, ['login-code', '--user', 'bea']).out.trim();
    expect(cli(url, ['user', 'transfer', 'admin', 'bea']).code).toBe(0);
    const s = instanceOf(url);
    expect(s.loginCodes.take(createHash('sha256').update(code).digest('hex'), new Date().toISOString())).toBe('admin');
    s.close();
  });

  it('refuses when the user taking over holds work of its own: nothing is lost, nothing changes', () => {
    const url = adminAndBea();
    const s = instanceOf(url);
    const bea = s.userStore(s.users.get('bea')!);
    bea.jobs.create({ executor: 'test', payload: {} }, 5);
    bea.close();
    s.close();
    expect(cli(url, ['user', 'transfer', 'admin', 'bea'])).toMatchObject({ code: 2, err: expect.stringMatching(/bea holds work of its own \(1 job\)/) });
    expect(cli(url, ['users']).out.split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('refuses while a daemon has the database: stop it first', () => {
    const url = adminAndBea();
    const daemon = instanceOf(url);
    expect(daemon.holdDaemonLock()).toBe(true);
    expect(cli(url, ['user', 'transfer', 'admin', 'bea'])).toMatchObject({ code: 2, err: expect.stringMatching(/a running daemon has this database; stop it first/) });
    daemon.close();
    expect(cli(url, ['user', 'transfer', 'admin', 'bea']).code).toBe(0);
  });

  it('refuses unknown users, one user onto itself, and a wrong shape', () => {
    const url = adminAndBea();
    expect(cli(url, ['user', 'transfer', 'admin', 'nobody'])).toMatchObject({ code: 2, err: expect.stringMatching(/no user nobody/) });
    expect(cli(url, ['user', 'transfer', 'bea', 'bea'])).toMatchObject({ code: 2, err: expect.stringMatching(/two different users/) });
    expect(cli(url, ['user', 'transfer', 'admin'])).toMatchObject({ code: 2, err: expect.stringMatching(/user transfer <from> <to>/) });
  });
});
