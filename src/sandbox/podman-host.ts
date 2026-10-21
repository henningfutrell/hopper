// A Podman host's runtime (issue #2272, design.md "Podman hosts"): a Linux computer with rootless Podman that a person
// set up for sandboxes. Each call of the Podman adapter (podman.ts) goes down `ssh <host> podman system dial-stdio` in
// place of a local socket: the hopper reaches it as it reaches an ssh target ("Target authentication") — its own key,
// public-key authentication only, the host's pinned key only, written to a known_hosts file of its own, nothing
// forwarded —, and shares one connection per host (ControlMaster). The host's authorized_keys line forces the command
// (`AUTHORIZED_KEYS_OPTIONS`): the key runs dial-stdio and nothing else. A copy into a box and a command in it go over the
// same stream, so a box with vault secrets runs there: they go into its file system, never to a process of the hopper's
// on the host. A wait whose connection dropped finds the box again by its id and waits again; the box is never made
// twice (need-box.ts makes it once, by its name). The most CPU and memory a box gets there is the host's.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import type { PodmanHost } from '../domain/podman-hosts.ts';
import type { BuildingRuntime, ResourceLimits } from '../domain/sandboxes.ts';
import { scrubbedEnv } from '../executors/env.ts';
import { sshArgv, type SshAuth } from '../executors/ssh.ts';
import { createPodmanRuntime } from './podman.ts';
import { RuntimeRefusal, type RuntimeSocket } from './socket-http.ts';

/** The command each call runs on the host: its Podman API on stdin and stdout (Podman 4 and later). */
export const DIAL_STDIO = 'podman system dial-stdio';
/** The options of the hopper's key in the host's authorized_keys: it runs dial-stdio only, with no terminal and no forwarding. */
export const AUTHORIZED_KEYS_OPTIONS = `command="${DIAL_STDIO}",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding`;

export interface PodmanHostOptions {
  /** How the hopper proves itself (the user's own key, as to its ssh targets); its known_hosts is replaced by the host's own pin. */
  auth: () => SshAuth;
  /** Where the per-host known_hosts files and the shared connections' sockets live. */
  sshDir: string;
  sshBin?: string;
  /** How long a wait whose connection dropped waits before it looks for the box again. */
  retryMs?: number;
}

/** The most of ssh's stderr a failure keeps. */
const STDERR_MOST = 2000;
const RETRY_MS = 5000;

/** One ssh call as a stream: what is written goes to the remote command's stdin, its stdout is read back. */
function sshStream(bin: string, argv: string[], name: string): Duplex {
  const child = spawn(bin, argv, { env: scrubbedEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', got = false, closed = false, idleMs = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const stream = new Duplex({
    read() { child.stdout.resume(); },
    write(chunk: Buffer, _enc, done) { touch(); child.stdin.write(chunk, done); },
    final(done) { child.stdin.end(); done(); },
    destroy(e, done) { closed = true; clearTimeout(idle); child.kill('SIGTERM'); done(e); },
  });
  // node:http sets an idle limit on its socket: here it counts what passes either way, and never holds the process.
  const touch = (): void => {
    clearTimeout(idle);
    if (idleMs > 0 && !closed) idle = setTimeout(() => stream.emit('timeout'), idleMs).unref();
  };
  Object.assign(stream, {
    setTimeout(ms: number, cb?: () => void) { idleMs = ms; if (cb) stream.once('timeout', cb); touch(); return stream; },
    setNoDelay: () => stream, setKeepAlive: () => stream, ref: () => stream, unref: () => stream,
  });
  child.stdin.on('error', () => { /* the far end closed early: its exit says why */ });
  child.stdout.on('data', (d: Buffer) => { got = true; touch(); if (!stream.push(d)) child.stdout.pause(); });
  child.stderr.setEncoding('utf8').on('data', (c: string) => { if (stderr.length < STDERR_MOST) stderr += c; });
  child.on('error', (e) => stream.destroy(new Error(`ssh to ${name} did not start: ${e.message}`)));
  child.on('close', (code) => {
    closed = true;
    clearTimeout(idle);
    if (code !== 0 && !got) stream.destroy(new Error(`ssh to ${name} failed (exit ${code}): ${stderr.trim() || 'no reason given'}`));
    else stream.push(null);
  });
  return stream;
}

/** The host's API, one ssh stream per call; throws at a call when the host cannot be reached that way (no key, a bad destination). */
export function podmanHostSocket(host: PodmanHost, o: PodmanHostOptions): RuntimeSocket {
  const bin = o.sshBin ?? 'ssh';
  return {
    name: host.name,
    connect() {
      const dir = join(o.sshDir, 'podman');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const knownHostsFile = join(dir, `${host.name}.known_hosts`);
      writeFileSync(knownHostsFile, `${host.ssh} ${host.hostKey}\n`, { mode: 0o600 });
      return sshStream(bin, sshArgv({ target: host.ssh, bin, controlDir: o.sshDir, auth: () => ({ ...o.auth(), knownHostsFile }) }, DIAL_STDIO), host.name);
    },
  };
}

/** The box's limits, at most the host's. */
const capped = (l: ResourceLimits, host: PodmanHost): ResourceLimits => ({
  cpus: host.cpus !== undefined && (l.cpus <= 0 || l.cpus > host.cpus) ? host.cpus : l.cpus,
  memoryMb: host.memoryMb !== undefined && (l.memoryMb <= 0 || l.memoryMb > host.memoryMb) ? host.memoryMb : l.memoryMb,
});

export function createPodmanHostRuntime(host: PodmanHost, o: PodmanHostOptions): BuildingRuntime {
  const inner = createPodmanRuntime(podmanHostSocket(host, o));
  const retryMs = o.retryMs ?? RETRY_MS;
  return {
    ...inner,
    create: (spec) => inner.create({ ...spec, limits: capped(spec.limits, host) }),
    async wait(id, timeoutMs) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        try {
          return await inner.wait(id, Math.max(1000, until - Date.now()));
        } catch (e) {
          // Podman answered no, or the time is up: that is the wait's end. Else the connection dropped: the box runs on.
          if (e instanceof RuntimeRefusal || Date.now() >= until) throw e;
          await new Promise((r) => setTimeout(r, retryMs));
          const there = await inner.inspect(id).then((c) => c !== undefined, () => true);
          if (!there) throw new Error(`the box ${id} is no longer on ${host.name}`, { cause: e });
        }
      }
    },
  };
}
