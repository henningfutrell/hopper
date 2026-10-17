// scripts/hopper-service.sh and the master key (issue #1487): the install puts in master-key.sh and seals the key given
// to it, the start gives compose the key as a file in memory and never as a variable, and a failed start runs the alert.
// The tools are stubs on PATH (test/support/hopper-service-script.ts). Nothing leaves this process tree.
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dirs, folder, KEY, MASTER_KEY, servers } from '../support/hopper-service-script.ts';

afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

describe('scripts/hopper-service.sh and the master key (issue #1487)', () => {
  it('install puts in master-key.sh from the image when none is here, and seals the key given to it, never as an argument (issue #1487)', () => {
    const f = folder();
    const script = join(f.dir, '.master-key-script');
    writeFileSync(script, MASTER_KEY);
    const r = f.run(['install'], { HOPPER_MASTER_KEY: KEY, STUB_MASTER_KEY_SCRIPT: script, STUB_DATA: '1' });
    expect(r.status, r.err).toBe(0);
    expect(readFileSync(join(f.dir, 'master-key.sh'), 'utf8')).toBe(MASTER_KEY);
    expect(f.calls()).toContain('podman run --rm ghcr.io/henningfutrell/hopper:latest hopper master-key script | key=');
    expect(f.calls()).toContain(`sealed key=${KEY}`);
    expect(existsSync(join(f.dir, 'hopper-master-key.enc'))).toBe(true);
    expect(r.err).toMatch(/sealed the master key given to the install/);
    for (const c of f.calls().filter((c) => !c.startsWith('sealed key='))) expect(c.split(' | ')[0]).not.toContain(KEY);
    expect(r.err).not.toContain(KEY);
  });

  it('install keeps the master-key.sh here, and with data, no key given and none sealed, says the line that seals it (issue #1487)', () => {
    const f = folder();
    writeFileSync(join(f.dir, 'master-key.sh'), MASTER_KEY);
    const r = f.run(['install'], { STUB_DATA: '1' });
    expect(r.status, r.err).toBe(0);
    expect(f.calls().filter((c) => c.startsWith('podman run'))).toEqual([]);
    expect(r.err).toMatch(/no master key is sealed here: after a restart of this host the stack does not start by itself\. Seal it: bash master-key\.sh seal/);
    expect(readFileSync(join(f.dir, 'master-key.sh'), 'utf8')).toBe(MASTER_KEY);
  });

  it('install makes a failed start of the stack run hopper-compose-alert.service, and uninstall removes it (issue #1487)', () => {
    const f = folder();
    expect(f.run(['install']).status).toBe(0);
    expect(f.unit('hopper-compose.service')).toMatch(/^OnFailure=hopper-compose-alert\.service$/m);
    const alert = f.unit('hopper-compose-alert.service');
    expect(alert).toMatch(/^Type=oneshot$/m);
    expect(alert).toMatch(/^ExecStart=.*"[^"]*\/hopper-service\.sh" alert$/m);
    expect(f.run(['uninstall']).status).toBe(0);
    expect(existsSync(join(f.home, '.config', 'systemd', 'user', 'hopper-compose-alert.service'))).toBe(false);
  });

  it('alert gives hopper-alert.sh and the desktop what stopped the start (issue #1487)', () => {
    const f = folder();
    writeFileSync(join(f.dir, 'hopper-alert.sh'), 'printf \'alert: %s\\n\' "$1" >> "$STUB_LOG"\n');
    const r = f.run(['alert']);
    expect(r.status, r.err).toBe(0);
    const why = 'no master key is given, and the hopper keeps data (the volume hopper_postgres): the stack does not start';
    expect(f.calls()).toContainEqual(expect.stringMatching(new RegExp(`^alert: hopper on .+: hopper-compose\\.service did not start: ${why.replace(/[()]/g, '\\$&')}$`)));
    expect(f.calls()).toContainEqual(expect.stringMatching(/^notify-send .*hopper-compose\.service did not start/));
  });

  it('alert with no hopper-alert.sh says how to add one, and does not fail (issue #1487)', () => {
    const f = folder();
    const r = f.run(['alert']);
    expect(r.status, r.err).toBe(0);
    expect(r.err).toMatch(/hopper-compose\.service did not start/);
    expect(r.err).toMatch(/no hopper-alert\.sh here/);
  });

  it('start gives compose the key as a file in this user\'s runtime folder, never in the environment, and stop removes it (issue #1487)', () => {
    const f = folder();
    writeFileSync(join(f.dir, 'master-key.sh'), MASTER_KEY);
    writeFileSync(join(f.dir, 'hopper-master-key.enc'), 'sealed');
    expect(f.run(['start'], { HOPPER_SERVICE_COMPOSE: 'podman compose' }).status).toBe(0);
    const folderOfKey = join(f.runtime, 'hopper-service');
    const file = join(folderOfKey, 'master-key');
    expect(readFileSync(file, 'utf8')).toBe(KEY);
    expect(statSync(folderOfKey).mode & 0o777).toBe(0o700);
    // Read in the container by its own user: the folder keeps every other user of this host out.
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(f.run(['stop'], { HOPPER_SERVICE_COMPOSE: 'podman compose' }).status).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it('start with data, no key and no master-key.sh here says how to put master-key.sh in (issue #1487)', () => {
    const f = folder();
    const r = f.run(['start'], { HOPPER_SERVICE_COMPOSE: 'podman compose', STUB_DATA: '1' });
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/no master-key\.sh here: bash hopper-service\.sh install puts it in/);
  });
});
