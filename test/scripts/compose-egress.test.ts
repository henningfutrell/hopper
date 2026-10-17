// A read-only box's egress (issue #849): the compose service `egress` runs tinyproxy on the internal network `egress`,
// the read-only boxes' one way out, and loads the allowlist the hopper writes into the `egress` volume. Asserted on the
// rendered form compose runs (`docker compose config`), from an empty directory, as test/scripts/compose-tunnel.test.ts
// does; and the service's own script run under sh with a fake tinyproxy, against the hopper's `createEgress`.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEgress } from '../../src/sandbox/egress.ts';

const ROOT = join(import.meta.dirname, '..', '..');

interface Service {
  image?: string;
  restart?: string;
  entrypoint?: string[];
  command?: string[];
  environment?: Record<string, string | null>;
  ports?: unknown[];
  networks?: Record<string, unknown>;
  volumes?: { source?: string; target: string; read_only?: boolean }[];
}
interface Rendered { services: Record<string, Service>; networks?: Record<string, { name?: string; internal?: boolean }>; volumes?: Record<string, unknown> }

function render(): Rendered {
  const dir = mkdtempSync(join(tmpdir(), 'jh-compose-egress-'));
  copyFileSync(join(ROOT, 'compose.yaml'), join(dir, 'compose.yaml'));
  const out = spawnSync('docker', ['compose', 'config', '--format', 'json'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir } });
  rmSync(dir, { recursive: true, force: true });
  expect(out.status, out.stderr).toBe(0);
  return JSON.parse(out.stdout) as Rendered;
}

const svc = (r: Rendered, name: string): Service => {
  const s = r.services[name];
  if (!s) throw new Error(`no service ${name}`);
  return s;
};

const running: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const p of running.splice(0)) p.kill('SIGKILL');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the egress proxy of the read-only boxes (issue #849)', () => {
  const r = render();
  const egress = svc(r, 'egress');
  const hopper = svc(r, 'hopper');

  it('an internal network, which the hopper and the proxy share with the boxes', () => {
    expect(r.networks?.egress).toMatchObject({ name: 'hopper_egress', internal: true });
    expect(Object.keys(egress.networks ?? {}).sort()).toEqual(['default', 'egress']);
    expect(Object.keys(hopper.networks ?? {})).toContain('egress');
    for (const [name, s] of Object.entries(r.services)) {
      if (!['hopper', 'egress'].includes(name)) expect(Object.keys(s.networks ?? { default: null }), name).not.toContain('egress');
    }
  });

  it('the hopper is told the network, the proxy and the shared directory, which it and the proxy alone mount', () => {
    expect(hopper.environment).toMatchObject({ HOPPER_SANDBOX_EGRESS_NETWORK: 'hopper_egress', HOPPER_SANDBOX_EGRESS_PROXY: 'http://egress:3128', HOPPER_SANDBOX_EGRESS_DIR: '/run/hopper-egress' });
    for (const [name, s] of Object.entries(r.services)) {
      const mounts = (s.volumes ?? []).filter((v) => v.source === 'egress');
      expect(mounts.length, name).toBe(['hopper', 'egress'].includes(name) ? 1 : 0);
      for (const m of mounts) expect(m.target).toBe('/run/hopper-egress');
    }
  });

  it('runs the hopper\'s image, restarted unless stopped, on no host port, with no secret', () => {
    expect(egress.image).toBe(hopper.image);
    expect(egress.restart).toBe('unless-stopped');
    expect(egress.ports ?? []).toEqual([]);
    expect(egress.environment ?? {}).toEqual({});
  });

  it('loads each allowlist the hopper writes, and says so: the hopper\'s box waits for it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jh-egress-run-'));
    dirs.push(dir);
    const shared = join(dir, 'shared'), bin = join(dir, 'bin');
    mkdirSync(shared);
    mkdirSync(bin);
    // A fake tinyproxy: it keeps the config and filter it was started or reloaded with.
    writeFileSync(join(bin, 'tinyproxy'), `#!/bin/sh
conf=$3
keep() { cp "$conf" ${JSON.stringify(join(dir, 'conf'))}; f=$(sed -n 's/^Filter "\\(.*\\)"$/\\1/p' "$conf"); cp "$f" ${JSON.stringify(join(dir, 'filter'))}; echo "$1" >> ${JSON.stringify(join(dir, 'loads'))}; }
keep start
trap 'keep reload' USR1
while :; do sleep 0.05; done
`);
    chmodSync(join(bin, 'tinyproxy'), 0o755);
    // Compose's `$$` is a `$` to the shell; the shared directory and /tmp under this test's own.
    const script = egress.command!.join('\n').replaceAll('$$', '$').replaceAll('/run/hopper-egress', shared).replaceAll('/tmp/egress', join(dir, 'proxy'));
    expect(egress.entrypoint).toEqual(['sh', '-eu', '-c']);
    const proc = spawn('sh', ['-eu', '-c', script], { env: { PATH: `${bin}:/usr/bin:/bin` }, stdio: 'ignore' });
    running.push(proc);

    const hopperSide = createEgress({ network: 'hopper_egress', proxy: 'http://egress:3128', dir: shared }, { waitMs: 10_000, pollMs: 20 });
    await hopperSide.allow([]);
    expect(readFileSync(join(dir, 'conf'), 'utf8')).toMatch(/FilterDefaultDeny Yes[\s\S]*ConnectPort 443\n$/);
    expect(readFileSync(join(dir, 'filter'), 'utf8')).toBe('^([a-z0-9-]+\\.)*amazonaws\\.com$\n');

    await hopperSide.allow([{ kind: 'kube', server: 'https://10.0.0.5:6443' }]);
    expect(readFileSync(join(dir, 'conf'), 'utf8')).toMatch(/ConnectPort 443\nConnectPort 6443\n$/);
    expect(readFileSync(join(dir, 'filter'), 'utf8')).toContain('^10\\.0\\.0\\.5$');
    expect(readFileSync(join(dir, 'loads'), 'utf8').trim().split('\n')).toEqual(['start', 'reload']);
  }, 30_000);
});
