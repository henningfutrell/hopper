// The herdr the hopper owns on an ssh target, kept over ssh (issue #741, design.md "herdr client and server on an ssh
// target"). At each probe of an ssh target that runs herdr: the hopper's own herdr is copied to its versioned path
// there when missing (same platform only); `current` names it when the session server takes it, so every herdr call
// there runs it; else `current` is removed, the calls find herdr by name as before, and the session server is
// restarted from the hopper's herdr when decideHerdrSwitch allows it. Each line is logged once per machine.
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants, createReadStream } from 'node:fs';
import { delimiter, join } from 'node:path';
import { scrubbedEnv } from '../executors/env.ts';
import { shellQuote, sshArgv, type SshAuth } from '../executors/ssh.ts';
import { herdrMismatch, readHerdrStatus } from './herdr-version.ts';
import { probeHerdrOverSsh, type HerdrProbe } from './attached.ts';
import {
  OWNED_HERDR_DIR, decideHerdrSwitch, herdrVersionOf, ownedFactsCommand, ownedHerdrPath, ownedInstallCommand, ownedLinkCommand,
  ownedSwitchCommand, readOwnedFacts,
} from './herdr-owned.ts';

interface Logger { info(line: string): void; warn(line: string): void }

/** The hopper's own herdr: the one it copies to its targets. */
export interface HopperHerdr { path: string; version: string; platform: string }

/** What the keeper found and did on one target. */
export interface OwnedHerdr {
  /** The hopper's herdr version. Absent: the hopper has none. */
  version?: string;
  /** Every herdr call there runs the hopper's herdr. */
  inUse: boolean;
  /** Why it does not, or what waits. */
  note?: string;
  /** A herdr problem only a person can settle (the session server is a container's main process): no new job goes there. */
  problem?: string;
}

/** An ssh target running herdr, as the keeper reaches it. */
export interface OwnedTarget { target: string; session: string; controlDir: string; sshBin?: string; auth: () => SshAuth }

export type OwnedHerdrKeeper = (t: OwnedTarget, busy: () => boolean) => Promise<OwnedHerdr>;

/** The hopper's own herdr: `bin` on the daemon's PATH, its version and this machine's platform. */
export function hopperHerdr(bin = 'herdr', path = process.env.PATH): HopperHerdr | { problem: string } {
  const ok = (p: string): boolean => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };
  const found = bin.includes('/') ? (ok(bin) ? bin : undefined) : (path ?? '').split(delimiter).filter(Boolean).map((d) => join(d, bin)).find(ok);
  if (!found) return { problem: `the hopper has no herdr of its own to install: ${bin} is not on its PATH` };
  try {
    const version = herdrVersionOf(execFileSync(found, ['--version'], { env: scrubbedEnv(), encoding: 'utf8', timeout: 10000 }));
    if (!version) return { problem: `the hopper's herdr (${found}) does not say its version` };
    return { path: found, version, platform: execFileSync('uname', ['-sm'], { encoding: 'utf8', timeout: 10000 }).trim() };
  } catch (e) {
    return { problem: `the hopper's herdr (${found}) does not say its version: ${(e as Error).message}` };
  }
}

/** One command over the target's ssh connection; `input` is a file sent to its stdin. Resolves stdout. */
function run(t: OwnedTarget, command: string, timeoutMs: number, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let argv: string[];
    try {
      argv = sshArgv({ target: t.target, controlDir: t.controlDir, auth: t.auth, ...(t.sshBin ? { bin: t.sshBin } : {}) }, command);
    } catch (e) {
      return reject(e instanceof Error ? e : new Error(String(e)));
    }
    const child = spawn(t.sshBin ?? 'ssh', argv, { env: scrubbedEnv(), stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout!.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
    child.stderr!.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
    if (input && child.stdin) createReadStream(input).on('error', (e) => child.stdin!.destroy(e)).pipe(child.stdin).on('error', () => {});
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      reject(new Error(signal === 'SIGKILL' ? `no answer within ${timeoutMs} ms` : stderr.trim() || `exit ${code}`));
    });
  });
}

const FACTS_MS = 20000;
const INSTALL_MS = 180000;
const SWITCH_MS = 60000;

/** `herdr`: the hopper's own herdr; default: as cachedHopperHerdr reads it. */
export function createOwnedHerdrKeeper(o: { herdr?: () => HopperHerdr | { problem: string }; logger: Logger }): OwnedHerdrKeeper {
  const ours = o.herdr ?? cachedHopperHerdr();
  const said = new Map<string, string>();
  const say = (t: OwnedTarget, line: string, warn = false): void => {
    const key = `${t.target}\0${t.session}`;
    if (said.get(key) === line) return;
    said.set(key, line);
    if (warn) o.logger.warn(line);
    else o.logger.info(line);
  };
  // Switches tried by this hopper, beside the mark on the machine: one that could not be written still counts.
  const tried = new Set<string>();

  async function keep(t: OwnedTarget, busy: () => boolean, h: HopperHerdr): Promise<OwnedHerdr> {
    const v = h.version;
    const facts = readOwnedFacts(await run(t, ownedFactsCommand(v, t.session), FACTS_MS));
    if (facts.platform !== h.platform) {
      await run(t, ownedLinkCommand(undefined), FACTS_MS);
      return { version: v, inUse: false, note: `herdr is not installed at the hopper's path: the machine is ${facts.platform || 'of a platform it does not say'}, the hopper's herdr is for ${h.platform}; herdr is found in ~/.local/bin, then its PATH` };
    }
    if (!facts.installed) {
      try {
        const out = await run(t, ownedInstallCommand(v), INSTALL_MS, h.path);
        if (herdrVersionOf(out.trim().split('\n').at(-1) ?? '') !== v) throw new Error(`it says ${JSON.stringify(out.trim())}`);
      } catch (e) {
        await run(t, ownedLinkCommand(undefined), FACTS_MS).catch(() => undefined);
        return { version: v, inUse: false, note: `the hopper's herdr ${v} could not be installed at ~/${ownedHerdrPath(v)}: ${(e as Error).message}` };
      }
      say(t, `hopper: ssh ${t.target}: installed the hopper's herdr ${v} at ~/${ownedHerdrPath(v)}`);
    }
    // The session server, as the hopper's herdr sees it.
    let server: ReturnType<typeof readHerdrStatus> | undefined;
    try {
      server = readHerdrStatus(await run(t, `"$HOME"/${ownedHerdrPath(v)} --session ${shellQuote(t.session)} status server`, FACTS_MS));
    } catch (e) {
      if (!herdrMismatch((e as Error).message)) throw e;
    }
    if (server && (!server.running || !server.herdrProblem)) {
      await run(t, ownedLinkCommand(v), FACTS_MS);
      return { version: v, inUse: true };
    }
    await run(t, ownedLinkCommand(undefined), FACTS_MS);
    const key = `${t.target}\0${t.session}\0${v}`;
    const decision = decideHerdrSwitch({ version: v, busy: busy(), container: facts.container, tried: facts.tried || tried.has(key), ...(facts.panes !== undefined ? { panes: facts.panes } : {}), ...(facts.server ? { server: facts.server } : {}) });
    if (!decision.switch) return { version: v, inUse: false, ...(decision.hold ? { problem: decision.why } : { note: decision.why }) };
    tried.add(key);
    const out = await run(t, ownedSwitchCommand(v, t.session), SWITCH_MS);
    if (out.includes('hopper-herdr-switched')) {
      say(t, `hopper: ssh ${t.target}: its herdr session server now runs the hopper's herdr ${v} (it ran ${server?.versions.server?.version ?? 'another'})`);
      return { version: v, inUse: true };
    }
    const panes = /hopper-herdr-panes (\d+)/.exec(out);
    if (panes || out.includes('hopper-herdr-panes-unknown')) {
      // Nothing was stopped: a pane opened since the decision. Tried again at a later probe.
      tried.delete(key);
      const n = Number(panes?.[1]);
      const d = decideHerdrSwitch({ version: v, busy: false, container: false, tried: false, ...(panes ? { panes: n } : {}) });
      return { version: v, inUse: false, ...(!d.switch ? { note: d.why } : {}) };
    }
    const why = out.includes('hopper-herdr-stop-failed') ? 'its session server did not stop' : 'its session server did not start again from it';
    say(t, `hopper: ssh ${t.target}: moving its herdr session server to the hopper's herdr ${v} failed: ${why}`, true);
    return { version: v, inUse: false, note: `moving its session server to herdr ${v} failed: ${why}; restart it there with ~/${OWNED_HERDR_DIR}/current/herdr` };
  }

  return async (t, busy) => {
    const h = ours();
    if ('problem' in h) return { inUse: false, note: h.problem };
    try {
      return await keep(t, busy, h);
    } catch (e) {
      return { version: h.version, inUse: false, note: `the hopper's herdr could not be checked there: ${(e as Error).message}` };
    }
  };
}

/**
 * The probe's herdr with what the keeper found: the owned herdr beside the versions, and a herdr problem when the keeper
 * holds the machine, or when the probe found one (then the keeper's note says what waits).
 */
export function withOwnedHerdr(owned: OwnedHerdr, p: HerdrProbe): HerdrProbe {
  const herdr = { ...p.herdr, owned: { ...(owned.version ? { version: owned.version } : {}), inUse: owned.inUse, ...(owned.note ? { note: owned.note } : {}) } };
  const problem = [p.herdrProblem, owned.problem ?? (p.herdrProblem ? owned.note : undefined)].filter((x) => x !== undefined).join('; ');
  return { ...p, herdr, ...(problem ? { herdrProblem: problem } : {}) };
}

/** The hopper's own herdr, read again every 5 minutes: an update of the hopper brings another. */
export function cachedHopperHerdr(read = (): ReturnType<typeof hopperHerdr> => hopperHerdr(), everyMs = 300000): () => ReturnType<typeof hopperHerdr> {
  let last: { at: number; herdr: ReturnType<typeof hopperHerdr> } | undefined;
  return () => (last && Date.now() - last.at < everyMs ? last : (last = { at: Date.now(), herdr: read() })).herdr;
}

/** An ssh target's herdr: the keeper first, then the probe (probeHerdrOverSsh) through the herdr it left linked. */
export async function probeOwnedHerdr(keep: OwnedHerdrKeeper, t: OwnedTarget, busy: () => boolean): Promise<HerdrProbe> {
  const owned = await keep(t, busy);
  return withOwnedHerdr(owned, await probeHerdrOverSsh({ target: t.target, session: t.session, controlDir: t.controlDir, auth: t.auth, ...(t.sshBin ? { sshBin: t.sshBin } : {}) }));
}
