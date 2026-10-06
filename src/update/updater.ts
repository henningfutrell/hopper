// The self-update loop (design.md "Self-update", issue #44): check the update repository for a
// newer target on the channel, and apply one without losing work — build it beside the running
// install, prove it loads, wait while a restart would lose a running job, swap it in, restart.
// Restart recovery (src/engine/recovery.ts) reattaches running jobs and re-drives open questions;
// the boot after reports `update.applied` from the pending file this loop leaves behind.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { Clock, InstanceEvents, InstanceSettingsRepository, Restarter, UpdateBuilder, Updater } from '../domain/ports.ts';
import type { InstallInfo, UpdateApply, UpdateRelease, UpdateSettings, UpdateStatus, VersionHistory } from '../domain/types.ts';
import { createGitMirror, type GitMirror } from './git.ts';
import { bullets, newSince, WHATS_NEW_FILE } from './whats-new.ts';
import { nextDirOf, readInstallInfo, swapInstall } from './install.ts';

const exec = promisify(execFile);
const DEFAULTS: UpdateSettings = { channel: 'main', autoUpdate: false };
const FIRST_CHECK_MS = 10_000;
const LOAD_TIMEOUT_MS = 60_000;
/** How many of the installed version's What's new lines the Updates panel shows. */
const INSTALLED_WHATS_NEW = 5;

export interface UpdaterOptions {
  /** The install this process runs from (holds install.json and src/). */
  appDir: string;
  /** Holds update/: the repository mirror, the unpacked source, the pending file. */
  dataDir: string;
  /** The instance's update settings. */
  settings: Pick<InstanceSettingsRepository, 'getUpdateSettings' | 'setUpdateSettings'>;
  /** Where update.* events go (every user's event log, issue #158), and the last one announced is read. */
  events: InstanceEvents;
  clock: Clock;
  logger: { info(line: string): void; warn(line: string): void };
  builder: UpdateBuilder;
  restart: Restarter;
  /** Running jobs a restart would lose (their executor can neither reattach nor re-run them); empty: safe. */
  /** How many running jobs, of every user, a restart would lose. */
  restartBlockers: () => number;
  /** How often to check on its own; 0: only when asked. */
  checkMs: number;
  /** How often to look again while waiting on restart blockers. */
  waitMs?: number;
  /** Default: a bare mirror under `<dataDir>/update/repo.git`. */
  mirror?: GitMirror;
}

interface Checked {
  state: 'unavailable' | 'current' | 'available' | 'error';
  reason?: string;
  installed?: InstallInfo;
  target?: { commit: string; ref: string };
  release?: UpdateRelease;
  whatsNew: string[];
  /** Commits in the target and not installed: the log line and `update.available`, never the UI. */
  commits?: number;
  checkedAt?: string;
}

interface Pending { from: string; to: string; ref: string }

const short = (sha: string): string => sha.slice(0, 7);
const firstLine = (s: string | undefined): string => (s ?? '').trim().split('\n').find((l) => l.trim()) ?? '';
const messageOf = (e: unknown): string => {
  const err = e as { stderr?: string; message?: string };
  return firstLine(err.stderr) || firstLine(err.message) || String(e);
};

/** The newest bullets of the install's own WHATS-NEW.md (install.sh and the image copy it); none without one. */
function installedWhatsNew(appDir: string): string[] {
  const file = join(appDir, WHATS_NEW_FILE);
  return existsSync(file) ? bullets(readFileSync(file, 'utf8')).slice(0, INSTALLED_WHATS_NEW) : [];
}

/** Imports the new build's composition root in a child process: a module that fails to load fails here, not after the swap. */
async function proveLoads(dir: string): Promise<void> {
  const main = pathToFileURL(join(dir, 'src', 'main.ts')).href;
  try {
    await exec(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(main)}); process.exit(0);`], { cwd: dir, timeout: LOAD_TIMEOUT_MS });
  } catch (e) {
    throw new Error(`the new build does not load: ${messageOf(e)}`, { cause: e });
  }
}

export interface RunningUpdater extends Updater {
  /** Report the result of an update applied before this boot, then check every `checkMs`. */
  start(): void;
  stop(): void;
}

export function createUpdater(o: UpdaterOptions): RunningUpdater {
  const updateDir = join(o.dataDir, 'update');
  const pendingFile = join(updateDir, 'pending.json');
  const mirror = o.mirror ?? createGitMirror(join(updateDir, 'repo.git'));
  const now = () => o.clock.now().toISOString();
  // Until the first check: what install.json says, or why there is none.
  const read = readInstallInfo(o.appDir);
  let checked: Checked = read.ok
    ? { state: 'current', installed: read.info, whatsNew: [] }
    : { state: 'unavailable', reason: read.reason, whatsNew: [] };
  let applying: UpdateApply | undefined;
  let applyError: string | undefined;
  let checking: Promise<UpdateStatus> | undefined;
  let stopped = false;
  const timers: NodeJS.Timeout[] = [];

  const settings = (): UpdateSettings => ({ ...DEFAULTS, ...o.settings.getUpdateSettings() });
  const append = (type: 'update.available' | 'update.started' | 'update.applied' | 'update.failed', data: Record<string, unknown>): void => {
    if (!stopped) o.events.append({ type, data });
  };
  const lastAnnounced = (): unknown => o.events.recent(1, ['update.available'])[0]?.data.to;

  // The install does not change under a running process: read once.
  const installedNews = installedWhatsNew(o.appDir);

  function status(): UpdateStatus {
    const { commits: _commits, ...rest } = checked;
    const base = { ...settings(), ...rest, installedWhatsNew: installedNews };
    if (applying) return { ...base, state: 'applying', apply: applying };
    if (applyError) return { ...base, state: 'error', reason: applyError };
    return base;
  }

  async function compare(info: InstallInfo): Promise<Checked> {
    const at = now();
    try {
      await mirror.fetch(info.repo);
    } catch (e) {
      return { ...checked, state: 'error', reason: `fetch from ${info.repo} failed: ${messageOf(e)}`, installed: info, checkedAt: at };
    }
    const newest = await mirror.newestRelease();
    const release = newest && { ...newest, newer: !(await mirror.contains(info.commit, newest.commit)) };
    const base = { installed: info, release, whatsNew: [], checkedAt: at };
    let target: Checked['target'];
    if (settings().channel === 'release') {
      if (!newest) return { ...base, state: 'current', reason: 'no release yet (no v<major>.<minor>.<patch> tag)' };
      target = { commit: newest.commit, ref: newest.tag };
    } else {
      const head = await mirror.branchHead(info.branch);
      if (!head) return { ...base, state: 'error', reason: `branch ${info.branch} not found in ${info.repo}` };
      target = { commit: head, ref: info.branch };
    }
    if (target.commit === info.commit || (await mirror.contains(info.commit, target.commit))) return { ...base, state: 'current', target };
    const notes = async (commit: string) => bullets((await mirror.read(commit, WHATS_NEW_FILE)) ?? '');
    const whatsNew = newSince(await notes(info.commit), await notes(target.commit));
    return { ...base, state: 'available', target, whatsNew, commits: await mirror.count(info.commit, target.commit) };
  }

  async function runCheck(): Promise<UpdateStatus> {
    const read = readInstallInfo(o.appDir);
    if (!read.ok) {
      checked = { state: 'unavailable', reason: read.reason, whatsNew: [], checkedAt: now() };
      return status();
    }
    try {
      checked = await compare(read.info);
    } catch (e) {
      checked = { ...checked, state: 'error', reason: messageOf(e), installed: read.info, checkedAt: now() };
    }
    if (checked.state === 'error') o.logger.warn(`hopper: update check failed: ${checked.reason}`);
    applyError = undefined;
    const { target, installed } = checked;
    if (checked.state === 'available' && target && installed) {
      if (lastAnnounced() !== target.commit) {
        append('update.available', { from: installed.commit, to: target.commit, ref: target.ref, changes: checked.commits ?? 0 });
        o.logger.info(`hopper: update available: ${target.ref} ${short(target.commit)} (${checked.commits ?? 0} commit(s) not installed)`);
      }
      if (settings().autoUpdate) apply();
    }
    return status();
  }

  function check(): Promise<UpdateStatus> {
    if (applying || stopped) return Promise.resolve(status());
    checking ??= runCheck().finally(() => { checking = undefined; });
    return checking;
  }

  async function build(info: InstallInfo): Promise<void> {
    const source = join(updateDir, 'source');
    const next = nextDirOf(o.appDir);
    try {
      await mirror.extract(info.commit, source);
      rmSync(next, { recursive: true, force: true });
      await o.builder.build(source, next, info);
      await proveLoads(next);
    } catch (e) {
      rmSync(next, { recursive: true, force: true });
      throw e;
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  }

  async function run(installed: InstallInfo, target: { commit: string; ref: string }): Promise<void> {
    await build({ repo: installed.repo, branch: installed.branch, commit: target.commit, installedAt: now() });
    for (;;) {
      const blockers = o.restartBlockers();
      if (blockers === 0) break;
      if (stopped) throw new Error('stopped while waiting to restart');
      applying = { ...applying!, phase: 'waiting', detail: `waiting for ${blockers} running job${blockers === 1 ? '' : 's'}: a restart would lose ${blockers === 1 ? 'it' : 'them'}` };
      await new Promise((r) => setTimeout(r, o.waitMs ?? 5000));
    }
    applying = { ...applying!, phase: 'restarting', detail: `restarting on ${target.ref} ${short(target.commit)}` };
    swapInstall(o.appDir);
    mkdirSync(updateDir, { recursive: true });
    writeFileSync(pendingFile, JSON.stringify({ from: installed.commit, to: target.commit, ref: target.ref } satisfies Pending));
    o.logger.info(`hopper: update ${short(installed.commit)} → ${short(target.commit)} in place; restarting`);
    await o.restart();
  }

  function apply(): ReturnType<Updater['apply']> {
    if (applying) return { ok: false, error: 'an update is already being applied' };
    const { installed, target } = checked;
    if (checked.state !== 'available' || !installed || !target) return { ok: false, error: 'no update available' };
    applying = { phase: 'building', detail: `building ${target.ref} ${short(target.commit)} beside the running install`, target: target.commit, startedAt: now() };
    applyError = undefined;
    append('update.started', { from: installed.commit, to: target.commit, ref: target.ref });
    o.logger.info(`hopper: applying update ${short(installed.commit)} → ${target.ref} ${short(target.commit)}`);
    run(installed, target).catch((e: unknown) => {
      applying = undefined;
      applyError = e instanceof Error ? e.message : String(e);
      o.logger.warn(`hopper: update to ${short(target.commit)} failed, install unchanged: ${applyError}`);
      append('update.failed', { to: target.commit, error: applyError });
    });
    return { ok: true, status: status() };
  }

  /** The boot after an apply: is this install the commit it swapped in? */
  function settlePending(): void {
    if (!existsSync(pendingFile)) return;
    let pending: Pending;
    try {
      pending = JSON.parse(readFileSync(pendingFile, 'utf8')) as Pending;
    } finally {
      rmSync(pendingFile, { force: true });
    }
    const read = readInstallInfo(o.appDir);
    if (read.ok && read.info.commit === pending.to) {
      append('update.applied', { from: pending.from, to: pending.to, ref: pending.ref });
      o.logger.info(`hopper: running the applied update ${pending.ref} ${short(pending.to)}`);
      return;
    }
    const on = read.ok ? short(read.info.commit) : 'an install without install.json';
    append('update.failed', { to: pending.to, error: `the boot after the update runs ${on}, not ${short(pending.to)}` });
  }

  // A commit's history never changes: computed once per installed commit.
  let history: { commit: string; versions: VersionHistory['versions'] } | undefined;

  async function versionHistory(): Promise<VersionHistory> {
    const read = readInstallInfo(o.appDir);
    if (!read.ok) return { versions: [], reason: read.reason };
    const { commit } = read.info;
    if (history?.commit === commit) return { versions: history.versions };
    if (!(await mirror.has(commit))) await check();
    if (!(await mirror.has(commit))) return { versions: [], reason: checked.reason ?? `the installed commit ${short(commit)} is not in ${read.info.repo}` };
    const versions = (await mirror.added(commit, WHATS_NEW_FILE)).map((v) => ({ commit: v.commit, at: v.at, changes: v.lines }));
    history = { commit, versions };
    return { versions };
  }

  return {
    status,
    check,
    apply,
    history: versionHistory,
    settings(patch) {
      const before = settings();
      o.settings.setUpdateSettings(patch);
      const after = settings();
      if (after.channel !== before.channel) void check().catch(() => {});
      else if (after.autoUpdate && !before.autoUpdate && checked.state === 'available') apply();
      return status();
    },
    start() {
      settlePending();
      if (o.checkMs <= 0) return;
      const tick = () => { void check().catch(() => {}); };
      timers.push(setTimeout(tick, Math.min(FIRST_CHECK_MS, o.checkMs)), setInterval(tick, o.checkMs));
      for (const t of timers) t.unref();
    },
    stop() {
      stopped = true;
      for (const t of timers.splice(0)) clearTimeout(t);
    },
  };
}
