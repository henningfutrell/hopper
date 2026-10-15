// scripts/master-key.sh (issue #1296): it seals the master key to the host and unseals it at launch. systemd-creds here is
// a stub on PATH that records each call and seals reversibly, so the test sees which tool was asked, how, and that the key
// never was an argument; the key-encryption key path runs the real openssl in a throwaway HOME. The image prints the
// script: `hopper master-key script`. Nothing leaves this process tree.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'master-key.sh');
const KEY = '0123456789abcdef'.repeat(4);
const dirs: string[] = [];

afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// The stub: `encrypt --name=N - OUT` writes "stub:N:" and stdin in base64; `decrypt --name=N IN -` gives stdin back when
// the name matches. STUB_CREDS=fail: it seals nothing (no systemd-creds for this user).
const CREDS = `#!/bin/sh
printf 'systemd-creds %s\\n' "$*" >> "$STUB_LOG"
[ "\${STUB_CREDS:-}" = fail ] && { echo 'Failed to encrypt: org.varlink.service.PermissionDenied' >&2; exit 1; }
[ "$1" = --user ] && shift
verb=$1; name=\${2#--name=}
if [ "$verb" = encrypt ]; then
  if [ "$4" = - ]; then printf 'stub:%s:' "$name"; base64 -w0; else { printf 'stub:%s:' "$name"; base64 -w0; } > "$4"; fi
elif [ "$verb" = decrypt ]; then
  body=$(cat "$3"); case "$body" in "stub:$name:"*) printf '%s' "\${body#stub:$name:}" | base64 -d ;; *) echo 'Failed to decrypt' >&2; exit 1 ;; esac
fi
`;

function folder(o: { creds?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jh-master-key-sh-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'master-key.sh'), readFileSync(SCRIPT));
  const bin = join(dir, '.bin');
  mkdirSync(bin);
  if (o.creds !== false) { writeFileSync(join(bin, 'systemd-creds'), CREDS); chmodSync(join(bin, 'systemd-creds'), 0o755); }
  const log = join(dir, '.calls');
  writeFileSync(log, '');
  const home = join(dir, '.home');
  mkdirSync(home);
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('/bin/bash', ['master-key.sh', ...args], {
      cwd: dir, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), STUB_LOG: log, HOPPER_KEY_TTY: join(dir, 'no-tty'), ...env },
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  const files = () => readdirSync(dir).filter((f) => !f.startsWith('.'));
  return { dir, home, run, calls, files };
}

const env = 'process.stdout.write(JSON.stringify([process.env.HOPPER_MASTER_KEY, process.env.HOPPER_MASTER_KEY_SEALED]))';

describe('scripts/master-key.sh (issue #1296)', () => {
  it('seals with systemd-creds as this user when it can: the key on its stdin, never an argument, never in a file here', () => {
    const f = folder();
    const sealed = f.run(['seal'], { HOPPER_MASTER_KEY: KEY });
    expect(sealed.status, sealed.err).toBe(0);
    expect(sealed.err).toMatch(/sealed the master key to this host with systemd-creds: hopper-master-key\.cred/);
    expect(f.files().sort()).toEqual(['hopper-master-key.cred', 'master-key.sh']);
    expect(f.calls().filter((c) => c.includes(' encrypt --name=hopper-master-key - '))).toEqual([expect.stringMatching(/^systemd-creds (--user )?encrypt --name=hopper-master-key - hopper-master-key\.cred\.next$/)]);
    for (const c of f.calls()) expect(c).not.toContain(KEY);
    expect(readFileSync(join(f.dir, 'hopper-master-key.cred'), 'utf8')).not.toContain(KEY);
    expect(`${sealed.out}${sealed.err}`).not.toContain(KEY);

    const run = f.run(['run', process.execPath, '-e', env]);
    expect(run.status, run.err).toBe(0);
    expect(JSON.parse(run.out)).toEqual([KEY, 'systemd-creds']);
    expect(f.run(['status']).err).toMatch(/sealed with systemd-creds, and it unseals on this host/);
    expect(f.run(['method']).out).toBe('systemd-creds\n');
  });

  it('falls back to a key-encryption key of this host when systemd-creds cannot seal; the KEK lives outside the folder, mode 600', () => {
    const f = folder();
    const sealed = f.run(['seal'], { HOPPER_MASTER_KEY: KEY, STUB_CREDS: 'fail' });
    expect(sealed.status, sealed.err).toBe(0);
    expect(f.files().sort()).toEqual(['hopper-master-key.enc', 'master-key.sh']);
    const kek = join(f.home, '.config', 'hopper', 'master-key.kek');
    expect(existsSync(kek)).toBe(true);
    expect(spawnSync('stat', ['-c', '%a', kek], { encoding: 'utf8' }).stdout.trim()).toBe('600');
    expect(readFileSync(join(f.dir, 'hopper-master-key.enc'), 'utf8')).not.toContain(KEY);
    expect(JSON.parse(f.run(['run', process.execPath, '-e', env]).out)).toEqual([KEY, 'kek']);
    // Sealed again where systemd-creds works: one sealed file, never two.
    expect(f.run(['seal'], { HOPPER_MASTER_KEY: KEY }).status).toBe(0);
    expect(f.files().sort()).toEqual(['hopper-master-key.cred', 'master-key.sh']);
  });

  it('refuses what is no master key, and a launch with nothing sealed; a failed seal leaves the sealed key as it was', () => {
    const f = folder();
    const wrong = f.run(['seal'], { HOPPER_MASTER_KEY: 'not-a-key' });
    expect(wrong.status).not.toBe(0);
    expect(wrong.err).toMatch(/that is no master key: 32 bytes, as 64 hex digits or base64/);
    const none = f.run(['seal']);
    expect(none.status).not.toBe(0);
    expect(none.err).toMatch(/no master key: give it as HOPPER_MASTER_KEY, or run this in a terminal/);
    const run = f.run(['run', 'true']);
    expect(run.status).not.toBe(0);
    expect(run.err).toMatch(/no sealed master key here/);

    expect(f.run(['seal'], { HOPPER_MASTER_KEY: KEY }).status).toBe(0);
    const before = readFileSync(join(f.dir, 'hopper-master-key.cred'), 'utf8');
    const failed = f.run(['seal'], { HOPPER_MASTER_KEY: 'f'.repeat(64), HOPPER_KEY_SEAL: 'systemd-creds', STUB_CREDS: 'fail' });
    expect(failed.status).not.toBe(0);
    expect(readFileSync(join(f.dir, 'hopper-master-key.cred'), 'utf8')).toBe(before);
    expect(f.files().sort()).toEqual(['hopper-master-key.cred', 'master-key.sh']);
  });

  it('a sealed key that does not unseal stops the launch: the command does not run', () => {
    const f = folder();
    expect(f.run(['seal'], { HOPPER_MASTER_KEY: KEY }).status).toBe(0);
    writeFileSync(join(f.dir, 'hopper-master-key.cred'), 'stub:another-name:AAAA');
    const r = f.run(['run', '/bin/sh', '-c', 'echo ran']);
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain('ran');
    expect(r.err).toMatch(/does not unseal on this host\. Seal it again from your password manager/);
  });

  it('a rotation is asked only once a key seals here: when the seal does not work, the hopper is not asked and nothing changes', () => {
    const f = folder();
    expect(f.run(['seal'], { HOPPER_MASTER_KEY: KEY }).status).toBe(0);
    const podman = `#!/bin/sh
printf 'podman %s\\n' "$*" >> "$STUB_LOG"
case "$1" in
  ps) echo 0123456789ab ;;
  exec) printf '{"key": "%s", "fingerprint": "00112233445566778899aabbccddeeff"}' "$(printf 'e%.0s' $(seq 64))" ;;
esac
`;
    writeFileSync(join(f.dir, '.bin', 'podman'), podman);
    chmodSync(join(f.dir, '.bin', 'podman'), 0o755);
    const before = readFileSync(join(f.dir, 'hopper-master-key.cred'), 'utf8');

    const refused = f.run(['rotate'], { STUB_CREDS: 'fail' });
    expect(refused.status).not.toBe(0);
    expect(refused.err).toMatch(/a key does not seal with systemd-creds on this host now: the rotation is not asked/);
    expect(f.calls().some((c) => c.startsWith('podman exec'))).toBe(false);
    expect(readFileSync(join(f.dir, 'hopper-master-key.cred'), 'utf8')).toBe(before);

    const rotated = f.run(['rotate']);
    expect(rotated.status, rotated.err).toBe(0);
    expect(f.calls().filter((c) => c.startsWith('podman exec'))).toEqual(['podman exec 0123456789ab hopper master-key rotate --host-seals']);
    expect(JSON.parse(f.run(['run', process.execPath, '-e', env]).out)).toEqual(['e'.repeat(64), 'systemd-creds']);
    expect(`${rotated.out}${rotated.err}`).not.toContain('e'.repeat(64));
  });

  it('hopper master-key script prints this build\'s script, with no database', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'master-key', 'script'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmpdir() } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(readFileSync(SCRIPT, 'utf8'));
  });
});
