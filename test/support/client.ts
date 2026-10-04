// A client target for tests (design.md "Client targets"): the real hopper client, its tunnel the real
// relay (the forced command on the hopper's machine) run directly instead of through ssh — the ssh
// leg is ssh's (test/integration/client-tunnel-real.test.ts runs it against a real sshd).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startClient, type Client, type ClientOptions } from '../../src/client/server.ts';
import { waitFor } from './wait.ts';

export const RELAY = fileURLToPath(new URL('../../src/client/relay.ts', import.meta.url));

export async function startTestClient(socket: string, o: Omit<ClientOptions, 'tunnel'>): Promise<Client> {
  const client = startClient({ ...o, backoffMs: [50], tunnel: () => spawn(process.execPath, [RELAY, socket], { stdio: ['pipe', 'pipe', 'pipe'] }) });
  await waitFor(() => existsSync(socket), { timeoutMs: 5000, what: `the relay at ${socket}` });
  return client;
}
