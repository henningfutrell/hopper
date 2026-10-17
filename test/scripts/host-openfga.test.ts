// OpenFGA for a host install (issue #791): scripts/host-openfga.ts, called by install.sh, puts the release binary of the
// version compose.yaml runs beside the install, its sha256 checked; writes its config and preshared key, mode 600, every
// address on loopback, its tables in the hopper's database's `openfga` schema; and adds HOPPER_OPENFGA_URL and
// HOPPER_OPENFGA_KEY_FILE to daemon.env. daemon.env that names another OpenFGA is the operator's own: nothing is done.
// The download, tar and the database are doubles here.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checksumOf, datastoreUri, HOST_OPENFGA_URL, installHostOpenFga, openFgaConfig, openFgaOf, openFgaVersion, releaseArch, type HostOpenFga } from '../../scripts/host-openfga.ts';
import { loadConfig } from '../../src/config.ts';
import { useTempDirs } from '../plugins/support.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const COMPOSE = readFileSync(join(ROOT, 'compose.yaml'), 'utf8');
const DB = 'postgres://hopper:pw@127.0.0.1:5432/hopper?sslmode=disable';
const temp = useTempDirs();

function rig(o: { env?: string; tarball?: Buffer; checksum?: string } = {}) {
  const root = temp();
  const configDir = join(root, 'config');
  const installDir = join(root, 'lib');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  if (o.env !== undefined) writeFileSync(join(configDir, 'daemon.env'), o.env, { mode: 0o600 });
  const version = openFgaVersion(COMPOSE);
  const file = `openfga_${version}_linux_amd64.tar.gz`;
  const tarball = o.tarball ?? Buffer.from('a tarball');
  const sum = o.checksum ?? createHash('sha256').update(tarball).digest('hex');
  const fetched: string[] = [];
  const schemas: string[] = [];
  const h: HostOpenFga = {
    configDir, installDir, compose: COMPOSE, databaseUrl: DB, arch: 'x64',
    fetch: async (url) => {
      fetched.push(url);
      if (url.endsWith(`/v${version}/${file}`)) return new Response(new Uint8Array(tarball));
      if (url.endsWith(`/v${version}/checksums.txt`)) return new Response(`${'0'.repeat(64)}  other.tar.gz\n${sum}  ${file}\n`);
      return new Response('not found', { status: 404 });
    },
    untar: (_tarball, dir) => writeFileSync(join(dir, 'openfga'), '#!/bin/sh\n'),
    schema: async (url) => { schemas.push(url); },
    log: () => {},
  };
  return { h, configDir, installDir, fetched, schemas, version, file };
}

describe('OpenFGA for a host install (issue #791)', () => {
  it('follows the OpenFGA version compose.yaml runs', () => {
    expect(openFgaVersion(COMPOSE)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(COMPOSE).toContain(`docker.io/openfga/openfga:v${openFgaVersion(COMPOSE)}`);
    expect(() => openFgaVersion('services: {}')).toThrow(/names no docker.io\/openfga\/openfga/);
  });

  it('names the release binary for amd64 and arm64, and refuses another architecture', () => {
    expect(releaseArch('x64')).toBe('amd64');
    expect(releaseArch('arm64')).toBe('arm64');
    expect(() => releaseArch('riscv64')).toThrow(/no linux binary for riscv64/);
  });

  it('reads a file\'s sha256 from the release\'s checksums', () => {
    const hex = 'a'.repeat(64);
    expect(checksumOf(`${'b'.repeat(64)}  x.tar.gz\n${hex}  y.tar.gz\n`, 'y.tar.gz')).toBe(hex);
    expect(() => checksumOf(`${hex}  x.tar.gz\n`, 'y.tar.gz')).toThrow(/name no y.tar.gz/);
  });

  it('keeps OpenFGA\'s tables in the openfga schema of the hopper\'s database, every address on loopback', () => {
    expect(new URL(datastoreUri(DB)).searchParams.get('search_path')).toBe('openfga');
    expect(new URL(datastoreUri(DB)).searchParams.get('sslmode')).toBe('disable');
    const text = openFgaConfig({ databaseUrl: DB, key: 'k'.repeat(64) });
    expect(text).toContain('engine: postgres');
    expect(text).toContain('method: preshared');
    expect(text).toContain(`keys: ["${'k'.repeat(64)}"]`);
    expect(text).toMatch(/^playground:\n {2}enabled: false$/m);
    const addrs = [...text.matchAll(/addr: "([^"]+)"/g)].map((m) => m[1]);
    expect(addrs).toHaveLength(3);
    for (const a of addrs) expect(a).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(addrs).toContain(new URL(HOST_OPENFGA_URL).host);
    // The hopper reads OpenFGA's metrics on port 2112 of the API's host (src/stack-resources/openfga.ts).
    expect(addrs).toContain('127.0.0.1:2112');
  });

  it('installs the checked binary, its config and key (mode 600), the schema, and adds the daemon.env lines the daemon reads', async () => {
    const r = rig({ env: `HOPPER_DATABASE_URL=${DB}\n` });
    expect(await installHostOpenFga(r.h)).toBe('installed');
    expect(readFileSync(join(r.installDir, 'openfga', 'VERSION'), 'utf8').trim()).toBe(r.version);
    expect(statSync(join(r.installDir, 'openfga', 'openfga')).mode & 0o777).toBe(0o755);
    expect(existsSync(join(r.installDir, 'openfga.new'))).toBe(false);
    for (const f of ['key', 'config.yaml']) expect(statSync(join(r.configDir, 'openfga', f)).mode & 0o777).toBe(0o600);
    const key = readFileSync(join(r.configDir, 'openfga', 'key'), 'utf8');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(r.configDir, 'openfga', 'config.yaml'), 'utf8')).toContain(key);
    expect(r.schemas).toEqual([DB]);

    const env = readFileSync(join(r.configDir, 'daemon.env'), 'utf8');
    expect(env).toBe(`HOPPER_DATABASE_URL=${DB}\nHOPPER_OPENFGA_URL=${HOST_OPENFGA_URL}\nHOPPER_OPENFGA_KEY_FILE=${join(r.configDir, 'openfga', 'key')}\n`);
    expect(statSync(join(r.configDir, 'daemon.env')).mode & 0o777).toBe(0o600);
    const vars = Object.fromEntries(env.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const config = loadConfig(vars);
    expect(config.openFgaUrl).toBe(HOST_OPENFGA_URL);
    expect(config.leftoverEnv).toEqual({});
  });

  it('runs again with no new download, the same key, and no second daemon.env line', async () => {
    const r = rig({ env: `HOPPER_DATABASE_URL=${DB}\n` });
    await installHostOpenFga(r.h);
    const key = readFileSync(join(r.configDir, 'openfga', 'key'), 'utf8');
    const env = readFileSync(join(r.configDir, 'daemon.env'), 'utf8');
    const downloads = r.fetched.length;
    expect(await installHostOpenFga(r.h)).toBe('installed');
    expect(r.fetched).toHaveLength(downloads);
    expect(readFileSync(join(r.configDir, 'openfga', 'key'), 'utf8')).toBe(key);
    expect(readFileSync(join(r.configDir, 'daemon.env'), 'utf8')).toBe(env);
  });

  it('refuses a download whose sha256 the release\'s checksums do not give, and installs nothing', async () => {
    const r = rig({ env: '', checksum: 'f'.repeat(64) });
    await expect(installHostOpenFga(r.h)).rejects.toThrow(/sha256 .* is not the one the release's checksums give/);
    expect(existsSync(join(r.installDir, 'openfga'))).toBe(false);
    expect(readFileSync(join(r.configDir, 'daemon.env'), 'utf8')).toBe('');
  });

  it('leaves the operator\'s own OpenFGA alone', async () => {
    const env = `HOPPER_DATABASE_URL=${DB}\nHOPPER_OPENFGA_URL=http://fga.internal:8080\n`;
    expect(openFgaOf(env)).toBe('own');
    expect(openFgaOf(`HOPPER_OPENFGA_URL=${HOST_OPENFGA_URL}\n`)).toBe('ours');
    expect(openFgaOf('')).toBe('absent');
    const r = rig({ env });
    expect(await installHostOpenFga(r.h)).toBe('own');
    expect(r.fetched).toEqual([]);
    expect(existsSync(join(r.configDir, 'openfga'))).toBe(false);
    expect(readFileSync(join(r.configDir, 'daemon.env'), 'utf8')).toBe(env);
  });

  it('install.sh runs it and starts hopper-openfga; uninstall.sh removes the unit', () => {
    const install = readFileSync(join(ROOT, 'scripts', 'install.sh'), 'utf8');
    expect(install).toMatch(/node "\$DEST\/scripts\/host-openfga\.ts" "\$CONFIG_DIR" "\$DEST" "\$APP_DIR\/compose\.yaml"/);
    expect(install).toMatch(/systemctl --user enable hopper-openfga/);
    const unit = readFileSync(join(ROOT, 'systemd', 'hopper-openfga.service'), 'utf8');
    expect(unit).toMatch(/^WorkingDirectory=%h\/\.config\/hopper\/openfga$/m);
    expect(unit).toMatch(/^ExecStartPre=%h\/\.local\/lib\/hopper\/openfga\/openfga migrate$/m);
    expect(unit).toMatch(/^ExecStart=%h\/\.local\/lib\/hopper\/openfga\/openfga run$/m);
    expect(unit).toMatch(/^Before=hopper\.service$/m);
    expect(readFileSync(join(ROOT, 'scripts', 'uninstall.sh'), 'utf8')).toMatch(/hopper-openfga\.service/);
  });
});
