// The operator CLI (src/cli.ts, design.md "Operator CLI"): config documents read and replaced in the
// daemon's own database, against their version — where command-bearing options are set.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli.ts';
import { openStore } from '../src/store/index.ts';
import { testDatabaseUrl } from './support/database.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function db(): string {
  const d = mkdtempSync(`${tmpdir()}/jh-cli-`);
  dirs.push(d);
  return testDatabaseUrl();
}

function cli(url: string | undefined, argv: string[], o: { stdin?: string; edit?: (file: string) => number } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    env: url ? { JOB_HOPPER_DATABASE_URL: url } : {}, stdin: () => o.stdin ?? '', out: (t) => out.push(t), err: (t) => err.push(t),
    ...(o.edit ? { edit: o.edit } : {}),
  };
  const code = runCli(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

function documentIn(url: string, name: 'plugins.yaml' | 'rules.md'): string | undefined {
  const s = openStore({ url, clock: { now: () => new Date() } });
  try { return s.documents.read(name); } finally { s.close(); }
}

const PLUGINS = 'version: 1\nexecutors:\n  - name: test\n    plugin: test\n';

describe('job-hopper config', () => {
  it('needs JOB_HOPPER_DATABASE_URL and says so', () => {
    const r = cli(undefined, ['config', 'get', 'rules.md']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/JOB_HOPPER_DATABASE_URL is not set/);
  });

  it('refuses an unknown document or command', () => {
    expect(cli(db(), ['config', 'get', 'sources.yaml']).err).toMatch(/unknown document sources.yaml; one of plugins.yaml, webhooks.yaml, rules.md/);
    expect(cli(db(), ['deploy']).code).toBe(2);
  });

  it('set writes a new document against "missing"; get prints it; version names it', () => {
    const url = db();
    expect(cli(url, ['config', 'get', 'rules.md'])).toMatchObject({ code: 2, err: expect.stringMatching(/rules.md: none yet/) });
    expect(cli(url, ['config', 'set', 'rules.md', '--if-version', 'missing'], { stdin: 'be brief\n' }).code).toBe(0);
    expect(cli(url, ['config', 'get', 'rules.md'])).toMatchObject({ code: 0, out: 'be brief\n' });
    expect(cli(url, ['config', 'version', 'rules.md']).out).toMatch(/^[0-9a-f]{64}\n$/);
  });

  it('set without --if-version writes nothing, and a stale version is refused', () => {
    const url = db();
    expect(cli(url, ['config', 'set', 'rules.md'], { stdin: 'x' })).toMatchObject({ code: 2, err: expect.stringMatching(/--if-version/) });
    expect(documentIn(url, 'rules.md')).toBeUndefined();
    cli(url, ['config', 'set', 'rules.md', '--if-version', 'missing'], { stdin: 'one' });
    const r = cli(url, ['config', 'set', 'rules.md', '--if-version', 'missing'], { stdin: 'two' });
    expect(r).toMatchObject({ code: 2, err: expect.stringMatching(/rules.md changed since version missing/) });
    expect(documentIn(url, 'rules.md')).toBe('one');
  });

  it('a plugins.yaml that would not load is refused, nothing written', () => {
    const url = db();
    const r = cli(url, ['config', 'set', 'plugins.yaml', '--if-version', 'missing'], { stdin: 'version: 2\n' });
    expect(r).toMatchObject({ code: 2, err: expect.stringMatching(/plugins.yaml refused, nothing written: version/) });
    expect(cli(url, ['config', 'set', 'plugins.yaml', '--if-version', 'missing'], { stdin: 'executors: [\n' }).err).toMatch(/not valid YAML/);
    expect(documentIn(url, 'plugins.yaml')).toBeUndefined();
    expect(cli(url, ['config', 'set', 'plugins.yaml', '--if-version', 'missing'], { stdin: PLUGINS }).code).toBe(0);
    expect(documentIn(url, 'plugins.yaml')).toBe(PLUGINS);
  });

  it('edit runs the editor on the document and writes what it saved, against the version read', () => {
    const url = db();
    cli(url, ['config', 'set', 'plugins.yaml', '--if-version', 'missing'], { stdin: PLUGINS });
    const r = cli(url, ['config', 'edit', 'plugins.yaml'], {
      edit: (file) => { writeFileSync(file, readFileSync(file, 'utf8').replace('name: test', 'name: t2')); return 0; },
    });
    expect(r.code).toBe(0);
    expect(documentIn(url, 'plugins.yaml')).toBe(PLUGINS.replace('name: test', 'name: t2'));
  });

  it('edit writes nothing when the editor fails, saves nothing new, or the document moved meanwhile', () => {
    const url = db();
    cli(url, ['config', 'set', 'rules.md', '--if-version', 'missing'], { stdin: 'a' });
    expect(cli(url, ['config', 'edit', 'rules.md'], { edit: (f) => { writeFileSync(f, 'b'); return 1; } })).toMatchObject({ code: 2, err: expect.stringMatching(/editor exited 1/) });
    expect(cli(url, ['config', 'edit', 'rules.md'], { edit: () => 0 }).err).toMatch(/rules.md unchanged/);
    const raced = cli(url, ['config', 'edit', 'rules.md'], {
      edit: (f) => {
        const other = openStore({ url, clock: { now: () => new Date() } });
        other.documents.write('rules.md', 'from the UI', other.documents.version('rules.md'));
        other.close();
        writeFileSync(f, 'from the editor');
        return 0;
      },
    });
    expect(raced).toMatchObject({ code: 2, err: expect.stringMatching(/rules.md changed since version/) });
    expect(documentIn(url, 'rules.md')).toBe('from the UI');
  });
});

describe('job-hopper login-code', () => {
  it('mints a one-time code into the database and prints it; --link prints the device link', () => {
    const url = db();
    const a = cli(url, ['login-code']);
    expect(a).toMatchObject({ code: 0, out: expect.stringMatching(/^[0-9a-f]{64}\n$/) });
    const b = cli(url, ['login-code', '--link', 'https://hopper.example.com/']);
    expect(b.out).toMatch(/^https:\/\/hopper\.example\.com\/#login=[0-9a-f]{64}\n$/);
    const s = openStore({ url, clock: { now: () => new Date() } });
    const hash = (c: string) => createHash('sha256').update(c).digest('hex');
    expect(s.loginCodes.take(hash(a.out.trim()), new Date().toISOString())).toBe(true);
    expect(s.loginCodes.take(hash(a.out.trim()), new Date().toISOString())).toBe(false);
    s.close();
  });
});
