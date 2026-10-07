// A client target for tests (design.md "Client targets", "Joining a machine"): the real hopper client,
// dialled in to a loopback TCP server that stands for the hopper's end — the newest connection is its
// link, as the hopper's links keep it. The upgrade and its signature are the hopper's own
// (test/integration/machine-join.test.ts runs them through the real daemon).
import { cpSync, mkdtempSync } from 'node:fs';
import { createServer, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { startClient, type Client, type ClientOptions } from '../../src/client/server.ts';
import type { ClientTransport } from '../../src/executors/client.ts';
import { waitFor } from './wait.ts';

const CLIENT_SRC = fileURLToPath(new URL('../../src/client', import.meta.url));

/** A throwaway install dir holding this checkout's client release (never src/client itself: a load writes there). */
export function testInstallDir(): string {
  const install = join(mkdtempSync(join(tmpdir(), 'jh-client-install-')), 'hopper-client');
  cpSync(CLIENT_SRC, install, { recursive: true });
  return install;
}

export interface TestClient {
  client: Client;
  /** The link the client dialled in on now. */
  link(): Duplex | undefined;
  /** The hopper's end of the client target, signing with `token`. */
  transport(token: string, machine?: string): ClientTransport;
  /** Stops the client and the stand-in hopper end. */
  stop(): Promise<void>;
}

export async function startTestClient(o: Omit<ClientOptions, 'dial' | 'installDir'> & { installDir?: string }): Promise<TestClient> {
  let link: Socket | undefined;
  const server = createServer((s) => { link?.destroy(); link = s; s.once('close', () => { if (link === s) link = undefined; }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const dial = (): Promise<Duplex> => new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1');
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  const client = startClient({ ...o, installDir: o.installDir ?? testInstallDir(), backoffMs: o.backoffMs ?? [50], dial });
  await waitFor(() => link, { timeoutMs: 5000, what: 'the client to dial in' });
  return {
    client,
    link: () => link,
    transport: (token, machine = 'studio') => ({ machine, link: () => link, token: () => token }),
    async stop() {
      await client.stop();
      link?.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}
