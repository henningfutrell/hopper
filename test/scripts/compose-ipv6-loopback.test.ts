// Issue #712: Windows tries ::1 first for localhost, and WSL passes it through only to a port published on ::1. The install
// page's line, on its Windows steps, writes compose.override.yaml with that port, only when the distro has IPv6 loopback
// (docs/deploy.md "Open it at localhost from Windows"). Asserted on the rendered form compose runs (`docker compose
// config`), as test/scripts/compose.test.ts does.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const page = readFileSync(join(ROOT, 'site', 'install.html'), 'utf8');
const copy = /data-copy="([^"]*\/proc\/net\/if_inet6[^"]*)"/.exec(page)?.[1] ?? '';
const line = copy.replaceAll('&#x27;', "'").replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const LO6 = '00000000000000000000000000000001 01 80 10 80       lo\n';

type Port = { host_ip?: string; published?: string; target: number };

/** Runs the install page's line in a fresh directory beside compose.yaml, with `inet6` in place of /proc/net/if_inet6. */
function install(inet6: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'jh-compose-'));
  copyFileSync(join(ROOT, 'compose.yaml'), join(dir, 'compose.yaml'));
  writeFileSync(join(dir, 'if_inet6'), inet6);
  spawnSync('bash', ['-c', line.replace('/proc/net/if_inet6', join(dir, 'if_inet6'))], { cwd: dir });
  return dir;
}

/** The hopper's published ports, as compose renders the folder, with `env` given at launch. */
function ports(dir: string, env: Record<string, string> = {}): Port[] {
  const out = spawnSync('docker', ['compose', 'config', '--format', 'json'], {
    cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, ...env },
  });
  expect(out.status, out.stderr).toBe(0);
  return (JSON.parse(out.stdout) as { services: { hopper: { ports: Port[] } } }).services.hopper.ports;
}

describe('the [::1] port the install page adds on Windows (issue #712)', () => {
  it('is on the Windows steps, before the keep-alive step, and writes compose.override.yaml', () => {
    expect(line).toContain('> compose.override.yaml');
    const windows = page.slice(page.indexOf('id="windows"'));
    expect(windows).toContain('/proc/net/if_inet6');
    expect(windows.indexOf('/proc/net/if_inet6')).toBeLessThan(windows.indexOf('id="windows-keep-running"'));
  });

  it('publishes the UI on [::1] beside 127.0.0.1, on the port HOPPER_PORT names, and on no LAN interface', () => {
    const dir = install(LO6);
    expect(existsSync(join(dir, 'compose.override.yaml'))).toBe(true);
    expect(ports(dir)).toEqual([
      expect.objectContaining({ host_ip: '127.0.0.1', published: '4790', target: 4790 }),
      expect.objectContaining({ host_ip: '::1', published: '4790', target: 4790 }),
    ]);
    expect(ports(dir, { HOPPER_PORT: '4800' })).toEqual([
      expect.objectContaining({ host_ip: '127.0.0.1', published: '4800', target: 4800 }),
      expect.objectContaining({ host_ip: '::1', published: '4800', target: 4800 }),
    ]);
  });

  it('writes nothing when the distro has no IPv6 loopback: binding ::1 there would stop the start', () => {
    const dir = install('fe800000000000000000000000000001 02 40 20 80     eth0\n');
    expect(existsSync(join(dir, 'compose.override.yaml'))).toBe(false);
    expect(ports(dir)).toEqual([expect.objectContaining({ host_ip: '127.0.0.1', published: '4790' })]);
  });
});
