// The master key as a file (issue #1487): hopper-compose.service writes the key to a file in memory and names it, so no
// container's config holds the key. Asserted on the rendered form compose runs (`docker compose config`), from an empty
// directory, as test/scripts/compose.test.ts does.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

interface Service {
  environment?: Record<string, string | null>;
  security_opt?: string[];
  volumes?: { source?: string; target: string; read_only?: boolean }[];
}
interface Rendered { services: Record<string, Service> }

/** `docker compose config` of compose.yaml alone in a fresh directory, with `env` in the environment compose starts with. */
function render(env: Record<string, string> = {}): Rendered {
  const dir = mkdtempSync(join(tmpdir(), 'jh-compose-key-'));
  copyFileSync(join(ROOT, 'compose.yaml'), join(dir, 'compose.yaml'));
  const out = spawnSync('docker', ['compose', 'config', '--format', 'json'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, ...env } });
  expect(out.status, out.stderr).toBe(0);
  return JSON.parse(out.stdout) as Rendered;
}

const svc = (r: Rendered, name: string): Service => {
  const s = r.services[name];
  if (!s) throw new Error(`no service ${name}`);
  return s;
};

describe('compose.yaml: the master key as a file (issue #1487)', () => {
  it('with no file named, mounts /dev/null at its path and names no file: the key comes as HOPPER_MASTER_KEY', () => {
    const hopper = svc(render(), 'hopper');
    expect(hopper.environment?.HOPPER_MASTER_KEY_FILE ?? '').toBe('');
    expect(hopper.volumes).toContainEqual(expect.objectContaining({ source: '/dev/null', target: '/run/hopper-master-key', read_only: true }));
  });

  it('reads the key from the file hopper-service.sh names, mounted read-only, never from the container\'s environment', () => {
    const host = '/run/user/1000/hopper-service/master-key';
    const given = render({ HOPPER_MASTER_KEY_HOST_FILE: host, HOPPER_MASTER_KEY_FILE: '/run/hopper-master-key', COMPOSE_PROFILES: 'hopper-vault' });
    for (const name of ['hopper', 'hopper-vault']) {
      const s = svc(given, name);
      expect(s.environment?.HOPPER_MASTER_KEY ?? '').toBe('');
      expect(s.environment?.HOPPER_MASTER_KEY_FILE).toBe('/run/hopper-master-key');
      expect(s.volumes).toContainEqual(expect.objectContaining({ source: host, target: '/run/hopper-master-key', read_only: true }));
      expect(s.security_opt).toContain('label=disable');
    }
  });
});
