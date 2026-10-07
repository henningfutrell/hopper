// The hopper's ssh connection to an ssh target (design.md "Target authentication", issue #59). The
// hopper proves itself with a key and nothing else: public-key authentication only (never a
// password, keyboard-interactive, GSSAPI or host-based login), only the key the runtime mounts — or,
// none mounted, the hopper's own key, kept in the database (issue #293, ssh-key.ts), then the key files
// ssh would use for that target (issue #260) — never the user's agent,
// and only to a target whose host key
// the plugins config pins (`hostKey`), checked strictly against a known_hosts file the hopper writes from
// those pins. Nothing is forwarded. The ssh config is read once, to resolve the destination (`ssh -G`
// on the user's config only); the connection itself reads none (`-F /dev/null`), so nothing in a
// config can add an identity, a jump host or a weaker option.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AttachedMachine } from '../domain/types.ts';
import { HARDENED_SSH_OPTIONS } from './ssh-options.ts';
import { scrubbedEnv } from './env.ts';
import { ownKeyFile } from './ssh-key.ts';

/** ssh's exit status for its own failures (connection, authentication). */
export const SSH_FAILED = 255;

/** The runtime secret holding the hopper's ssh private key: a mounted file, `HOPPER_SSH_KEY_FILE`. */
export const SSH_KEY = 'HOPPER_SSH_KEY';

/** How the hopper proves itself, and which host keys it trusts. */
export interface SshAuth {
  /**
   * The hopper's private key: a file only its owner can read. Absent (issue #260): the keys ssh itself
   * would use for the target — those `ssh -G` names that exist —, as the user does running `ssh <target>`.
   */
  identityFile?: string;
  /** The hopper's own key (issue #293), offered first when no key is mounted: it needs no ~/.ssh. */
  ownKey?: string;
  /** The pinned host keys, one line per ssh target (written by pinHostKeys). */
  knownHostsFile: string;
}

/** Reaching a target over ssh. */
export interface SshTransport {
  /** The ssh destination: a `~/.ssh/config` alias or `user@host`. Also the host key's name in known_hosts. */
  target: string;
  /** The ssh binary. Default `ssh`. */
  bin?: string;
  /** Where the shared connection's control socket lives. Absent → no connection sharing. */
  controlDir?: string;
  /** Asked at every connection, so a key the runtime rotates or mounts later is used. Throws when there is none. */
  auth: () => SshAuth;
}

/** POSIX single quoting: the remote login shell (sh, bash, zsh) reads it back as one word. */
export const shellQuote = (arg: string): string => `'${arg.replaceAll("'", "'\\''")}'`;

/**
 * How a command finds herdr on an ssh target (issue #311): by name, from the PATH its shell has, then
 * `~/.local/bin`, where herdr installs. Never a path the person names. The shell that runs an ssh command
 * is not a login shell, so `~/.local/bin` is often not on its PATH; and it is named here, not read
 * from a shell's env file, which a new pane's shell may be rewriting at that moment (seen live: `zsh:1:
 * command not found: herdr`).
 */
export const REMOTE_PATH = 'PATH="$PATH:$HOME/.local/bin"';

/** The user's ssh config, or none: never /etc/ssh (under the unit those files look foreign-owned). */
export function userSshConfig(home = homedir()): string {
  const config = join(home, '.ssh', 'config');
  return existsSync(config) ? config : '/dev/null';
}

/** A target is a plain name: it is also the host key's name in known_hosts, and an argument to ssh. */
const TARGET = /^[A-Za-z0-9_][A-Za-z0-9._-]*(@[A-Za-z0-9_][A-Za-z0-9._-]*)?$/;

/** Whether an ssh destination is a plain `[user@]host` name: one typed in the UI (issue #293) can carry no ssh option. */
export const isPlainTarget = (target: string): boolean => TARGET.test(target);

export { HOST_KEY } from '../domain/machines.ts';


/** Paths ssh reads from `-o` split at whitespace: refuse them rather than quote them. */
function plainPath(what: string, path: string): string {
  if (/\s/.test(path)) throw new Error(`${what} path must not contain whitespace: ${path}`);
  return path;
}

interface Destination { hostname: string; user: string; port: string; identityFiles: string[] }

const RESOLVE_TTL_MS = 60000;
const resolved = new Map<string, { at: number; value: Destination }>();

/** What the user's ssh config makes of the target. A jump host or a proxy command is refused. */
export function resolveDestination(bin: string, target: string): Destination {
  const key = `${bin}\0${target}`;
  const hit = resolved.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.value;
  const out = execFileSync(bin, ['-G', '-F', userSshConfig(), '--', target], { env: scrubbedEnv(), encoding: 'utf8', timeout: 10000 });
  const lines = out.split('\n').map((l) => { const i = l.indexOf(' '); return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()] as const; });
  const conf = new Map(lines);
  const jump = conf.get('proxyjump');
  if (jump && jump !== 'none') throw new Error(`ssh target ${target} goes through a ProxyJump; a target is reached directly`);
  const proxy = conf.get('proxycommand');
  if (proxy && proxy !== 'none') throw new Error(`ssh target ${target} uses a ProxyCommand; a target is reached directly`);
  const identityFiles = lines.filter(([k, v]) => k === 'identityfile' && v).map(([, v]) => (v.startsWith('~/') ? join(homedir(), v.slice(2)) : v));
  const value = { hostname: conf.get('hostname') ?? '', user: conf.get('user') ?? '', port: conf.get('port') ?? '22', identityFiles };
  if (!value.hostname || !value.user || !/^\d+$/.test(value.port)) throw new Error(`ssh target ${target}: ssh -G gave no hostname, user or port`);
  resolved.set(key, { at: Date.now(), value });
  return value;
}

/** The longest unix socket path (macOS's 104 bytes; Linux allows 108), and what ssh adds while it sets a master up. */
const SOCKET_PATH_MAX = 104;
const CONTROL_SUFFIX = '.0123456789abcdef'.length;

/**
 * The shared connection's socket for a destination: 16 hex of its hash in the control dir — ssh's own %C
 * is 40, too long for a socket under a signed-in user's data dir (issue #295). Undefined when even that
 * would not fit: then no connection is shared.
 */
function controlPath(controlDir: string, d: { user: string; hostname: string; port: string }): string | undefined {
  const path = `${plainPath('ssh control', controlDir)}/${createHash('sha256').update(`${d.user}@${d.hostname}:${d.port}`).digest('hex').slice(0, 16)}`;
  return Buffer.byteLength(path) + CONTROL_SUFFIX <= SOCKET_PATH_MAX ? path : undefined;
}

/** ssh's argv running one remote shell command on the target, authenticated as above. Throws when it cannot be. */
export function sshArgv(t: SshTransport, command: string): string[] {
  if (!TARGET.test(t.target)) throw new Error(`bad ssh target: ${JSON.stringify(t.target)}`);
  const auth = t.auth();
  const d = resolveDestination(t.bin ?? 'ssh', t.target);
  const keys = auth.identityFile ? [auth.identityFile]
    : [...(auth.ownKey ? [auth.ownKey] : []), ...d.identityFiles.filter((f) => f !== auth.ownKey && existsSync(f))];
  if (keys.length === 0) {
    throw new Error(`no ssh key on this machine to reach ${t.target}: create one with ssh-keygen, then add its public key to ${t.target}'s ~/.ssh/authorized_keys (ssh-copy-id ${t.target})`);
  }
  const control = t.controlDir ? controlPath(t.controlDir, d) : undefined;
  const shared = control ? ['-o', 'ControlMaster=auto', '-o', `ControlPath=${control}`, '-o', 'ControlPersist=60'] : [];
  return [
    '-F', '/dev/null', ...HARDENED_SSH_OPTIONS.flatMap((o) => ['-o', o]),
    ...keys.flatMap((k) => ['-i', plainPath('ssh key', k)]),
    '-o', `UserKnownHostsFile=${plainPath('known_hosts', auth.knownHostsFile)}`, '-o', `HostKeyAlias=${t.target}`,
    ...shared, '-p', d.port, '-l', d.user, '--', d.hostname, command,
  ];
}

/** Where the pinned host keys are written: `<dataDir>/ssh/known_hosts`. */
export const knownHostsFile = (dataDir: string): string => join(dataDir, 'ssh', 'known_hosts');

/**
 * The hopper's ssh key (a mounted file: ssh reads keys only from files) and the pinned host keys. No key
 * set: the hopper's own key once written to the data dir (issue #293, ensureOwnSshKey), then the keys ssh
 * would use for each target (issue #260, sshArgv). Throws when the key is given as a variable, or others
 * can read it.
 */
export function hopperSshAuth(o: { env: (name: string) => string | undefined; dataDir: string }): SshAuth {
  const identityFile = o.env(`${SSH_KEY}_FILE`);
  if (!identityFile) {
    if (o.env(SSH_KEY)) throw new Error(`${SSH_KEY} must be a mounted file (${SSH_KEY}_FILE): ssh reads a key only from a file`);
    const own = ownKeyFile(o.dataDir);
    return { ...(existsSync(own) ? { ownKey: plainPath('ssh key', own) } : {}), knownHostsFile: knownHostsFile(o.dataDir) };
  }
  let st;
  try {
    st = lstatSync(identityFile);
    readFileSync(identityFile);
  } catch (e) {
    throw new Error(`${SSH_KEY}_FILE: cannot read ${identityFile}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, { cause: e });
  }
  if (!st.isFile()) throw new Error(`${SSH_KEY}_FILE: ${identityFile} is not a file`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${SSH_KEY}_FILE: ${identityFile} is readable by others (mode ${(st.mode & 0o777).toString(8)}); make it 600`);
  return { identityFile: plainPath(`${SSH_KEY}_FILE`, identityFile), knownHostsFile: knownHostsFile(o.dataDir) };
}

/** known_hosts text from the attached machines' pins, and what could not be pinned. */
export function renderKnownHosts(machines: AttachedMachine[]): { text: string; problems: string[] } {
  const problems: string[] = [];
  const keys = new Map<string, Set<string>>();
  for (const m of machines) {
    if (!('ssh' in m)) continue;
    if (!m.hostKey) { problems.push(`attached machine ${m.name}: no hostKey pinned; the hopper will not connect to it`); continue; }
    keys.set(m.ssh, (keys.get(m.ssh) ?? new Set()).add(m.hostKey));
  }
  const lines: string[] = [];
  for (const [target, set] of keys) {
    if (set.size > 1) problems.push(`ssh target ${target}: attached machines pin different host keys; none is trusted`);
    else lines.push(`${target} ${[...set][0]!}\n`);
  }
  return { text: lines.join(''), problems };
}

/** Write the pins to `<dataDir>/ssh/known_hosts` (owner-only), only when they change. Returns the problems. */
export function pinHostKeys(dataDir: string, machines: AttachedMachine[]): string[] {
  const { text, problems } = renderKnownHosts(machines);
  const file = knownHostsFile(dataDir);
  mkdirSync(join(dataDir, 'ssh'), { recursive: true, mode: 0o700 });
  let now: string | undefined;
  try { now = readFileSync(file, 'utf8'); } catch { /* not written yet */ }
  if (now !== text) {
    writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  return problems;
}
