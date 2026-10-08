// scripts/get.sh, the curl install (issue #87): `curl -fsSL <raw get.sh> | bash` checks what the
// install needs, clones or updates the hopper's source, gives it a database — the one in daemon.env,
// HOPPER_DATABASE_URL, or else the bundled Postgres (deploy/compose.yaml) with a fresh password —
// and runs that source's scripts/install.sh. The source is a local repository whose install.sh only
// records what it was given; docker is a stand-in on PATH. Nothing leaves this process tree.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'get.sh');

let dir: string;
let bin: string;
let home: string;
let origin: string;
let work: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('/usr/bin/git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

function commit(file: string, body: string): string {
  writeFileSync(join(work, file), body);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', file);
  git(work, 'push', '-q', 'origin', 'HEAD:stable');
  return git(work, 'rev-parse', 'HEAD');
}

function stub(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${dir}/log"\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

function run(env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
      HOPPER_SOURCE_REPO: origin, ...env,
    },
  });
}
const log = (): string => (existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : '');
const installed = (): Record<string, string> => JSON.parse(readFileSync(join(dir, 'install-ran'), 'utf8'));
const SRC = (): string => join(home, '.local/share/hopper/source');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-get-'));
  bin = join(dir, 'bin');
  home = join(dir, 'home');
  origin = join(dir, 'origin.git');
  work = join(dir, 'work');
  for (const d of [bin, home, work]) mkdirSync(d);
  execFileSync('/usr/bin/git', ['init', '-q', '--bare', '-b', 'stable', origin]);
  git(work, 'init', '-q', '-b', 'stable');
  git(work, 'remote', 'add', 'origin', origin);
  mkdirSync(join(work, 'scripts'));
  mkdirSync(join(work, 'deploy'));
  writeFileSync(join(work, 'deploy/compose.yaml'), 'name: hopper\n');
  // The source's install.sh: records where it ran from and what it was given.
  writeFileSync(join(work, 'scripts/install.sh'), `node -e 'process.getBuiltinModule("node:fs").writeFileSync(process.argv[1], JSON.stringify({
  dir: process.cwd(), commit: process.argv[2], db: process.env.HOPPER_DATABASE_URL ?? "", branch: process.env.HOPPER_UPDATE_BRANCH ?? "" }))' \\
  "${dir}/install-ran" "$(git -C "$(dirname "$0")/.." rev-parse HEAD)"\n`);
  stub('systemctl', 'true');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('get.sh', () => {
  it('clones the source and runs its install.sh with the database it is given', () => {
    const head = commit('a', '1');
    const r = run({ HOPPER_DATABASE_URL: 'postgres://u:p@db:5432/hopper' });
    expect(r.status, r.stderr).toBe(0);
    expect(git(SRC(), 'rev-parse', 'HEAD')).toBe(head);
    expect(git(SRC(), 'remote', 'get-url', 'origin')).toBe(origin);
    expect(installed()).toMatchObject({ commit: head, db: 'postgres://u:p@db:5432/hopper', branch: 'stable' });
    expect(log()).not.toContain('docker');
  });

  it('run again, updates the source to the newest commit and installs that', () => {
    commit('a', '1');
    expect(run({ HOPPER_DATABASE_URL: 'postgres://u:p@db/h' }).status).toBe(0);
    const head = commit('b', '2');
    const r = run({ HOPPER_DATABASE_URL: 'postgres://u:p@db/h' });
    expect(r.status, r.stderr).toBe(0);
    expect(installed().commit).toBe(head);
  });

  it('installs the ref HOPPER_SOURCE_REF names, and self-update tracks it', () => {
    commit('a', '1');
    git(work, 'checkout', '-q', '-b', 'next');
    const head = commit('b', '2');
    git(work, 'push', '-q', 'origin', 'next');
    const r = run({ HOPPER_DATABASE_URL: 'postgres://u:p@db/h', HOPPER_SOURCE_REF: 'next' });
    expect(r.status, r.stderr).toBe(0);
    expect(installed()).toMatchObject({ commit: head, branch: 'next' });
  });

  it('over a job-hopper install: its source clone moves to the new default, its database is the one its daemon.env names', () => {
    commit('a', '1');
    const oldSrc = join(home, '.local/share/job-hopper/source');
    mkdirSync(dirname(oldSrc), { recursive: true });
    git(dirname(oldSrc), 'clone', '-q', origin, oldSrc);
    writeFileSync(join(dirname(oldSrc), 'job-hopper.db'), 'kept');
    mkdirSync(join(home, '.config/job-hopper'), { recursive: true });
    writeFileSync(join(home, '.config/job-hopper/daemon.env'), 'JOB_HOPPER_DATABASE_URL=postgres://u:p@127.0.0.1:5433/hopper\n');
    stub('docker', 'exit 0');
    const head = commit('b', '2');
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('database: the one the job-hopper install');
    expect(existsSync(oldSrc)).toBe(false);
    expect(readFileSync(join(dirname(oldSrc), 'job-hopper.db'), 'utf8')).toBe('kept');
    expect(git(SRC(), 'rev-parse', 'HEAD')).toBe(head);
    expect(installed()).toMatchObject({ commit: head, db: '' });
    expect(log()).not.toContain('docker');
  });

  it('refuses to update a source with local changes', () => {
    commit('a', '1');
    expect(run({ HOPPER_DATABASE_URL: 'postgres://u:p@db/h' }).status).toBe(0);
    rmSync(join(dir, 'install-ran'));
    writeFileSync(join(SRC(), 'a'), 'edited');
    const r = run({ HOPPER_DATABASE_URL: 'postgres://u:p@db/h' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('local changes');
    expect(existsSync(join(dir, 'install-ran'))).toBe(false);
  });

  it('uses the database daemon.env already names, and starts no Postgres', () => {
    commit('a', '1');
    mkdirSync(join(home, '.config/hopper'), { recursive: true });
    writeFileSync(join(home, '.config/hopper/daemon.env'), 'HOPPER_DATABASE_URL=postgres://u:p@kept/h\n');
    stub('docker', 'exit 0');
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(log()).not.toContain('docker');
    expect(installed().db).toBe('');
  });

  it('with no database anywhere, starts the bundled Postgres with a fresh password and installs against it', () => {
    commit('a', '1');
    stub('docker', [
      '[ "$1 $2" = "volume inspect" ] && exit 1',
      'echo "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" >> "' + '${dir}' + '/log"',
      'exit 0',
    ].join('\n').replace('${dir}', dir));
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(log()).toContain(`docker compose -f ${SRC()}/deploy/compose.yaml up -d --wait postgres`);
    const password = /POSTGRES_PASSWORD=([0-9a-f]+)/.exec(log())?.[1] ?? '';
    expect(password).toMatch(/^[0-9a-f]{48}$/);
    expect(installed().db).toBe(`postgres://hopper:${password}@127.0.0.1:5433/hopper`);
  });

  it('refuses to start the bundled Postgres over a volume whose password it does not know', () => {
    commit('a', '1');
    stub('docker', 'exit 0');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('hopper_postgres');
    expect(log()).not.toContain('compose');
    expect(existsSync(join(dir, 'install-ran'))).toBe(false);
  });

  it('with no database and no docker, says how to give one and installs nothing', () => {
    commit('a', '1');
    // The tools the script uses, and no docker.
    const tools = join(dir, 'nodocker');
    mkdirSync(tools);
    for (const t of ['bash', 'sh', 'git', 'grep', 'cut', 'od', 'tr', 'mkdir', 'dirname', 'cat', 'sed', 'head', 'env', 'rm', 'chmod']) {
      const real = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
      if (real) symlinkSync(real, join(tools, t));
    }
    const r = run({ PATH: `${bin}:${dirname(process.execPath)}:${tools}` });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('HOPPER_DATABASE_URL');
    expect(existsSync(join(dir, 'install-ran'))).toBe(false);
  });

  it('refuses a node older than 24 before touching anything', () => {
    stub('node', 'echo v22.1.0');
    const r = run({ HOPPER_DATABASE_URL: 'postgres://u:p@db/h' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Node.js >= 24');
    expect(existsSync(SRC())).toBe(false);
  });
});
