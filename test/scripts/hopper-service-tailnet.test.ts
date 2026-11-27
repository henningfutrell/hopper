// This host's tailnet for a hopper in a container (issue #1024): the container sees neither tailscaled's socket nor the
// Tailscale interface, so hopper-compose.service writes `tailscale status --json --peers=false` to a file in memory that
// compose mounts into the hopper's container, and its check timer writes it again in place. podman, systemctl and tailscale
// are stubs on PATH (test/support/hopper-service-script.ts); this machine's tailscale is never asked.
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { selfOf } from '../../src/http/tailnet.ts';
import { dirs, folder, servers } from '../support/hopper-service-script.ts';

afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

const status = (ip: string) => JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.example.ts.net.', TailscaleIPs: [ip] } });
const COMPOSE = { HOPPER_SERVICE_COMPOSE: 'podman compose' };

describe('scripts/hopper-service.sh: this host\'s tailnet for the container (issue #1024)', () => {
  it('start writes this host\'s tailnet, no peers, to a file in memory and gives it to compose; stop removes it', () => {
    const f = folder();
    const given = join(f.dir, '.status');
    writeFileSync(given, status('100.101.102.103'));
    expect(f.run(['start'], { ...COMPOSE, STUB_TAILNET: given }).status).toBe(0);
    const file = join(f.runtime, 'hopper-service', 'tailnet.json');
    expect(selfOf(JSON.parse(readFileSync(file, 'utf8')))).toEqual({ names: ['box.example.ts.net', 'box'], addresses: ['100.101.102.103'] });
    expect(statSync(join(f.runtime, 'hopper-service')).mode & 0o777).toBe(0o700);
    // Read in the container by its own user: the folder keeps every other user of this host out.
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(f.dir, '.calls.tailscale'), 'utf8').trim()).toBe('tailscale status --json --peers=false');
    expect(readFileSync(join(f.dir, '.calls.tailnet'), 'utf8')).toContain(`podman compose -p hopper up -d | tailnet=${file}`);
    expect(f.run(['stop'], COMPOSE).status).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it('start writes an empty file when this host has no tailscale up: the hopper then reads no tailnet', () => {
    const f = folder();
    expect(f.run(['start'], COMPOSE).status).toBe(0);
    expect(readFileSync(join(f.runtime, 'hopper-service', 'tailnet.json'), 'utf8')).toBe('');
  });

  it('check writes it again in place, so the container that has it mounted reads the change', () => {
    const f = folder();
    const given = join(f.dir, '.status');
    expect(f.run(['start'], COMPOSE).status).toBe(0);
    const file = join(f.runtime, 'hopper-service', 'tailnet.json');
    const inode = statSync(file).ino;
    writeFileSync(given, status('100.64.0.7'));
    expect(f.run(['check'], { STUB_TAILNET: given }).status).toBe(0);
    expect(selfOf(JSON.parse(readFileSync(file, 'utf8')))?.addresses).toEqual(['100.64.0.7']);
    expect(statSync(file).ino).toBe(inode);
  });

  it('check leaves the file alone while the service is stopped', () => {
    const f = folder();
    const given = join(f.dir, '.status');
    writeFileSync(given, status('100.64.0.7'));
    expect(f.run(['check'], { STUB_ACTIVE: '3', STUB_TAILNET: given }).status).toBe(0);
    expect(existsSync(join(f.runtime, 'hopper-service', 'tailnet.json'))).toBe(false);
  });
});
