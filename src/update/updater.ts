// The self-update loop (design.md "Self-update", issue #44): check the update repository for a
// newer target on the channel, and apply one without losing work — build it beside the running
// install, prove it loads, wait while a restart would lose a running job, swap it in, restart.
// Restart recovery (src/engine/recovery.ts) reattaches running jobs and re-drives open questions;
// each phase of an apply is kept in the apply record (`update/pending.json`), so the boot after settles an apply the
// process stopped in: `update.applied` when it runs the target, else `update.failed`, and no half-built install is left.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { Clock, InstanceEvents, InstanceSettingsRepository, ReleaseCheck, Restarter, UpdateBuilder, Updater } from '../domain/ports.ts';
import { CANARY_BRANCH } from '../domain/landing-canary.ts';
import { isUpdateChannel, type ClusterInstall, type InstallInfo, type UpdateApply, type UpdateSettings, type UpdateStatus, type UpdateTarget, type VersionHistory } from '../domain/types.ts';
import { createGitMirror, type GitMirror, notesAt } from './git.ts';
import { allBullets, newSince, readNotes, WHATS_NEW_DIR, WHATS_NEW_FILE } from './whats-new.ts';
import { nextDirOf, readInstallInfo, swapInstall } from './install.ts';

const exec = promisify(execFile);
const DEFAULTS: UpdateSettings = { channel: 'stable', autoUpdate: false, canary: false };

/** With no channel chosen: the branch the install came from when it is a channel (issue #282), else `stable` (issue #423). */
const defaults = (installed: InstallInfo | undefined): UpdateSettings =>
  installed && isUpdateChannel(installed.branch) ? { ...DEFAULTS, channel: installed.branch } : DEFAULTS;
const FIRST_CHECK_MS = 10_000;
/** How often to check when the interval given is not positive: checking cannot be turned off (issue #177). */
const DEFAULT_CHECK_MS = 60_000;
const LOAD_TIMEOUT_MS = 60_000;
/** How many of the installed version's What's new lines the Updates panel shows. */
const INSTALLED_WHATS_NEW = 5;
/** How many merge commits one `install.seen` names at most. */
const SEEN_MERGES = 500;

export interface UpdaterOptions {
  /** The install this process runs from (holds install.json and src/). */
  appDir: string;
  /** Holds update/: the repository mirror, the unpacked source, the apply record. */
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
  /** How often to check on its own; not positive: every minute, since a hopper that never checks never offers what was merged. */
  checkMs: number;
  /** How often to look again while waiting on restart blockers. */
  waitMs?: number;
  /** Whether a newer head may be updated to (issue #652): the merge of a pull request whose checks passed; else it is held. */
  release: ReleaseCheck;
  /** Default: a bare mirror under `<dataDir>/update/repo.git`. */
  mirror?: GitMirror;
  /** Set for a cluster install (issue #1285): the status says so, and the update notice gives helm upgrade, never compose. */
  cluster?: ClusterInstall | undefined;
}

interface Checked {
  state: 'unavailable' | 'current' | 'available' | 'held' | 'error';
  reason?: string;
  installed?: InstallInfo;
  target?: UpdateTarget;
  whatsNew: string[];
  /** Commits in the target and not installed: the log line and `update.available`, never the UI. */
  commits?: number;
  checkedAt?: string;
}

/**
 * The apply record (issue #1626), written as each phase starts and removed when the apply ends in this process. An
 * older build wrote it only just before the restart, with no `phase`: that one reads as `restarting`.
 */
type ApplyPhase = 'building' | 'waiting' | 'swapping' | 'restarting';
interface ApplyRecord { from: string; to: string; ref: string; phase?: ApplyPhase }

const short = (sha: string): string => sha.slice(0, 7);
const firstLine = (s: string | undefined): string => (s ?? '').trim().split('\n').find((l) => l.trim()) ?? '';
const messageOf = (e: unknown): string => {
  const err = e as { stderr?: string; message?: string };
  return firstLine(err.stderr) || firstLine(err.message) || String(e);
};

/** The newest bullets of the install's own What's new (install.sh and the image copy it); none without it. */
function installedWhatsNew(appDir: string): string[] {
  return allBullets(readNotes(appDir)).slice(0, INSTALLED_WHATS_NEW);
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
  const recordFile = join(updateDir, 'pending.json');
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
  /** The held target and reason last logged: logged once, not at each check. */
  let heldWarned: string | undefined;
  const timers: NodeJS.Timeout[] = [];

  const settings = (): UpdateSettings => {
    const read = readInstallInfo(o.appDir);
    const s = { ...defaults(read.ok ? read.info : undefined), ...o.settings.getUpdateSettings() };
    // An image is updated by its user, never by the hopper (issues #51, #494): a stored auto-update is off for it.
    return read.ok && read.info.kind === 'image' ? { ...s, autoUpdate: false } : s;
  };
  const isImage = (): boolean => {
    const read = readInstallInfo(o.appDir);
    return read.ok && read.info.kind === 'image';
  };
  const append = (type: 'update.available' | 'update.started' | 'update.applied' | 'update.failed', data: Record<string, unknown>): void => {
    if (!stopped) o.events.append({ type, data });
  };
  const lastAnnounced = (): unknown => o.events.recent(1, ['update.available'])[0]?.data.to;
  /** The commit `install.seen` last recorded, once it is recorded: no git read at each check. */
  let seenCommit: string | undefined;

  // The install does not change under a running process: read once.
  const installedNews = installedWhatsNew(o.appDir);

  function status(): UpdateStatus {
    const { commits: _commits, ...rest } = checked;
    const base = { ...settings(), ...rest, installedWhatsNew: installedNews, restartBlockers: o.restartBlockers(), ...(o.cluster ? { cluster: o.cluster } : {}) };
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
    const base = { installed: info, whatsNew: [], checkedAt: at };
    const { channel, canary } = settings();
    const head = await mirror.branchHead(channel);
    if (!head) return { ...base, state: 'error', reason: `branch ${channel} not found in ${info.repo}` };
    // In the canary subset (issue #1073 part 5): stable's candidate on `canary`, while it is ahead of stable.
    const candidate = channel === 'stable' && canary ? await mirror.branchHead(CANARY_BRANCH) : undefined;
    const early = candidate !== undefined && candidate !== head && (await mirror.contains(candidate, head));
    const target = early ? { commit: candidate, ref: CANARY_BRANCH } : { commit: head, ref: channel };
    // Installed from another channel's branch (or the canary's): that branch's head is the target even when the install
    // already contains it — a move to a more stable channel goes back to it (issue #282).
    const switching = (isUpdateChannel(info.branch) || info.branch === CANARY_BRANCH) && info.branch !== target.ref;
    if (target.commit === info.commit || (!switching && (await mirror.contains(info.commit, target.commit)))) return { ...base, state: 'current', target };
    // Only the merge of a pull request whose checks passed is offered (issue #652): nothing else is announced or applied.
    const verdict = await o.release.verify(info.repo, target.commit);
    if (!verdict.passed) return { ...base, state: 'held', target, reason: verdict.reason };
    const notes = async (commit: string) => allBullets(await notesAt(mirror, commit));
    const whatsNew = newSince(await notes(info.commit), await notes(target.commit));
    return { ...base, state: 'available', target: { ...target, pullRequest: verdict.pullRequest }, whatsNew, commits: await mirror.count(info.commit, target.commit) };
  }

  /**
   * The commit the install runs, recorded once (issue #2775 part 10): at the first check that sees it, an image's too, with
   * the merge commits it carries beyond the one recorded before, so a job's kept delivery track sees the install run its change.
   */
  async function seeInstall(info: InstallInfo): Promise<void> {
    if (seenCommit === info.commit) return;
    const last = o.events.recent(1, ['install.seen'])[0]?.data.commit;
    const from = typeof last === 'string' ? last : undefined;
    if (from !== info.commit && (await mirror.has(info.commit))) {
      const mergeCommits = await mirror.merges(info.commit, from, SEEN_MERGES);
      if (!stopped) o.events.append({ type: 'install.seen', data: { commit: info.commit, branch: info.branch, ...(from ? { from } : {}), mergeCommits } });
    }
    // With no user yet the event is kept nowhere: look again at the next check.
    if (o.events.recent(1, ['install.seen'])[0]?.data.commit === info.commit) seenCommit = info.commit;
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
    const { target, installed } = checked;
    if (checked.state === 'error') o.logger.warn(`hopper: update check failed: ${checked.reason}`);
    if (checked.state === 'held' && target && heldWarned !== `${target.commit} ${checked.reason}`) {
      heldWarned = `${target.commit} ${checked.reason}`;
      o.logger.warn(`hopper: update held: ${target.ref} ${short(target.commit)} is not offered: ${checked.reason}`);
    }
    applyError = undefined;
    if (checked.state === 'available' && target && installed) {
      if (lastAnnounced() !== target.commit) {
        append('update.available', { from: installed.commit, to: target.commit, ref: target.ref, changes: checked.commits ?? 0, ...(target.pullRequest ? { pullRequest: target.pullRequest.number } : {}) });
        o.logger.info(`hopper: update available: ${target.ref} ${short(target.commit)} (${checked.commits ?? 0} commit(s) not installed)`);
      }
      if (settings().autoUpdate) apply();
    }
    if (installed && checked.state !== 'error') await seeInstall(installed).catch((e: unknown) => o.logger.warn(`hopper: the install's commit was not recorded: ${messageOf(e)}`));
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

  const keep = (installed: InstallInfo, target: { commit: string; ref: string }, phase: ApplyPhase): void => {
    mkdirSync(updateDir, { recursive: true });
    writeFileSync(recordFile, JSON.stringify({ from: installed.commit, to: target.commit, ref: target.ref, phase } satisfies ApplyRecord));
  };

  async function run(installed: InstallInfo, target: { commit: string; ref: string }): Promise<void> {
    // The install now comes from the channel's branch.
    await build({ kind: 'install', repo: installed.repo, branch: target.ref, commit: target.commit, installedAt: now() });
    for (let waiting = false; ;) {
      // A stopped process swaps nothing: the next start settles the apply from its record.
      if (stopped) throw new Error('stopped while waiting to restart');
      const blockers = o.restartBlockers();
      if (blockers === 0) break;
      if (!waiting) keep(installed, target, 'waiting');
      waiting = true;
      applying = { ...applying!, phase: 'waiting', detail: `waiting for ${blockers} running job${blockers === 1 ? '' : 's'}: a restart would lose ${blockers === 1 ? 'it' : 'them'}` };
      await new Promise((r) => setTimeout(r, o.waitMs ?? 5000));
    }
    applying = { ...applying!, phase: 'restarting', detail: `restarting on ${target.ref} ${short(target.commit)}` };
    keep(installed, target, 'swapping');
    swapInstall(o.appDir);
    keep(installed, target, 'restarting');
    o.logger.info(`hopper: update ${short(installed.commit)} → ${short(target.commit)} in place; restarting`);
    await o.restart();
  }

  function apply(): ReturnType<Updater['apply']> {
    if (applying) return { ok: false, error: 'an update is already being applied' };
    const { installed, target } = checked;
    if (checked.state !== 'available' || !installed || !target) return { ok: false, error: 'no update available' };
    // An image is replaced by pulling or rebuilding it (issue #409): its files are not the hopper's to swap.
    if (installed.kind === 'image') return { ok: false, error: 'this hopper runs from a container image: pull or rebuild the image to update it (docs/deploy.md "Update")' };
    applying = { phase: 'building', detail: `building ${target.ref} ${short(target.commit)} beside the running install`, target: target.commit, startedAt: now() };
    applyError = undefined;
    keep(installed, target, 'building');
    append('update.started', { from: installed.commit, to: target.commit, ref: target.ref });
    o.logger.info(`hopper: applying update ${short(installed.commit)} → ${target.ref} ${short(target.commit)}`);
    run(installed, target).catch((e: unknown) => {
      applying = undefined;
      applyError = e instanceof Error ? e.message : String(e);
      o.logger.warn(`hopper: update to ${short(target.commit)} failed, install unchanged: ${applyError}`);
      // Stopped, the event log is closed: the record stays, and the next start records the failure.
      if (stopped) return;
      append('update.failed', { to: target.commit, error: applyError });
      rmSync(recordFile, { force: true });
    });
    return { ok: true, status: status() };
  }

  /** The start after an apply that did not end in its process: is this install the commit it swapped in? */
  function settleApply(): void {
    if (!existsSync(recordFile)) return;
    let record: ApplyRecord;
    try {
      record = JSON.parse(readFileSync(recordFile, 'utf8')) as ApplyRecord;
    } finally {
      rmSync(recordFile, { force: true });
      // A build the process stopped in, or one never swapped in: nothing runs from it.
      rmSync(nextDirOf(o.appDir), { recursive: true, force: true });
    }
    const read = readInstallInfo(o.appDir);
    if (read.ok && read.info.commit === record.to) {
      append('update.applied', { from: record.from, to: record.to, ref: record.ref });
      o.logger.info(`hopper: running the applied update ${record.ref} ${short(record.to)}`);
      return;
    }
    const on = read.ok ? short(read.info.commit) : 'an install without install.json';
    const phase = record.phase ?? 'restarting';
    const error = phase === 'building' ? `the hopper stopped while building ${short(record.to)}; install unchanged`
      : phase === 'waiting' ? `the hopper stopped while waiting to restart on ${short(record.to)}; install unchanged`
      : `the boot after the update runs ${on}, not ${short(record.to)}`;
    applyError = error;
    o.logger.warn(`hopper: update to ${short(record.to)} failed: ${error}`);
    append('update.failed', { to: record.to, error });
  }

  // A commit's history never changes: computed once per installed commit.
  let history: { commit: string; versions: VersionHistory['versions'] } | undefined;

  async function versionHistory(): Promise<VersionHistory> {
    const read = readInstallInfo(o.appDir);
    const build = read.known;
    if (!read.ok) return { versions: [], build, reason: read.reason };
    const { commit } = read.info;
    if (history?.commit === commit) return { versions: history.versions, build };
    if (!(await mirror.has(commit))) await check();
    if (!(await mirror.has(commit))) return { versions: [], build, reason: checked.reason ?? `the installed commit ${short(commit)} is not in ${read.info.repo}` };
    const versions = (await mirror.added(commit, [WHATS_NEW_FILE, WHATS_NEW_DIR])).map((v) => ({ commit: v.commit, at: v.at, changes: v.lines }));
    history = { commit, versions };
    return { versions, build };
  }

  return {
    status,
    check,
    apply,
    history: versionHistory,
    settings(patch) {
      const before = settings();
      // Auto-update does not apply to an image (issue #494): turning it on there is ignored, never stored.
      const { autoUpdate: _, ...rest } = patch;
      o.settings.setUpdateSettings(isImage() ? rest : patch);
      const after = settings();
      // A check already running may have read the old channel: check again once it is done.
      if (after.channel !== before.channel) void (checking ?? Promise.resolve()).catch(() => {}).then(() => check()).catch(() => {});
      else if (after.autoUpdate && !before.autoUpdate && checked.state === 'available') apply();
      return status();
    },
    start() {
      settleApply();
      let every = o.checkMs;
      if (every <= 0) {
        every = DEFAULT_CHECK_MS;
        o.logger.warn(`hopper: HOPPER_UPDATE_CHECK_MS=${o.checkMs} does not turn update checks off; checking every ${every / 1000} s`);
      }
      const tick = () => { void check().catch(() => {}); };
      timers.push(setTimeout(tick, Math.min(FIRST_CHECK_MS, every)), setInterval(tick, every));
      for (const t of timers) t.unref();
    },
    stop() {
      stopped = true;
      for (const t of timers.splice(0)) clearTimeout(t);
    },
  };
}
