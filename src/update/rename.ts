// The rename from job-hopper to hopper (issue #112), on the hopper's host: the one place the old names
// are read. An install from before it is moved to the new names, never abandoned (design.md "Rename
// from job-hopper"): its config dir and daemon.env (every key, and every value naming a moved dir), its
// work dir (pinned host keys, client sockets, the update mirror), the forced commands its client targets'
// keys run here, its CLI link, its systemd --user units and its install dir.
//
// The herdr session goes with the units, and stopping it closes every pane in it, so nothing moves while a
// job holds a pane there (`paneJobs`). Two ways in:
//   - install.sh, after it built the new install: `node <new install>/src/update/rename.ts install`
//     moves the state, then install.sh installs the new units as on any upgrade, then `... cleanup`.
//   - the self-update of a job-hopper install: its old updater swaps this code into the old install dir
//     and restarts the old unit. That boot (main.ts `renameBoot`) waits for no pane job, then hands over
//     to `node <old install dir>/src/update/rename.ts handover` in its own systemd scope — the handover
//     stops the old unit, so it must not run in its cgroup.
import { execFile, spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { Job } from '../domain/types.ts';
import { runtimeSecrets } from '../secrets/runtime.ts';
import type { UserStore } from '../domain/ports.ts';
import { openInstanceStore } from '../store/index.ts';

const exec = promisify(execFile);

/** The old product name: dirs, units, the herdr session. */
export const OLD_NAME = 'job-hopper';
const OLD_ENV = 'JOB_HOPPER_';
const NEW_NAME = 'hopper';
const NEW_ENV = 'HOPPER_';
const UNITS = ['', '-herdr'] as const;

export interface RenamePaths {
  home: string;
  /** The user's cache dir (systemd's %C): the work dir lives in it. */
  cache: string;
}

export function renamePaths(env: Record<string, string | undefined>, home: string): RenamePaths {
  return { home, cache: env.XDG_CACHE_HOME || join(home, '.cache') };
}

const dirs = (p: RenamePaths, name: string) => ({
  config: join(p.home, '.config', name),
  lib: join(p.home, '.local', 'lib', name),
  bin: join(p.home, '.local', 'bin', name),
  work: join(p.cache, name),
  unit: (suffix: string) => join(p.home, '.config', 'systemd', 'user', `${name}${suffix}.service`),
});

/** The process environment of a job-hopper install: its database named under the old prefix, none under the new. */
export function isRenameEnv(env: Record<string, string | undefined>): boolean {
  const has = (prefix: string) => Boolean(env[`${prefix}DATABASE_URL`] || env[`${prefix}DATABASE_URL_FILE`]);
  return has(OLD_ENV) && !has(NEW_ENV);
}

/** The old variables set in this environment: what a deploy without the handover must rename itself. */
export const oldVariables = (env: Record<string, string | undefined>): string[] =>
  Object.keys(env).filter((k) => k.startsWith(OLD_ENV)).sort();

/** The same environment under the new names, for the boot that reads it once before the handover. */
export function renamedEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) out[k.startsWith(OLD_ENV) ? NEW_ENV + k.slice(OLD_ENV.length) : k] = v;
  return out;
}

/** This process runs from the old install dir: a job-hopper install's self-update swapped this code in. */
export const inOldInstall = (appDir: string): boolean => basename(appDir) === OLD_NAME;

/**
 * daemon.env under the new names: every old key renamed, every value naming the old config or work dir
 * (a token file, a key file) naming the moved one. Comments, blank lines and other keys are kept as they are.
 */
export function renameEnvText(text: string, p: RenamePaths): string {
  const from = dirs(p, OLD_NAME);
  const to = dirs(p, NEW_NAME);
  return text.split('\n').map((line) => {
    const eq = line.indexOf('=');
    if (eq < 0 || line.trimStart().startsWith('#')) return line;
    let key = line.slice(0, eq);
    if (key.startsWith(OLD_ENV)) key = NEW_ENV + key.slice(OLD_ENV.length);
    const value = movedPath(movedPath(line.slice(eq + 1), from.config, to.config), from.work, to.work);
    return `${key}=${value}`;
  }).join('\n');
}

/** `value` with the leading dir `from` replaced by `to`, when it is that dir or under it. */
function movedPath(value: string, from: string, to: string): string {
  return value === from || value.startsWith(`${from}/`) ? to + value.slice(from.length) : value;
}

/**
 * ~/.ssh/authorized_keys with each client target's line (marked `job-hopper-client:<name>`) running the
 * relay from the new install dir and opening its socket in the new work dir. Every other line is kept.
 */
export function renameAuthorizedKeys(text: string, p: RenamePaths): string {
  const from = dirs(p, OLD_NAME);
  const to = dirs(p, NEW_NAME);
  const mark = new RegExp(` ${OLD_NAME}-client:([A-Za-z0-9_-]+)$`);
  return text.split('\n').map((line) => {
    if (!mark.test(line)) return line;
    return line.replace(mark, ` ${NEW_NAME}-client:$1`)
      .replaceAll(`${from.lib}/`, `${to.lib}/`)
      .replaceAll(`${from.work}/`, `${to.work}/`);
  }).join('\n');
}

/** Jobs holding a pane in this machine's old herdr session: stopping the session would close them. */
export function paneJobs(active: Job[]): string[] {
  return active
    .filter((j) => {
      const s = j.executorState;
      return s?.session === OLD_NAME && s.ssh === undefined && s.client === undefined;
    })
    .map((j) => `job ${j.id} (${j.status})`);
}

export const PANE_JOB_STATUSES = ['claimed', 'running', 'waiting_answer'] as const;

export type Systemctl = (args: string[]) => Promise<void>;
export const systemctl: Systemctl = async (args) => { await exec('systemctl', ['--user', ...args]); };

export interface MoveOptions {
  paths: RenamePaths;
  systemctl: Systemctl;
  log: (line: string) => void;
}

/**
 * Stop the old daemon and move its state to the new names. The old herdr unit is stopped last, with the
 * old units removed: the caller has made sure no job holds a pane in its session. Re-running is safe: a
 * step whose new place is already there is skipped, and both places left are reported, never merged.
 */
export async function moveState(o: MoveOptions): Promise<void> {
  const from = dirs(o.paths, OLD_NAME);
  const to = dirs(o.paths, NEW_NAME);
  const ignore = (args: string[]) => o.systemctl(args).catch(() => {});

  await ignore(['stop', `${OLD_NAME}.service`]);
  for (const [what, a, b] of [['config dir', from.config, to.config], ['work dir', from.work, to.work]] as const) {
    if (!existsSync(a)) continue;
    if (existsSync(b)) { o.log(`hopper: rename: ${what} ${a} kept beside ${b}: both exist, nothing merged`); continue; }
    renameSync(a, b);
    o.log(`hopper: rename: moved ${a} to ${b}`);
  }
  const envFile = join(to.config, 'daemon.env');
  if (existsSync(envFile)) {
    const text = readFileSync(envFile, 'utf8');
    const next = renameEnvText(text, o.paths);
    if (next !== text) {
      writeFileSync(envFile, next, { mode: 0o600 });
      o.log(`hopper: rename: ${envFile}: ${OLD_ENV}* renamed to ${NEW_ENV}*`);
    }
    chmodSync(envFile, 0o600);
  }
  const keys = join(o.paths.home, '.ssh', 'authorized_keys');
  if (existsSync(keys)) {
    const text = readFileSync(keys, 'utf8');
    const next = renameAuthorizedKeys(text, o.paths);
    if (next !== text) {
      writeFileSync(keys, next, { mode: 0o600 });
      o.log(`hopper: rename: ${keys}: client targets' relay lines point at the new install`);
    }
  }
  if (isLink(from.bin)) rmSync(from.bin);

  const oldUnits = UNITS.map((s) => `${OLD_NAME}${s}.service`);
  await ignore(['disable', '--now', ...oldUnits]);
  for (const s of UNITS) rmSync(from.unit(s), { force: true });
  await ignore(['daemon-reload']);
  o.log(`hopper: rename: stopped and removed ${oldUnits.join(', ')}`);
}

/** The old install dir and the ones self-update keeps beside it, once the new install runs. */
export function removeOldInstall(o: { paths: RenamePaths; log: (line: string) => void }): void {
  const lib = dirs(o.paths, OLD_NAME).lib;
  for (const d of [lib, `${lib}.prev`, `${lib}.next`]) {
    if (!existsSync(d)) continue;
    rmSync(d, { recursive: true, force: true });
    o.log(`hopper: rename: removed ${d}`);
  }
}

function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

export interface HandoverOptions extends MoveOptions {
  /** The old install dir this code was swapped into. */
  appDir: string;
  /** Answers when the new daemon is up; false: not within its tries. */
  healthy: (port: number) => Promise<boolean>;
}

/**
 * The self-update's half (the old unit runs this code from the old install dir): copy the install to the
 * new dir, move the state, install and start the new units, and remove the old install dir once the new
 * daemon answers. A new daemon that does not answer leaves the old install dir in place, and says so.
 */
export async function handover(o: HandoverOptions): Promise<boolean> {
  const to = dirs(o.paths, NEW_NAME);
  if (!existsSync(to.lib)) {
    cpSync(o.appDir, to.lib, { recursive: true, verbatimSymlinks: true });
    o.log(`hopper: rename: copied ${o.appDir} to ${to.lib}`);
  }
  await moveState(o);
  rmSync(to.bin, { force: true });
  symlinkSync(join(to.lib, 'src', 'cli.ts'), to.bin);
  for (const s of UNITS) writeFileSync(to.unit(s), readFileSync(join(to.lib, 'systemd', `${NEW_NAME}${s}.service`), 'utf8'), { mode: 0o644 });
  await o.systemctl(['daemon-reload']);
  await o.systemctl(['enable', `${NEW_NAME}-herdr.service`, `${NEW_NAME}.service`]);
  await o.systemctl(['start', `${NEW_NAME}-herdr.service`]);
  await o.systemctl(['restart', `${NEW_NAME}.service`]);
  const env = envLines(join(to.config, 'daemon.env'));
  if (env.HOPPER_PLUGIN_DIR) await exec(process.execPath, [join(to.lib, 'scripts', 'write-plugin-tsconfig.ts'), env.HOPPER_PLUGIN_DIR, join(to.lib, 'src', 'plugins', 'sdk.ts')]).catch(() => {});
  if (!(await o.healthy(Number(env.HOPPER_PORT || 4790)))) {
    o.log(`hopper: rename: ${NEW_NAME}.service does not answer; kept ${o.appDir}. Inspect: journalctl --user -u ${NEW_NAME} -n 50`);
    return false;
  }
  removeOldInstall(o);
  o.log(`hopper: rename: done; ${NEW_NAME}.service runs from ${to.lib}`);
  return true;
}

function envLines(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.startsWith('#')) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** `/api/health` of the new daemon, 40 tries 0.5 s apart. */
async function answers(port: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Start the handover in a transient unit of its own: it stops the unit this process runs in. */
export function startHandover(appDir: string): void {
  const child = spawn('systemd-run', [
    '--user', '--collect', '--quiet', `--unit=${NEW_NAME}-rename-${Date.now()}`, `--setenv=PATH=${process.env.PATH ?? '/usr/bin'}`,
    process.execPath, join(appDir, 'src', 'update', 'rename.ts'), 'handover', appDir,
  ], { stdio: 'inherit' });
  child.on('error', (e) => console.error(`hopper: rename: systemd-run failed: ${e.message}`));
}

/** The pane jobs in the database the env file names (under either prefix), read with the daemon stopped; none named: none. */
/** Owner's store (a job-hopper install had one user: issue #158 made its work owner's), closed after `fn`. */
function withOwnerStore<T>(url: string, fn: (store: UserStore) => T): T {
  const instance = openInstanceStore({ url, clock: { now: () => new Date() } });
  try {
    const store = instance.userStore(instance.users.owner());
    try { return fn(store); } finally { store.close(); }
  } finally {
    instance.close();
  }
}

function paneJobsIn(env: Record<string, string | undefined>): string[] {
  const url = runtimeSecrets(renamedEnv(env))('HOPPER_DATABASE_URL');
  if (!url) return [];
  return withOwnerStore(url, (store) => paneJobs(store.jobs.list({ status: [...PANE_JOB_STATUSES] })));
}

const waitsFor = (jobs: string[]): string =>
  `the rename to hopper waits for ${jobs.join(', ')}: ${jobs.length === 1 ? 'it holds a pane' : 'they hold panes'} in herdr session ${OLD_NAME}, which the rename stops`;

export type RenameBoot = 'none' | 'handover' | 'rollback';

/**
 * The boot of a job-hopper install's self-update (main.ts, before anything starts). With no job holding a
 * pane in the old session: hand over (the caller then waits to be stopped). Else: put the previous install
 * back, record why the update did not take, and have the caller exit for the old unit to start it — the
 * old updater offers the update again, and it is taken once the panes are gone. Outside a job-hopper
 * install's unit, old variables with no new database are an error that names them.
 */
export function renameBoot(o: {
  env: Record<string, string | undefined>; appDir: string; log: (line: string) => void;
  /** Default: startHandover (systemd-run). */
  start?: (appDir: string) => void;
}): RenameBoot {
  if (!isRenameEnv(o.env)) return 'none';
  if (!o.env.INVOCATION_ID || !inOldInstall(o.appDir)) {
    throw new Error(`${oldVariables(o.env).join(', ')} set, and no ${NEW_ENV}DATABASE_URL: rename every ${OLD_ENV}* variable to ${NEW_ENV}* (docs/deploy.md "Rename from job-hopper")`);
  }
  const env = renamedEnv(o.env);
  const url = runtimeSecrets(env)('HOPPER_DATABASE_URL')!;
  const jobs = withOwnerStore(url, (store) => {
    const held = paneJobs(store.jobs.list({ status: [...PANE_JOB_STATUSES] }));
    if (held.length > 0) {
      const pendingFile = join(env.HOPPER_WORK_DIR ?? '', 'update', 'pending.json');
      let to: unknown;
      try { to = (JSON.parse(readFileSync(pendingFile, 'utf8')) as { to?: unknown }).to; } catch { /* no pending update */ }
      store.events.append({ type: 'update.failed', data: { ...(typeof to === 'string' ? { to } : {}), error: waitsFor(held) } });
      rmSync(pendingFile, { force: true });
    }
    return held;
  });
  if (jobs.length === 0) {
    o.log(`hopper: rename: no job holds a pane in herdr session ${OLD_NAME}; handing over to ${NEW_NAME}.service`);
    (o.start ?? startHandover)(o.appDir);
    return 'handover';
  }
  const prev = `${o.appDir}.prev`;
  if (!existsSync(prev)) throw new Error(`${waitsFor(jobs)}; and there is no ${prev} to run until then`);
  rmSync(`${o.appDir}.next`, { recursive: true, force: true });
  renameSync(o.appDir, `${o.appDir}.next`);
  renameSync(prev, o.appDir);
  o.log(`hopper: rename: ${waitsFor(jobs)}; running the previous install until then`);
  return 'rollback';
}

// The command line install.sh and the handover unit run: install | cleanup | handover <old install dir>.
async function cli(argv: string[]): Promise<number> {
  const paths = renamePaths(process.env, process.env.HOME ?? '');
  const log = (line: string) => { process.stdout.write(`${line}\n`); };
  const [command, appDir] = argv;
  if (command === 'install') {
    const from = dirs(paths, OLD_NAME);
    if (![from.config, from.lib, from.unit('')].some((p) => existsSync(p))) return 0;
    // Stopped first, so no job starts between the look and the move; started again if the move must wait.
    const wasActive = await systemctl(['is-active', '--quiet', `${OLD_NAME}.service`]).then(() => true, () => false);
    await systemctl(['stop', `${OLD_NAME}.service`]).catch(() => {});
    const envFile = [join(from.config, 'daemon.env'), join(dirs(paths, NEW_NAME).config, 'daemon.env')].find((f) => existsSync(f));
    const jobs = envFile ? paneJobsIn(envLines(envFile)) : [];
    if (jobs.length > 0) {
      if (wasActive) await systemctl(['start', `${OLD_NAME}.service`]).catch(() => {});
      console.error(`hopper: ${waitsFor(jobs)}. Run install.sh again once they finish.`);
      return 1;
    }
    await moveState({ paths, systemctl, log });
    return 0;
  }
  if (command === 'cleanup') {
    removeOldInstall({ paths, log });
    return 0;
  }
  if (command === 'handover' && appDir) return (await handover({ paths, systemctl, log, appDir, healthy: answers })) ? 0 : 1;
  console.error('usage: node src/update/rename.ts install | cleanup | handover <old install dir>');
  return 2;
}

if (import.meta.main) cli(process.argv.slice(2)).then((code) => process.exit(code), (e: unknown) => {
  console.error(`hopper: rename: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
