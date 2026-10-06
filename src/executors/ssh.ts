// The hopper's ssh connection to an ssh target (design.md "Target authentication", issue #59). The
// hopper proves itself with its own key and nothing else: public-key authentication only (never a
// password, keyboard-interactive, GSSAPI or host-based login), only the key the runtime mounts
// (never the user's agent or the user's other keys), and only to a target whose host key
// the plugins config pins (`hostKey`), checked strictly against a known_hosts file the hopper writes from
// those pins. Nothing is forwarded. The ssh config is read once, to resolve the destination (`ssh -G`
// on the user's config only); the connection itself reads none (`-F /dev/null`), so nothing in a
// config can add an identity, a jump host or a weaker option.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AttachedMachine } from '../domain/types.ts';
import { HARDENED_SSH_OPTIONS } from '../client/ssh-options.ts';
import { scrubbedEnv } from './env.ts';

/** ssh's exit status for its own failures (connection, authentication). */
export const SSH_FAILED = 255;

/** The runtime secret holding the hopper's ssh private key: a mounted file, `HOPPER_SSH_KEY_FILE`. */
export const SSH_KEY = 'HOPPER_SSH_KEY';

/** How the hopper proves itself, and which host keys it trusts. */
export interface SshAuth {
  /** The hopper's private key: a file only its owner can read. */
  identityFile: string;
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

/** The user's ssh config, or none: never /etc/ssh (under the unit those files look foreign-owned). */
export function userSshConfig(home = homedir()): string {
  const config = join(home, '.ssh', 'config');
  return existsSync(config) ? config : '/dev/null';
}

/** A target is a plain name: it is also the host key's name in known_hosts, and an argument to ssh. */
const TARGET = /^[A-Za-z0-9_][A-Za-z0-9._-]*(@[A-Za-z0-9_][A-Za-z0-9._-]*)?$/;

/** A pinned host key: `<type> <base64>`, as a host's `ssh_host_*_key.pub` holds it (comment dropped). */
export const HOST_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,2}$/;


/** Paths ssh reads from `-o` split at whitespace: refuse them rather than quote them. */
function plainPath(what: string, path: string): string {
  if (/\s/.test(path)) throw new Error(`${what} path must not contain whitespace: ${path}`);
  return path;
}

interface Destination { hostname: string; user: string; port: string }

const RESOLVE_TTL_MS = 60000;
const resolved = new Map<string, { at: number; value: Destination }>();

/** What the user's ssh config makes of the target. A jump host or a proxy command is refused. */
export function resolveDestination(bin: string, target: string): Destination {
  const key = `${bin}\0${target}`;
  const hit = resolved.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.value;
  const out = execFileSync(bin, ['-G', '-F', userSshConfig(), '--', target], { env: scrubbedEnv(), encoding: 'utf8', timeout: 10000 });
  const conf = new Map(out.split('\n').map((l) => { const i = l.indexOf(' '); return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()] as const; }));
  const jump = conf.get('proxyjump');
  if (jump && jump !== 'none') throw new Error(`ssh target ${target} goes through a ProxyJump; a target is reached directly`);
  const proxy = conf.get('proxycommand');
  if (proxy && proxy !== 'none') throw new Error(`ssh target ${target} uses a ProxyCommand; a target is reached directly`);
  const value = { hostname: conf.get('hostname') ?? '', user: conf.get('user') ?? '', port: conf.get('port') ?? '22' };
  if (!value.hostname || !value.user || !/^\d+$/.test(value.port)) throw new Error(`ssh target ${target}: ssh -G gave no hostname, user or port`);
  resolved.set(key, { at: Date.now(), value });
  return value;
}

/** ssh's argv running one remote shell command on the target, authenticated as above. Throws when it cannot be. */
export function sshArgv(t: SshTransport, command: string): string[] {
  if (!TARGET.test(t.target)) throw new Error(`bad ssh target: ${JSON.stringify(t.target)}`);
  const auth = t.auth();
  const d = resolveDestination(t.bin ?? 'ssh', t.target);
  const shared = t.controlDir
    ? ['-o', 'ControlMaster=auto', '-o', `ControlPath=${plainPath('ssh control', t.controlDir)}/%C`, '-o', 'ControlPersist=60']
    : [];
  return [
    '-F', '/dev/null', ...HARDENED_SSH_OPTIONS.flatMap((o) => ['-o', o]),
    '-i', auth.identityFile,
    '-o', `UserKnownHostsFile=${plainPath('known_hosts', auth.knownHostsFile)}`, '-o', `HostKeyAlias=${t.target}`,
    ...shared, '-p', d.port, '-l', d.user, '--', d.hostname, command,
  ];
}

/** Where the pinned host keys are written: `<dataDir>/ssh/known_hosts`. */
export const knownHostsFile = (dataDir: string): string => join(dataDir, 'ssh', 'known_hosts');

/**
 * The hopper's ssh key (a mounted file: ssh reads keys only from files) and the pinned host keys.
 * Throws when there is no key, it is given as a variable, or others can read it.
 */
export function hopperSshAuth(o: { env: (name: string) => string | undefined; dataDir: string }): SshAuth {
  const identityFile = o.env(`${SSH_KEY}_FILE`);
  if (!identityFile) {
    throw new Error(o.env(SSH_KEY)
      ? `${SSH_KEY} must be a mounted file (${SSH_KEY}_FILE): ssh reads a key only from a file`
      : `no ssh key for the hopper: set ${SSH_KEY}_FILE to its private key file (design.md "Target authentication")`);
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
