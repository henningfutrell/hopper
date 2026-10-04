// A throwaway hopper ssh key and pinned known_hosts for tests: what `hopperSshAuth` returns in the
// daemon (design.md "Target authentication"). The key is not a real key; the ssh stand-ins never read it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SshAuth } from '../../src/executors/ssh.ts';

export const TEST_HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxWxd8NGtwDjmH0KQxSwU0m++PyQWok+VTcSyB7yJ3e';

export function testSshAuth(dir: string): () => SshAuth {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const identityFile = join(dir, 'hopper_ed25519');
  writeFileSync(identityFile, 'test key\n', { mode: 0o600 });
  const knownHostsFile = join(dir, 'known_hosts');
  writeFileSync(knownHostsFile, '', { mode: 0o600 });
  return () => ({ identityFile, knownHostsFile });
}
