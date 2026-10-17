// scripts/update.sh with hopper-compose.service owning the stack, and its units written by an older hopper-service.sh with
// WorkingDirectory quoted, which systemd refuses (issue #1453): the update repairs them before the restart. The container
// tools and systemctl are stubs on PATH that record each call. Nothing leaves this process tree.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dirs, KEY, servers, update } from '../support/update-script.ts';

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A folder after one update, with the key sealed to this host by the real master-key.sh (key-encryption key).
function sealedFolder() {
  const first = update({ masterKey: KEY, stack: 'podman-compose' });
  expect(first.status, first.out).toBe(0);
  const { dir } = first;
  const env = { HOPPER_KEY_SEAL: 'kek', XDG_CONFIG_HOME: join(dir, '.config') };
  writeFileSync(join(dir, 'master-key.sh'), readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'master-key.sh'), 'utf8'));
  writeFileSync(join(dir, 'hopper-service.sh'), '# an older hopper-service.sh\n');
  const sealed = spawnSync('/bin/bash', ['master-key.sh', 'seal'], { cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: dir, ...env, HOPPER_MASTER_KEY: KEY } });
  expect(sealed.status, sealed.stderr).toBe(0);
  return { dir, env, tools: ['bash', 'openssl', 'id', 'dirname', 'mkdir'] };
}

const UNITS = ['hopper-compose.service', 'hopper-compose-check.service'];

describe('scripts/update.sh repairs the units of the user service (issue #1453)', () => {
  it('takes the quotes out of a WorkingDirectory an older hopper-service.sh wrote, and reloads the units before the restart', () => {
    const { dir, env, tools } = sealedFolder();
    const units = join(dir, '.config', 'systemd', 'user');
    mkdirSync(units, { recursive: true });
    for (const unit of UNITS) writeFileSync(join(units, unit), `[Service]\nWorkingDirectory="${dir}"\nExecStart="/bin/bash" "${dir}/hopper-service.sh" start\n`);
    const r = update({ dir, stack: 'podman-compose', tools, env, service: true });
    expect(r.status, r.out).toBe(0);
    for (const unit of UNITS) {
      expect(readFileSync(join(units, unit), 'utf8')).toBe(`[Service]\nWorkingDirectory=${dir}\nExecStart="/bin/bash" "${dir}/hopper-service.sh" start\n`);
    }
    const systemctl = r.calls.filter((c) => c.startsWith('systemctl --user ') && !c.includes('is-enabled'));
    expect(systemctl).toContain('systemctl --user daemon-reload');
    expect(systemctl.indexOf('systemctl --user daemon-reload')).toBeLessThan(systemctl.indexOf('systemctl --user restart hopper-compose.service'));
    expect(r.out).toMatch(/repaired WorkingDirectory/);
  });

  it('leaves the units and the user manager alone when no WorkingDirectory is quoted', () => {
    const { dir, env, tools } = sealedFolder();
    const r = update({ dir, stack: 'podman-compose', tools, env, service: true });
    expect(r.status, r.out).toBe(0);
    expect(r.calls).not.toContain('systemctl --user daemon-reload');
  });
});
