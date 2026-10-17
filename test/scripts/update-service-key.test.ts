// scripts/update.sh with hopper-compose.service owning the stack and no master key sealed to the host (issue #1372): the
// service starts the stack with the key given to the update, for that start only. The container tools and systemctl are
// stubs on PATH that record each call. Nothing leaves this process tree.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeCalls, dirs, KEY, servers, update } from '../support/update-script.ts';

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('scripts/update.sh with the user service and no key sealed (issue #1372)', () => {
  it('starts the stack through the service with the key given to it when none is sealed here, for that start only (issue #1372)', () => {
    const first = update({ masterKey: KEY, stack: 'podman-compose' });
    expect(first.status, first.out).toBe(0);
    writeFileSync(join(first.dir, 'hopper-service.sh'), '# an older hopper-service.sh\n');
    const r = update({ dir: first.dir, stack: 'podman-compose', service: true, masterKey: KEY });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/with the master key given to this update \(none is sealed here\)/);
    expect(r.calls.filter((c) => c.startsWith('systemctl --user ') && !c.includes('is-enabled') || c.startsWith('imported'))).toEqual([
      'systemctl --user import-environment HOPPER_MASTER_KEY',
      `imported key=${KEY}`,
      'systemctl --user restart hopper-compose.service',
      'systemctl --user unset-environment HOPPER_MASTER_KEY',
    ]);
    expect(composeCalls(r.calls).filter((c) => / (down|up -d) /.test(c))).toEqual([]);
    for (const c of r.calls.filter((c) => c.startsWith('systemctl'))) expect(c).not.toContain(KEY);
    expect(r.out).not.toContain(KEY);
  });

  it('puts in the new image\'s master-key.sh when the service owns the stack and none is here, and says the line that seals the key (issue #1487)', () => {
    const first = update({ masterKey: KEY, stack: 'podman-compose' });
    expect(first.status, first.out).toBe(0);
    writeFileSync(join(first.dir, 'hopper-service.sh'), '# an older hopper-service.sh\n');
    const r = update({ dir: first.dir, stack: 'podman-compose', service: true, masterKey: KEY });
    expect(r.status, r.out).toBe(0);
    expect(r.read('master-key.sh')).toBe(readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'master-key.sh'), 'utf8'));
    expect(r.out).toMatch(/no master key is sealed here: after a restart of this host the stack does not start by itself\. Seal it: bash master-key\.sh seal/);
  });
});
