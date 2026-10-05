// The rename from job-hopper (issue #112) on a client target: the hopper loads its release into a client
// attached before the rename, and that boot moves the client to the new names, its state kept.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renameClient } from '../../src/client/main.ts';
import { useTempDirs } from '../plugins/support.ts';

const temp = useTempDirs();

function oldClient() {
  const home = temp();
  const at = (...p: string[]) => join(home, ...p);
  const cfg = at('.config', 'job-hopper-client');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'token'), 't\n', { mode: 0o600 });
  writeFileSync(join(cfg, 'known_hosts'), 'job-hopper ssh-ed25519 AAAAhost\n');
  writeFileSync(join(cfg, 'client.env'), [
    `JOB_HOPPER_CLIENT_TOKEN_FILE=${cfg}/token`,
    'JOB_HOPPER_CLIENT_HERDR_BIN=/usr/bin/herdr',
    'JOB_HOPPER_CLIENT_SESSION=job-hopper-client',
    'JOB_HOPPER_CLIENT_HOPPER=me@hopper',
    'JOB_HOPPER_CLIENT_HOPPER_PORT=22',
    `JOB_HOPPER_CLIENT_KEY_FILE=${cfg}/tunnel_ed25519`,
    `JOB_HOPPER_CLIENT_KNOWN_HOSTS=${cfg}/known_hosts`,
    '',
  ].join('\n'), { mode: 0o600 });
  const units = at('.config', 'systemd', 'user');
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, 'job-hopper-client.service'), 'Wants=job-hopper-client-herdr.service\nExecStart=/usr/bin/env node %h/.local/lib/job-hopper-client/main.ts\nEnvironmentFile=%h/.config/job-hopper-client/client.env\n');
  writeFileSync(join(units, 'job-hopper-client-herdr.service'), 'ExecStart=%h/.local/bin/herdr --session job-hopper-client server\n');
  const lib = at('.local', 'lib', 'job-hopper-client');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, 'main.ts'), '// new release\n');
  const env = { INVOCATION_ID: 'x', JOB_HOPPER_CLIENT_TOKEN_FILE: `${cfg}/token` };
  return { home, at, lib, env };
}

describe('renameClient', () => {
  it('a client from after the rename: nothing to do', () => {
    expect(renameClient({ env: { HOPPER_CLIENT_TOKEN_FILE: '/t' }, home: temp(), installDir: '/x' })).toBeUndefined();
  });

  it('old variables outside a unit: an error saying what to do', () => {
    expect(() => renameClient({ env: { JOB_HOPPER_CLIENT_TOKEN_FILE: '/t' }, home: temp(), installDir: '/x' })).toThrow(/rename them to HOPPER_CLIENT_\*/);
  });

  it('moves config, client.env, the pinned key\'s name, the install and the units; the swap script stops the old ones', () => {
    const t = oldClient();
    const swap = renameClient({ env: t.env, home: t.home, installDir: t.lib })!;
    const cfg = t.at('.config', 'hopper-client');
    expect(existsSync(t.at('.config', 'job-hopper-client'))).toBe(false);
    expect(readFileSync(join(cfg, 'client.env'), 'utf8')).toBe([
      `HOPPER_CLIENT_TOKEN_FILE=${cfg}/token`,
      'HOPPER_CLIENT_HERDR_BIN=/usr/bin/herdr',
      'HOPPER_CLIENT_SESSION=hopper-client',
      'HOPPER_CLIENT_HOPPER=me@hopper',
      'HOPPER_CLIENT_HOPPER_PORT=22',
      `HOPPER_CLIENT_KEY_FILE=${cfg}/tunnel_ed25519`,
      `HOPPER_CLIENT_KNOWN_HOSTS=${cfg}/known_hosts`,
      '',
    ].join('\n'));
    expect(statSync(join(cfg, 'client.env')).mode & 0o777).toBe(0o600);
    expect(statSync(join(cfg, 'token')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(cfg, 'known_hosts'), 'utf8')).toBe('hopper ssh-ed25519 AAAAhost\n');
    expect(readFileSync(t.at('.local', 'lib', 'hopper-client', 'main.ts'), 'utf8')).toBe('// new release\n');
    expect(readFileSync(t.at('.config', 'systemd', 'user', 'hopper-client.service'), 'utf8'))
      .toBe('Wants=hopper-client-herdr.service\nExecStart=/usr/bin/env node %h/.local/lib/hopper-client/main.ts\nEnvironmentFile=%h/.config/hopper-client/client.env\n');
    expect(readFileSync(t.at('.config', 'systemd', 'user', 'hopper-client-herdr.service'), 'utf8')).toBe('ExecStart=%h/.local/bin/herdr --session hopper-client server\n');
    expect(swap).toContain('systemctl --user disable --now job-hopper-client.service job-hopper-client-herdr.service');
    expect(swap).toContain('systemctl --user enable --now hopper-client-herdr.service');
    expect(swap).toMatch(/is-active --quiet hopper-client\.service && rm -rf '[^']*\/\.local\/lib\/job-hopper-client'/);
  });

  it('run twice: the second keeps what the first moved', () => {
    const t = oldClient();
    renameClient({ env: t.env, home: t.home, installDir: t.lib });
    const before = readFileSync(t.at('.config', 'hopper-client', 'client.env'), 'utf8');
    renameClient({ env: t.env, home: t.home, installDir: t.lib });
    expect(readFileSync(t.at('.config', 'hopper-client', 'client.env'), 'utf8')).toBe(before);
  });
});
