// The herdr the hopper owns on an ssh target (issue #741, design.md "herdr client and server on an ssh target"): the
// hopper's own herdr, copied to `~/.local/share/hopper/herdr/<version>/herdr` there. Every herdr call there runs
// `~/.local/share/hopper/herdr/current/herdr` when the `current` link is there (REMOTE_HERDR), and the session server
// starts from it. When the server runs another protocol, the hopper restarts it from that path, but only when nothing
// there can be lost, never when the server is a container's main process, and once per version. Pure: the commands
// to run there, what they print, and the decision.
import { shellQuote } from '../executors/ssh.ts';

/** Where the hopper's herdr lives on a target, under its home. */
export const OWNED_HERDR_DIR = '.local/share/hopper/herdr';

/** The herdr of one version there, under its home. */
export const ownedHerdrPath = (version: string): string => `${OWNED_HERDR_DIR}/${version}/herdr`;

/** A herdr version that can be a path segment: digits, letters, dots, dashes, plus. */
const VERSION = /^[0-9][0-9A-Za-z.+-]*$/;

/** The version `herdr --version` prints (`herdr 0.9.3`), or undefined when it is not one. */
export function herdrVersionOf(text: string): string | undefined {
  const m = /^herdr\s+(\S+)\s*$/.exec(text.trim());
  return m && VERSION.test(m[1]!) && !m[1]!.includes('..') ? m[1] : undefined;
}

/** What the hopper reads on a target before it decides: its platform, the install, an earlier switch, the server. */
export interface OwnedFacts {
  /** `uname -sm` there. */
  platform: string;
  /** The hopper's herdr of this version is there, executable. */
  installed: boolean;
  /** The session server was moved to this version once already. */
  tried: boolean;
  /** The target is a container (podman's /run/.containerenv, docker's /.dockerenv). */
  container: boolean;
  /** Panes open in its herdr session; absent when no herdr there could list them. */
  panes?: number;
  /** The session server's process and its parent; absent when not found. */
  server?: { pid: number; ppid: number };
}

const HOME_DIR = `"$HOME"/${OWNED_HERDR_DIR}`;
/** The herdr the target finds by name, as before the hopper owned one: `~/.local/bin`, then its PATH (issue #311). */
const LOOKUP = 'PATH="$HOME/.local/bin:$PATH" herdr';

/** Panes in the session, by whichever herdr there can list them: `hopper-herdr-panes <n>`, or nothing. */
const panesCommand = (owned: string, s: string): string =>
  `if out=$(${owned} --session ${s} pane list 2>/dev/null) || out=$(${LOOKUP} --session ${s} pane list 2>/dev/null); then`
  + ` echo "hopper-herdr-panes $(printf '%s' "$out" | grep -o '"pane_id"' | wc -l | tr -d ' ')"; fi`;

/** The command that prints the facts (readOwnedFacts) for the hopper's herdr of `version` and the session `session`. */
export function ownedFactsCommand(version: string, session: string): string {
  const d = `${HOME_DIR}/${shellQuote(version)}`;
  const s = shellQuote(session);
  return [
    `echo "hopper-herdr-platform $(uname -sm)"`,
    `[ -x ${d}/herdr ] && echo hopper-herdr-installed`,
    `[ -e ${d}/switch-tried ] && echo hopper-herdr-tried`,
    '{ [ -e /run/.containerenv ] || [ -e /.dockerenv ]; } && echo hopper-herdr-container',
    panesCommand(`${d}/herdr`, s),
    // The server: a process whose program is herdr and whose arguments are `--session <s> server`.
    `for p in /proc/[0-9]*; do c=$( { tr '\\0' ' ' < "$p/cmdline"; } 2>/dev/null) || continue; case "$c" in *' --session '${s}' server ') ;; *) continue ;; esac;`
    + ` case "\${c%% *}" in *herdr) echo "hopper-herdr-server \${p#/proc/} $(awk '{ print $4 }' "$p/stat" 2>/dev/null)"; break ;; esac; done`,
    'true',
  ].join('; ');
}

/** The facts ownedFactsCommand printed. */
export function readOwnedFacts(stdout: string): OwnedFacts {
  const lines = stdout.split('\n').map((l) => l.trim());
  const value = (key: string): string | undefined => lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1);
  const panes = Number(value('hopper-herdr-panes'));
  const [pid, ppid] = (value('hopper-herdr-server') ?? '').split(' ').map(Number);
  return {
    platform: value('hopper-herdr-platform') ?? '',
    installed: lines.includes('hopper-herdr-installed'),
    tried: lines.includes('hopper-herdr-tried'),
    container: lines.includes('hopper-herdr-container'),
    ...(value('hopper-herdr-panes') !== undefined && Number.isInteger(panes) ? { panes } : {}),
    ...(Number.isInteger(pid) && Number.isInteger(ppid) && pid! > 0 ? { server: { pid: pid!, ppid: ppid! } } : {}),
  };
}

/** The command that writes the hopper's herdr, read from stdin, to its versioned path there, then says its version. */
export function ownedInstallCommand(version: string): string {
  const d = `${HOME_DIR}/${shellQuote(version)}`;
  return `mkdir -p ${d} && cat > ${d}/herdr.part && chmod 755 ${d}/herdr.part && mv -f ${d}/herdr.part ${d}/herdr && ${d}/herdr --version`;
}

/** Every herdr call there runs this version (`current` names it), or, with none, the herdr it finds by name. */
export const ownedLinkCommand = (version: string | undefined): string =>
  version === undefined ? `rm -f ${HOME_DIR}/current` : `ln -sfn ${shellQuote(version)} ${HOME_DIR}/current`;

/** The session `scripts/attach-machine.sh` installs `systemd/hopper-herdr.service` for. */
const UNIT_SESSION = 'hopper';

/**
 * The command that moves the session server to the hopper's herdr: the panes counted again (none, or it stops), the
 * attempt recorded, the server stopped, `current` linked, the server started from it (by its unit when the unit starts
 * it from `current`, else as a process of its own), then waited for. It prints `hopper-herdr-switched`, or why not.
 */
export function ownedSwitchCommand(version: string, session: string): string {
  const d = `${HOME_DIR}/${shellQuote(version)}`;
  const o = `${d}/herdr`;
  const s = shellQuote(session);
  const running = (bin: string): string => `${bin} --session ${s} status server 2>/dev/null | grep -q '^status: running$'`;
  const unit = '"$HOME"/.config/systemd/user/hopper-herdr.service';
  const start = `setsid ${o} --session ${s} server </dev/null >/dev/null 2>&1 &`;
  const detached = `if command -v setsid >/dev/null 2>&1; then ${start} else nohup ${o} --session ${s} server </dev/null >/dev/null 2>&1 & fi`;
  return [
    // Panes counted here again: a job may have started since the decision.
    `out=$(${panesCommand(o, s)})`,
    `case "$out" in 'hopper-herdr-panes 0') ;; '') echo hopper-herdr-panes-unknown; exit 0 ;; *) echo "$out"; exit 0 ;; esac`,
    `touch ${d}/switch-tried`,
    `${o} --session ${s} server stop >/dev/null 2>&1 || ${LOOKUP} --session ${s} server stop >/dev/null 2>&1`,
    `i=0; while ${running(o)} || ${running(LOOKUP)}; do i=$((i+1)); [ $i -ge 10 ] && { echo hopper-herdr-stop-failed; exit 0; }; sleep 1; done`,
    ownedLinkCommand(version),
    session === UNIT_SESSION
      ? `if [ -f ${unit} ] && grep -q ${shellQuote(`${OWNED_HERDR_DIR}/current`)} ${unit}; then systemctl --user restart hopper-herdr.service >/dev/null 2>&1; else ${detached}; fi`
      : detached,
    `i=0; until ${running(o)}; do i=$((i+1)); [ $i -ge 10 ] && { echo hopper-herdr-start-failed; exit 0; }; sleep 1; done`,
    'echo hopper-herdr-switched',
  ].join('; ');
}

/** What the decision weighs. */
export interface SwitchFacts {
  /** The hopper's herdr version. */
  version: string;
  /** A job of the hopper runs on the machine. */
  busy: boolean;
  panes?: number;
  container: boolean;
  server?: { pid: number; ppid: number };
  tried: boolean;
}

/** No switch, and why; `hold` when the machine must take no new job until a person acts (the herdr problem). */
export type SwitchDecision = { switch: true } | { switch: false; why: string; hold?: true };

/**
 * Whether the hopper restarts the session server from its own herdr, whose protocol the running server does not
 * take. Never twice for one version (an image that starts its own herdr again would make it a loop); never when the
 * server is a container's main process (PID 1, or its parent is), since stopping it stops the container; only with no
 * job running and no pane open, since a restart closes every pane.
 */
export function decideHerdrSwitch(f: SwitchFacts): SwitchDecision {
  if (f.tried) return { switch: false, why: `its session server was moved to herdr ${f.version} once and does not run it: restart it there with ~/${ownedHerdrPath(f.version)}` };
  if (f.container && !f.server) return { switch: false, why: 'its herdr session server process was not found, so whether it is the container\'s main process is not known: its session server stays as it is' };
  if (f.container && f.server && (f.server.pid === 1 || f.server.ppid === 1)) {
    return { switch: false, why: `its herdr session server is the container's main process: update the herdr its image puts in place to ${f.version}`, hold: true };
  }
  if (f.busy) return { switch: false, why: `a job runs there: its session server moves to herdr ${f.version} once none does` };
  if (f.panes === undefined) return { switch: false, why: 'its herdr session\'s panes could not be counted: its session server stays as it is' };
  if (f.panes > 0) return { switch: false, why: `${f.panes} ${f.panes === 1 ? 'pane is' : 'panes are'} open in its herdr session: its session server moves to herdr ${f.version} once none is` };
  return { switch: true };
}
