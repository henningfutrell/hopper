// The hopper client's tunnel (issue #59, design.md "Client targets"): ssh to the hopper's machine with
// this client's own key only, to the hopper's pinned host key only, no password, nothing forwarded, no
// pty; the stream is the relay's from its marker on, whatever the login shell there prints first.
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HARDENED_SSH_OPTIONS } from '../../src/client/ssh-options.ts';
import { startClient, type Client } from '../../src/client/server.ts';
import { mintToken } from '../../src/client/signature.ts';
import { tunnelArgv } from '../../src/client/tunnel.ts';
import { clientSocket } from '../../src/executors/client.ts';
import { createHerdrCliClient } from '../../src/executors/herdr/index.ts';
import { RELAY, testInstallDir } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);

describe('the client\'s tunnel', () => {
  const argv = tunnelArgv({ hopper: 'hop@hopper.lan', port: 2222, keyFile: '/k/id', knownHostsFile: '/k/known_hosts' });
  const opts = argv.flatMap((a, i) => (argv[i - 1] === '-o' ? [a] : []));

  it('ssh with no config, no pty, no command (the key\'s forced command is the relay)', () => {
    expect(argv.slice(0, 3)).toEqual(['-F', '/dev/null', '-T']);
    expect(argv.slice(-6)).toEqual(['-p', '2222', '-l', 'hop', '--', 'hopper.lan']);
  });

  it('every hardened option of hopper\'s ssh: key only, pinned host key only, nothing forwarded', () => {
    expect(opts).toEqual(expect.arrayContaining([...HARDENED_SSH_OPTIONS, 'UserKnownHostsFile=/k/known_hosts', 'HostKeyAlias=hopper']));
    expect(argv[argv.indexOf('-i') + 1]).toBe('/k/id');
  });

  it('refuses a hopper that is not user@host', () => {
    for (const bad of ['hopper.lan', '-oProxyCommand=x@h', 'a b@c', '@host', 'user@']) {
      expect(() => tunnelArgv({ hopper: bad, port: 22, keyFile: '/k', knownHostsFile: '/h' })).toThrow(/user@host/);
    }
  });
});

describe('the client over a tunnel whose login shell talks first', () => {
  let dir: string;
  let client: Client | undefined;
  afterEach(async () => { await client?.stop(); rmSync(dir, { recursive: true, force: true }); });

  it('skips what the shell printed before the relay\'s marker', async () => {
    dir = mkdtempSync('/tmp/jh-tn-');
    process.env.FAKE_HERDR_DIR = dir;
    process.env.FAKE_HERDR_RUNNING = '1';
    const sock = clientSocket(dir, 'studio');
    const noisy = join(dir, 'noisy.sh');
    writeFileSync(noisy, `#!/bin/sh\necho "Welcome, last login: yesterday"\nprintf 'motd\\r\\n'\nexec "${process.execPath}" "${RELAY}" "${sock}"\n`, { mode: 0o700 });
    const token = mintToken();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'clients'), { mode: 0o700 });
    client = startClient({ token: () => token, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [50], tunnel: () => spawn(noisy, [], { stdio: ['pipe', 'pipe', 'pipe'] }) });
    const hopper = createHerdrCliClient({ client: { machine: 'studio', socket: sock, token: () => token } });
    const out = await waitFor(async () => hopper.exec(['status', 'server']).catch(() => undefined), { timeoutMs: 5000, what: 'the client' });
    expect(out).toMatch(/status: running/);
  });

  it('a client whose herdr session is `default` or unnamed is refused at start', () => {
    dir = mkdtempSync('/tmp/jh-tn-');
    for (const session of ['default', '']) {
      expect(() => startClient({ token: mintToken, herdrBin: HERDR, session, installDir: testInstallDir(), tunnel: () => spawn('true') })).toThrow(/never `default`/);
    }
  });
});
