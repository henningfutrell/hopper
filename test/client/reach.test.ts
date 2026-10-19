// Issue #695: before a job starts, the hopper checks from the job's machine that the machine reaches the hopper at the
// URL the job is given — through the machine's own connection: this machine's shell, ssh, or a client target's
// `POST /reach`. The check is curl, which the job's tools use too. A machine that cannot reach it is said plainly.
import { chmodSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { mintToken } from '../../src/client/signature.ts';
import { readReach } from '../../src/client/reach.ts';
import { clientShell, localShell } from '../../src/executors/machine-shell.ts';
import { startTestClient, type TestClient } from '../support/client.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);

const servers: Server[] = [];
let client: TestClient | undefined;
afterEach(async () => {
  await client?.stop();
  client = undefined;
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

/** A stand-in hopper answering every request with `status`. */
async function answering(status: number): Promise<string> {
  const server = createServer((_req, res) => { res.writeHead(status); res.end(); });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('the reach check (issue #695)', () => {
  it('from this machine: a hopper that answers is reached, even refusing a request without a token', async () => {
    expect(await localShell().reach(await answering(401))).toBeUndefined();
    expect(await localShell().reach(await answering(404))).toBeUndefined();
  });

  it('from this machine: a name it cannot resolve is said plainly, with the URL', async () => {
    const problem = await localShell().reach('http://hopper.invalid:4790');
    expect(problem).toContain('this machine cannot reach the hopper at http://hopper.invalid:4790');
    // curl says "Could not resolve host", or "Resolving timed out" when a slow resolver passes its connect timeout.
    expect(problem).toMatch(/resolv/i);
  });

  it('from this machine: a hopper that refuses the name (421), or a proxy whose hopper does not answer (502), is not reached', async () => {
    const refused = await answering(421);
    expect(await localShell().reach(refused)).toContain(`this machine cannot reach the hopper at ${refused}: it refused the address (421)`);
    const proxy = await answering(502);
    expect(await localShell().reach(proxy)).toContain(`this machine cannot reach the hopper at ${proxy}: it answered 502`);
  });

  it('from a client target: the same check, run by its client', async () => {
    client = await startTestClient({ token: () => TOKEN, herdrBin: HERDR, session: 'hopper' });
    const shell = clientShell(client.transport(TOKEN));
    expect(await shell.reach(await answering(401))).toBeUndefined();
    expect(await shell.reach('http://hopper.invalid:4790')).toContain('this machine cannot reach the hopper at http://hopper.invalid:4790');
  });

  it('reads what the check printed: curl missing says so', () => {
    expect(readReach({ code: 127, stdout: '', stderr: 'sh: curl: not found' }, 'http://h:1')).toBe('this machine cannot reach the hopper at http://h:1: curl is not on this machine (the job\'s tools need it)');
    expect(readReach({ code: 0, stdout: 'hopper-reach 401\n', stderr: '' }, 'http://h:1')).toBeUndefined();
  });
});

const TOKEN = mintToken();
