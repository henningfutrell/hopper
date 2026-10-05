// The hopper client's tunnel (design.md "Client targets", issue #59): ssh from this machine to the
// hopper's, authenticated as every ssh connection of hopper is (ssh-options.ts) — this client's
// own key only, the hopper's pinned host key only, no password, nothing forwarded. No command is
// asked for: the key's forced command there is relay.ts, so the session's stdin and stdout are the
// tunnel. No pty (`-T`), so the stream is binary-clean.
import { spawn, type ChildProcess } from 'node:child_process';
import { HARDENED_SSH_OPTIONS } from './ssh-options.ts';

export interface TunnelOptions {
  /** The hopper's machine as this one reaches it: `user@host`. */
  hopper: string;
  port: number;
  /** This client's private key (a file only this user may read). */
  keyFile: string;
  /** known_hosts holding the hopper's pinned host key, under the name `hopper`. */
  knownHostsFile: string;
  sshBin?: string;
}

export function tunnelArgv(o: TunnelOptions): string[] {
  const at = o.hopper.lastIndexOf('@');
  const [user, host] = at > 0 ? [o.hopper.slice(0, at), o.hopper.slice(at + 1)] : ['', ''];
  if (!user || !host || /[\s,]/.test(o.hopper) || o.hopper.startsWith('-')) throw new Error(`the hopper must be user@host: ${JSON.stringify(o.hopper)}`);
  if (/\s/.test(o.keyFile + o.knownHostsFile)) throw new Error('key and known_hosts paths must not contain whitespace');
  return [
    '-F', '/dev/null', '-T', ...HARDENED_SSH_OPTIONS.flatMap((x) => ['-o', x]),
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-i', o.keyFile, '-o', `UserKnownHostsFile=${o.knownHostsFile}`, '-o', 'HostKeyAlias=hopper',
    '-p', String(o.port), '-l', user, '--', host,
  ];
}

export const dialHopper = (o: TunnelOptions) => (): ChildProcess =>
  spawn(o.sshBin ?? 'ssh', tunnelArgv(o), { stdio: ['pipe', 'pipe', 'pipe'] });
