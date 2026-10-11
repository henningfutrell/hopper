// Issue #697: one update for a container install, the same by hand and by an agent. `hopper update <tool>`, run from the
// target image, prints a script that backs up, puts in the compose.yaml that image ships with (the old one kept), moves the install's
// own settings to .env, checks .env, pulls and starts the whole stack — never the hopper service alone — and checks
// health. Run here against a stub container tool that records each call: the script is the user-side adapter.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const IMAGE = 'ghcr.io/henningfutrell/hopper:beta';
const KEY = 'a'.repeat(64);
const SHIPPED = readFileSync(join(ROOT, 'compose.yaml'), 'utf8');
const OLD_LAN = readFileSync(join(ROOT, 'test', 'fixtures', 'compose', 'old-lan.yaml'), 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function cli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: {}, stdin: () => '', out: (t) => out.push(t), err: (t) => err.push(t) };
  const code = await runCli(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

/**
 * A stub of `tool` (podman or docker) that logs each call and answers as a running stack would: the database dump, the
 * master key's status (`STUB_MASTER_KEY`), and `run … <image> hopper …` as this checkout's CLI.
 */
function stubTool(bin: string, tool: string): void {
  writeFileSync(join(bin, tool), `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$*" in
  "compose exec -T postgres pg_dump"*) echo DUMP ;;
  "compose exec -T hopper hopper master-key status") [ -n "\${STUB_MASTER_KEY:-}" ] || exit 1; printf '%s\\n' "$STUB_MASTER_KEY" ;;
  run\\ *) while [ "$1" != hopper ]; do shift; done; shift; exec '${process.execPath}' '${join(ROOT, 'src', 'cli.ts')}' "$@" ;;
esac
exit 0
`);
  chmodSync(join(bin, tool), 0o755);
}

/** An install's folder: compose.yaml (`compose`), and `.env` when given. */
function install(compose: string | undefined, dotenv?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'jh-update-script-'));
  dirs.push(dir);
  if (compose !== undefined) writeFileSync(join(dir, 'compose.yaml'), compose);
  if (dotenv !== undefined) writeFileSync(join(dir, '.env'), dotenv, { mode: 0o600 });
  return dir;
}

async function update(dir: string, o: { tool?: string; masterKey?: string } = {}) {
  const tool = o.tool ?? 'podman';
  const made = await cli(['update', tool, '--image', IMAGE]);
  expect(made.code, made.err).toBe(0);
  writeFileSync(join(dir, 'hopper-update.sh'), made.out);
  const bin = join(dir, '.bin');
  mkdirSync(bin);
  stubTool(bin, tool.startsWith('docker') ? 'docker' : tool === 'podman-compose' ? 'podman-compose' : 'podman');
  if (tool === 'podman-compose') stubTool(bin, 'podman');
  const log = join(dir, '.calls');
  writeFileSync(log, '');
  const r = spawnSync('sh', ['hopper-update.sh'], {
    cwd: dir, encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, STUB_LOG: log, ...(o.masterKey ? { STUB_MASTER_KEY: o.masterKey } : {}), HOPPER_UPDATE_HEALTH_TRIES: '1' },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

const read = (dir: string, name: string): string => readFileSync(join(dir, name), 'utf8');

describe('hopper update: the compose file the image ships with, the whole stack (issue #697)', () => {
  it('brings an old LAN install to the image\'s compose.yaml, keeps its settings in .env and its old files as backups', async () => {
    const dir = install(OLD_LAN, `HOPPER_MASTER_KEY=${KEY}\nHOPPER_IMAGE=ghcr.io/henningfutrell/hopper:latest\n`);
    const r = await update(dir);
    expect(r.status, r.out).toBe(0);
    // The image's compose file, whole, stamped with the version it came with.
    expect(read(dir, 'compose.yaml')).toMatch(/^# hopper version: /);
    expect(read(dir, 'compose.yaml')).toContain(SHIPPED);
    const files = readdirSync(dir);
    const bak = files.filter((f) => f.startsWith('compose.yaml.bak-'));
    expect(bak).toHaveLength(1);
    expect(read(dir, bak[0]!)).toBe(OLD_LAN);
    expect(files.filter((f) => f.startsWith('.env.bak-'))).toHaveLength(1);
    // The database, dumped before anything changed, readable by its owner only.
    const dump = files.find((f) => /^hopper-backup-.*\.dump$/.test(f));
    expect(dump).toBeDefined();
    expect(read(dir, dump!)).toBe('DUMP\n');
    expect(statSync(join(dir, dump!)).mode & 0o777).toBe(0o600);
    // The install's own settings, moved to .env; the image the update was made from.
    const env = read(dir, '.env').trim().split('\n');
    expect(env).toEqual(expect.arrayContaining([`HOPPER_MASTER_KEY=${KEY}`, `HOPPER_IMAGE=${IMAGE}`, 'HOPPER_BIND=0.0.0.0', 'HOPPER_LAN_NAMES=hopper,lanbox', 'HOPPER_PUBLIC_URL=https://hopper.example.test']));
    expect(env.filter((l) => l.startsWith('HOPPER_IMAGE='))).toHaveLength(1);
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
    // What .env cannot hold, moved to compose.override.yaml, named; and the change, shown.
    expect(r.out).toMatch(/service whoami moved to compose\.override\.yaml/);
    expect(read(dir, 'compose.override.yaml')).toMatch(/whoami:/);
    expect(read(dir, 'compose.override.yaml')).toContain('/run/podman/podman.sock:/run/podman/podman.sock');
    expect(statSync(join(dir, 'compose.override.yaml')).mode & 0o777).toBe(0o600);
    expect(r.out).toContain('+  whoami:');
    expect(r.out).toContain('+      - "${HOPPER_BIND:-127.0.0.1}:');
    // The whole stack: pulled and started, never the hopper service alone; then health.
    expect(r.calls).toEqual([
      'compose exec -T postgres pg_dump -U hopper -d hopper -Fc',
      `pull ${IMAGE}`,
      `run --rm -i --network none ${IMAGE} hopper update carry`,
      `run --rm -i --network none -e HOPPER_UPDATE_OVERRIDE ${IMAGE} hopper update override`,
      'compose pull',
      'compose up -d --force-recreate',
      expect.stringMatching(/^compose exec -T hopper node -e .*\/api\/health/),
      expect.stringMatching(/^compose exec -T hopper node -e .*openfga/),
    ]);
    expect(r.calls.join('\n')).not.toContain('--no-deps');
  });

  it('keeps an existing compose.override.yaml as a backup, adds to it, and leaves it alone when nothing moves', async () => {
    const dir = install(OLD_LAN, `HOPPER_MASTER_KEY=${KEY}\n`);
    writeFileSync(join(dir, 'compose.override.yaml'), '# mine\nservices:\n  hopper:\n    group_add: ["1"]\n');
    const r = await update(dir);
    expect(r.status, r.out).toBe(0);
    expect(read(dir, 'compose.override.yaml')).toMatch(/^# mine\n[\s\S]*group_add: \["1"\][\s\S]*whoami:/);
    const bak = readdirSync(dir).filter((f) => f.startsWith('compose.override.yaml.bak-'));
    expect(bak).toHaveLength(1);
    expect(read(dir, bak[0]!)).toBe('# mine\nservices:\n  hopper:\n    group_add: ["1"]\n');
    expect(r.out).toMatch(/hopper: group_add: compose\.override\.yaml has it already, kept/);

    const plain = install(SHIPPED, `HOPPER_MASTER_KEY=${KEY}\n`);
    expect((await update(plain)).status).toBe(0);
    expect(readdirSync(plain).filter((f) => f.startsWith('compose.override.yaml'))).toEqual([]);
  });

  it('stops before it changes anything when .env lacks the master key the running hopper made', async () => {
    const dir = install(OLD_LAN, 'HOPPER_IMAGE=ghcr.io/henningfutrell/hopper:latest\n');
    const r = await update(dir, { masterKey: '{"source":"generated","fingerprint":"ab12cd34","previous":false}' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/HOPPER_MASTER_KEY/);
    expect(read(dir, 'compose.yaml')).toBe(OLD_LAN);
    expect(r.calls.some((c) => c.startsWith('compose up') || c === 'compose pull')).toBe(false);
  });

  it('goes on without the master key in .env when the running hopper was given one some other way', async () => {
    const dir = install(SHIPPED, '');
    const r = await update(dir, { masterKey: '{"source":"given","fingerprint":"ab12cd34","previous":false}' });
    expect(r.status, r.out).toBe(0);
  });

  it('refuses a folder with no compose.yaml', async () => {
    const dir = install(undefined);
    const r = await update(dir);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/no compose\.yaml/);
    expect(r.calls).toEqual([]);
  });

  it('speaks each compose tool: docker compose and podman-compose', async () => {
    for (const tool of ['docker', 'podman-compose']) {
      const dir = install(SHIPPED, `HOPPER_MASTER_KEY=${KEY}\n`);
      const r = await update(dir, { tool });
      expect(r.status, r.out).toBe(0);
      expect(r.calls.filter((c) => c.endsWith('up -d --force-recreate'))).toEqual([tool === 'docker' ? 'compose up -d --force-recreate' : 'up -d --force-recreate']);
    }
  });

  it('refuses a tool it does not know, and an image it is not given', async () => {
    expect((await cli(['update', 'nerdctl', '--image', IMAGE])).code).toBe(2);
    expect((await cli(['update', 'podman'])).code).toBe(2);
  });

  it('prints the agent update skill and this build\'s compose file, with no database', async () => {
    const skill = await cli(['update', 'skill']);
    expect(skill.code).toBe(0);
    expect(skill.out).toMatch(/^# Update a container hopper/);
    const compose = await cli(['update', 'compose']);
    expect(compose.code).toBe(0);
    expect(compose.out).toBe(`# hopper version: unknown\n${SHIPPED}`);
  });
});
