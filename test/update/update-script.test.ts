// Issue #697: one update for a container install, the same by hand and by an agent. `hopper update <tool>`, run from the
// target image, prints a script that backs up, puts in the compose.yaml that image ships with (the old one kept), with the
// install's own settings in it, pulls and starts the whole stack — never the hopper service alone — and checks health.
// Issue #894: it writes no .env (an old one moves into the compose files, its secrets to the launch), it starts a service
// new in the release, and it puts the old stack back when a step after the stop fails. Run here against a stub container
// tool that records each call and keeps the stack's containers as podman-compose does: the script is the user-side adapter.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 * master key's status (`STUB_MASTER_KEY`), the running hopper's settings (`STUB_RUNNING`, `KEY=value` lines), and
 * `run … <image> hopper …` as this checkout's CLI. It keeps the stack's containers in `.containers`, as podman-compose
 * does: `down` removes them, `up -d` makes one for each service of compose.yaml, and `up -d --force-recreate` fails on a
 * service that has none yet. `STUB_FAIL_NEW` fails `up -d` on a compose.yaml an update put in; `STUB_UNHEALTHY` fails the
 * health check.
 */
function stubTool(bin: string, tool: string): void {
  writeFileSync(join(bin, tool), `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG"
services() { sed -n '/^services:/,/^[a-z]/s/^  \\([a-z][a-z0-9-]*\\):$/\\1/p' compose.yaml; }
[ "$1" != compose ] || shift
case "$*" in
  "exec -T postgres pg_dump"*) echo DUMP ;;
  "exec -T hopper hopper master-key status") [ -n "\${STUB_MASTER_KEY:-}" ] || exit 1; printf '%s\\n' "$STUB_MASTER_KEY" ;;
  "exec -T hopper printenv "*) v=$(printf '%s\\n' "\${STUB_RUNNING:-}" | sed -n "s/^$5=//p"); [ -n "$v" ] || exit 1; printf '%s\\n' "$v" ;;
  "exec -T hopper node"*) [ -z "\${STUB_UNHEALTHY:-}" ] || ! head -1 compose.yaml | grep -q '^# hopper version' || exit 1 ;;
  down) : > .containers ;;
  "up -d --force-recreate") for s in $(services); do grep -qx "$s" .containers || { echo "no container 'hopper_\${s}_1'" >&2; exit 1; }; done ;;
  "up -d") if [ -n "\${STUB_FAIL_NEW:-}" ] && head -1 compose.yaml | grep -q '^# hopper version'; then exit 1; fi
    printf '%s\\n' "HOPPER_MASTER_KEY=\${HOPPER_MASTER_KEY:-}" > .launched; services > .containers ;;
  run\\ *) while [ "$1" != hopper ]; do shift; done; shift; exec '${process.execPath}' '${join(ROOT, 'src', 'cli.ts')}' "$@" ;;
esac
exit 0
`);
  chmodSync(join(bin, tool), 0o755);
}

const read = (dir: string, name: string): string => readFileSync(join(dir, name), 'utf8');

/** An install's folder: compose.yaml (`compose`), and `.env` when given. */
function install(compose: string | undefined, dotenv?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'jh-update-script-'));
  dirs.push(dir);
  if (compose !== undefined) writeFileSync(join(dir, 'compose.yaml'), compose);
  if (dotenv !== undefined) writeFileSync(join(dir, '.env'), dotenv, { mode: 0o600 });
  return dir;
}

async function update(dir: string, o: { tool?: string; masterKey?: string; env?: Record<string, string> } = {}) {
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
  // The old stack runs: a container for each service of its compose.yaml.
  const old = existsSync(join(dir, 'compose.yaml')) ? read(dir, 'compose.yaml') : '';
  writeFileSync(join(dir, '.containers'), [...old.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => `${m[1]}\n`).join(''));
  const r = spawnSync('sh', ['hopper-update.sh'], {
    cwd: dir, encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, STUB_LOG: log, ...(o.masterKey ? { STUB_MASTER_KEY: o.masterKey } : {}), HOPPER_UPDATE_HEALTH_TRIES: '1', ...o.env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

describe('hopper update: the compose file the image ships with, the whole stack (issue #697)', () => {
  it('brings an old LAN install to the image\'s compose.yaml with its settings in it, moves .env out, and keeps its old files as backups', async () => {
    const dir = install(OLD_LAN, `HOPPER_MASTER_KEY=${KEY}\nHOPPER_IMAGE=ghcr.io/henningfutrell/hopper:latest\nHOPPER_LAN_NAMES=hopper,omarchybox\n`);
    const r = await update(dir);
    expect(r.status, r.out).toBe(0);
    // The image's compose file, stamped with the version it came with, the install's settings as its defaults.
    const compose = read(dir, 'compose.yaml');
    expect(compose).toMatch(/^# hopper version: /);
    expect(compose).toContain(`\${HOPPER_IMAGE:-${IMAGE}}`);
    expect(compose).toContain('"${HOPPER_BIND:-0.0.0.0}:${HOPPER_PORT:-4790}:${HOPPER_PORT:-4790}"');
    expect(compose).toContain('${HOPPER_LAN_NAMES:-hopper,omarchybox}');
    expect(compose).toContain('${HOPPER_PUBLIC_URL:-https://hopper.example.test}');
    // No .env, and the master key in no file but the backup of the old .env.
    const files = readdirSync(dir);
    expect(files).not.toContain('.env');
    for (const f of files.filter((f) => !f.startsWith('.env.bak-') && !f.startsWith('.') && f !== 'hopper-update.sh')) expect(read(dir, f)).not.toContain(KEY);
    expect(files.filter((f) => f.startsWith('.env.bak-'))).toHaveLength(1);
    expect(r.out).not.toContain(KEY);
    // The hopper started with the key, given at launch.
    expect(read(dir, '.launched')).toBe(`HOPPER_MASTER_KEY=${KEY}\n`);
    const bak = files.filter((f) => f.startsWith('compose.yaml.bak-'));
    expect(bak).toHaveLength(1);
    expect(read(dir, bak[0]!)).toBe(OLD_LAN);
    // The database, dumped before anything changed, readable by its owner only.
    const dump = files.find((f) => /^hopper-backup-.*\.dump$/.test(f));
    expect(dump).toBeDefined();
    expect(read(dir, dump!)).toBe('DUMP\n');
    expect(statSync(join(dir, dump!)).mode & 0o777).toBe(0o600);
    // What compose.yaml cannot hold, moved to compose.override.yaml, named; and the change, shown.
    expect(r.out).toMatch(/service whoami moved to compose\.override\.yaml/);
    expect(r.out).toMatch(/HOPPER_MASTER_KEY: in no file: give it at launch/);
    expect(read(dir, 'compose.override.yaml')).toMatch(/whoami:/);
    expect(read(dir, 'compose.override.yaml')).toContain('/run/podman/podman.sock:/run/podman/podman.sock');
    expect(statSync(join(dir, 'compose.override.yaml')).mode & 0o777).toBe(0o600);
    expect(r.out).toContain('+  whoami:');
    expect(r.out).toContain('+      - "${HOPPER_BIND:-0.0.0.0}:');
    // The whole stack: pulled, the old one stopped, the new one started — never the hopper service alone; then health.
    // The key came from .env: the running hopper is asked only for what neither .env nor this shell gave.
    const asked = r.calls.filter((c) => c.startsWith('compose exec -T hopper printenv'));
    expect(asked).not.toContain('compose exec -T hopper printenv HOPPER_MASTER_KEY');
    expect(r.calls).toEqual([
      'compose exec -T postgres pg_dump -U hopper -d hopper -Fc',
      `pull ${IMAGE}`,
      `run --rm -i --network none -e HOPPER_UPDATE_ENV -e HOPPER_UPDATE_LAUNCH ${IMAGE} hopper update carry --image ${IMAGE}`,
      `run --rm -i --network none -e HOPPER_UPDATE_ENV -e HOPPER_UPDATE_LAUNCH -e HOPPER_UPDATE_OVERRIDE ${IMAGE} hopper update override --image ${IMAGE}`,
      ...asked,
      'compose -f compose.yaml.next -f compose.override.yaml.next pull',
      'compose down',
      'compose up -d',
      expect.stringMatching(/^compose exec -T hopper node -e .*\/api\/health/),
      expect.stringMatching(/^compose exec -T hopper node -e .*openfga/),
    ]);
    expect(r.calls.join('\n')).not.toContain('--no-deps');
    expect(r.calls.join('\n')).not.toContain('--force-recreate');
  });

  it('starts a service new in the release, as podman-compose does (issue #894: tunnel was new, and the stack went down)', async () => {
    const withoutTunnel = SHIPPED.replace(/^ {2}tunnel:\n[\s\S]*?\n(?= {2}# HashiCorp Vault)/m, '');
    expect(withoutTunnel).not.toMatch(/^ {2}tunnel:\n {4}image:/m);
    const dir = install(withoutTunnel, `HOPPER_MASTER_KEY=${KEY}\n`);
    const r = await update(dir, { tool: 'podman-compose' });
    expect(r.status, r.out).toBe(0);
    expect(read(dir, '.containers').split('\n')).toContain('tunnel');
    // The stub fails as podman-compose did on the old command: the script no longer gives it.
    expect(r.calls).not.toContain('up -d --force-recreate');
  });

  it('puts the old stack back, on its old files, when the new one does not start', async () => {
    const dotenv = `HOPPER_MASTER_KEY=${KEY}\nHOPPER_BIND=0.0.0.0\n`;
    const dir = install(OLD_LAN, dotenv);
    const r = await update(dir, { env: { STUB_FAIL_NEW: '1' } });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/the stack did not start\. The old stack runs again, on its old files/);
    expect(read(dir, 'compose.yaml')).toBe(OLD_LAN);
    expect(read(dir, '.env')).toBe(dotenv);
    expect(existsSync(join(dir, 'compose.override.yaml'))).toBe(false);
    expect(r.calls.slice(-4)).toEqual(['compose down', 'compose up -d', 'compose down', 'compose up -d']);
    expect(read(dir, '.containers')).toContain('whoami');
  });

  it('puts the old stack back when the new one does not answer, and an old compose.override.yaml too', async () => {
    const dir = install(OLD_LAN, `HOPPER_MASTER_KEY=${KEY}\n`);
    writeFileSync(join(dir, 'compose.override.yaml'), '# mine\nservices:\n  hopper:\n    group_add: ["1"]\n');
    const r = await update(dir, { env: { STUB_UNHEALTHY: '1' } });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/does not answer \/api\/health .*\. The old stack runs again/);
    expect(read(dir, 'compose.yaml')).toBe(OLD_LAN);
    expect(read(dir, 'compose.override.yaml')).toBe('# mine\nservices:\n  hopper:\n    group_add: ["1"]\n');
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
    expect(r.out).toMatch(/backups: .*compose\.override\.yaml\.bak-/);

    const plain = install(SHIPPED, `HOPPER_MASTER_KEY=${KEY}\n`);
    expect((await update(plain)).status).toBe(0);
    expect(readdirSync(plain).filter((f) => f.startsWith('compose.override.yaml'))).toEqual([]);
  });

  it('keeps a setting given at launch: it becomes the default in compose.yaml', async () => {
    const dir = install(SHIPPED);
    const r = await update(dir, { env: { HOPPER_BIND: '0.0.0.0', COMPOSE_PROFILES: 'kms', HOPPER_MASTER_KEY: KEY } });
    expect(r.status, r.out).toBe(0);
    expect(read(dir, 'compose.yaml')).toContain('"${HOPPER_BIND:-0.0.0.0}:');
    expect(read(dir, 'compose.yaml')).toContain('${COMPOSE_PROFILES:-kms}');
    expect(read(dir, 'compose.yaml')).not.toContain(KEY);
  });

  it('takes the master key from the running hopper when no .env gives it, and writes it nowhere', async () => {
    const dir = install(SHIPPED);
    const r = await update(dir, { env: { STUB_RUNNING: `HOPPER_MASTER_KEY=${KEY}\n` } });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/HOPPER_MASTER_KEY: taken from the running hopper/);
    expect(read(dir, '.launched')).toBe(`HOPPER_MASTER_KEY=${KEY}\n`);
    expect(r.calls).not.toContain('compose exec -T hopper hopper master-key status');
    for (const f of readdirSync(dir).filter((f) => !f.startsWith('.'))) expect(read(dir, f)).not.toContain(KEY);
  });

  it('stops before it changes anything when the master key the running hopper made is given nowhere', async () => {
    const dir = install(OLD_LAN, 'HOPPER_IMAGE=ghcr.io/henningfutrell/hopper:latest\n');
    const r = await update(dir, { masterKey: '{"source":"generated","fingerprint":"ab12cd34","previous":false}' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/HOPPER_MASTER_KEY/);
    expect(read(dir, 'compose.yaml')).toBe(OLD_LAN);
    expect(read(dir, '.env')).toBe('HOPPER_IMAGE=ghcr.io/henningfutrell/hopper:latest\n');
    expect(r.calls.some((c) => c.startsWith('compose up') || c.startsWith('compose down') || c.endsWith('pull'))).toBe(false);
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
      expect(r.calls.filter((c) => c.endsWith('up -d') || c.endsWith('down'))).toEqual(tool === 'docker' ? ['compose down', 'compose up -d'] : ['down', 'up -d']);
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
