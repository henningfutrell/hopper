// The hopper client's entry (design.md "Client targets", issue #59): `node main.ts`, run by the
// hopper-client unit on a client target. Process settings from its environment:
//   HOPPER_CLIENT_TOKEN_FILE   the client's token (a file only this user may read), shared with the hopper
//   HOPPER_CLIENT_HERDR_BIN    this machine's herdr (absolute)
//   HOPPER_CLIENT_SESSION      the herdr session the hopper's jobs run in (never `default`)
//   HOPPER_CLIENT_HOPPER       the hopper's machine, user@host; HOPPER_CLIENT_HOPPER_PORT (default 22)
//   HOPPER_CLIENT_KEY_FILE     this client's ssh key; HOPPER_CLIENT_KNOWN_HOSTS the hopper's pinned host key
// The client's install dir is this file's directory: the hopper loads its release there (release.ts,
// issue #70), and the client exits 75 so its unit (Restart=always) starts the new files.
//
// The rename from job-hopper (issue #112): a client attached before it runs as job-hopper-client, and the
// hopper loads this release into that install, once no job runs there. That boot moves the client to the
// new names (renameClient) — the only code here that reads the old ones — and hands over to the new units.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startClient } from './server.ts';
import { dialHopper } from './tunnel.ts';

const OLD = 'job-hopper';
const OLD_ENV = 'JOB_HOPPER_CLIENT_';
const NEW_ENV = 'HOPPER_CLIENT_';
const UNITS = ['-client', '-client-herdr'] as const;

/**
 * A client attached before the rename, booting this release: move its config dir, client.env (keys, the
 * paths into the moved dir, and its herdr session `job-hopper-client` → `hopper-client`), its pinned host
 * key's name, its install dir and its units to the new names. Returns the shell script that swaps the
 * units over, for a transient unit of its own (it stops the unit this process runs in); undefined: no
 * old client here. Re-running is safe: whatever is already under the new name is kept.
 */
export function renameClient(o: { env: Record<string, string | undefined>; home: string; installDir: string }): string | undefined {
  if (o.env[`${NEW_ENV}TOKEN_FILE`] || !o.env[`${OLD_ENV}TOKEN_FILE`]) return undefined;
  if (!o.env.INVOCATION_ID) throw new Error(`${OLD_ENV}* set and no ${NEW_ENV}TOKEN_FILE: rename them to ${NEW_ENV}* (or attach this machine again: scripts/attach-client.sh)`);
  const config = (name: string) => join(o.home, '.config', `${name}-client`);
  const lib = (name: string) => join(o.home, '.local', 'lib', `${name}-client`);
  const unit = (name: string, suffix: string) => join(o.home, '.config', 'systemd', 'user', `${name}${suffix}.service`);

  if (existsSync(config(OLD)) && !existsSync(config('hopper'))) renameSync(config(OLD), config('hopper'));
  const envFile = join(config('hopper'), 'client.env');
  if (existsSync(envFile)) {
    const lines = readFileSync(envFile, 'utf8').split('\n').map((line) => {
      const eq = line.indexOf('=');
      if (eq < 0) return line;
      let key = line.slice(0, eq);
      let value = line.slice(eq + 1);
      if (key.startsWith(OLD_ENV)) key = NEW_ENV + key.slice(OLD_ENV.length);
      if (value === config(OLD) || value.startsWith(`${config(OLD)}/`)) value = config('hopper') + value.slice(config(OLD).length);
      if (key === `${NEW_ENV}SESSION`) value = value.replaceAll(OLD, 'hopper');
      return `${key}=${value}`;
    });
    writeFileSync(envFile, lines.join('\n'), { mode: 0o600 });
  }
  const knownHosts = join(config('hopper'), 'known_hosts');
  if (existsSync(knownHosts)) writeFileSync(knownHosts, readFileSync(knownHosts, 'utf8').replace(new RegExp(`^${OLD} `, 'gm'), 'hopper '));
  if (!existsSync(lib('hopper'))) cpSync(o.installDir, lib('hopper'), { recursive: true });
  for (const s of UNITS) {
    if (existsSync(unit(OLD, s)) && !existsSync(unit('hopper', s))) {
      writeFileSync(unit('hopper', s), readFileSync(unit(OLD, s), 'utf8').replaceAll(OLD, 'hopper'), { mode: 0o644 });
    }
  }
  const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  return [
    'systemctl --user daemon-reload',
    `systemctl --user disable --now ${UNITS.map((s) => `${OLD}${s}.service`).join(' ')}`,
    `rm -f ${UNITS.map((s) => q(unit(OLD, s))).join(' ')}`,
    'systemctl --user daemon-reload',
    'systemctl --user enable --now hopper-client-herdr.service',
    'systemctl --user enable hopper-client.service',
    'systemctl --user restart hopper-client.service',
    'sleep 10',
    `systemctl --user is-active --quiet hopper-client.service && rm -rf ${[lib(OLD), `${lib(OLD)}.prev`, `${lib(OLD)}.next`].map(q).join(' ')}`,
  ].join('\n');
}

function setting(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function ownerOnly(file: string): string {
  if ((lstatSync(file).mode & 0o077) !== 0) throw new Error(`${file} is readable by others; make it 600`);
  return file;
}

function run(): void {
  const installDir = dirname(fileURLToPath(import.meta.url));
  const swap = renameClient({ env: process.env, home: homedir(), installDir });
  if (swap !== undefined) {
    process.stdout.write('hopper-client: moved to the hopper names; handing over to hopper-client.service\n');
    spawn('systemd-run', ['--user', '--collect', '--quiet', `--unit=hopper-client-rename-${Date.now()}`, '/bin/sh', '-c', swap], { stdio: 'inherit' })
      .on('error', (e) => { process.stderr.write(`hopper-client: systemd-run failed: ${e.message}\n`); process.exit(1); });
    process.once('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 60_000);
    return;
  }
  const tokenFile = ownerOnly(setting('HOPPER_CLIENT_TOKEN_FILE'));
  const client = startClient({
    token: () => readFileSync(tokenFile, 'utf8').trim(),
    herdrBin: setting('HOPPER_CLIENT_HERDR_BIN'),
    session: setting('HOPPER_CLIENT_SESSION'),
    tunnel: dialHopper({
      hopper: setting('HOPPER_CLIENT_HOPPER'),
      port: Number(process.env.HOPPER_CLIENT_HOPPER_PORT ?? 22),
      keyFile: ownerOnly(setting('HOPPER_CLIENT_KEY_FILE')),
      knownHostsFile: setting('HOPPER_CLIENT_KNOWN_HOSTS'),
    }),
    log: (line) => process.stdout.write(`${line}\n`),
    installDir,
    onLoaded: () => { void client.stop().then(() => process.exit(75)); },
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void client.stop().then(() => process.exit(0)); });
}

if (import.meta.main) run();
