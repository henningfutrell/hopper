// A client target for tests (design.md "Client targets"): the real hopper client, its tunnel the real
// relay (the forced command on the hopper's machine) run directly instead of through ssh — the ssh
// leg is ssh's (test/integration/client-tunnel-real.test.ts runs it against a real sshd).
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startClient, type Client, type ClientOptions } from '../../src/client/server.ts';
import { waitFor } from './wait.ts';

export const RELAY = fileURLToPath(new URL('../../src/client/relay.ts', import.meta.url));

const CLIENT_SRC = fileURLToPath(new URL('../../src/client', import.meta.url));

/** A throwaway install dir holding this checkout's client release (never src/client itself: a load writes there). */
export function testInstallDir(): string {
  const install = join(mkdtempSync(join(tmpdir(), 'jh-client-install-')), 'job-hopper-client');
  cpSync(CLIENT_SRC, install, { recursive: true, filter: (p) => !p.endsWith('relay.ts') });
  return install;
}

export async function startTestClient(socket: string, o: Omit<ClientOptions, 'tunnel' | 'installDir'> & { installDir?: string }): Promise<Client> {
  const client = startClient({ ...o, installDir: o.installDir ?? testInstallDir(), backoffMs: [50], tunnel: () => spawn(process.execPath, [RELAY, socket], { stdio: ['pipe', 'pipe', 'pipe'] }) });
  await waitFor(() => existsSync(socket), { timeoutMs: 5000, what: `the relay at ${socket}` });
  return client;
}
