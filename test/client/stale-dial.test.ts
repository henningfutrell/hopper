// Issue #1154: a dial-in that waited behind a stall of the hopper's event loop is refused as stale — its signature is
// older than the window when the hopper reads it. The client then dials again at once, signed fresh, instead of waiting
// out its backoff; a second stale refusal in a row (a clock that is wrong, not a stall) backs off as before.
import { chmodSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { mintToken } from '../../src/client/signature.ts';
import { startClient, type Client } from '../../src/client/server.ts';
import { testInstallDir } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const STALE = new Error('http://hopper refused the link (401): {"error":"refused: stale. A removed machine is added again with Add machine"}');
const LATE = new Error('no answer from http://hopper within 15 s');

let client: Client | undefined;
afterEach(async () => { await client?.stop(); client = undefined; });

describe('a dial-in refused as stale (issue #1154)', () => {
  it('is dialled again at the first backoff, once; a second stale refusal in a row backs off', async () => {
    const answers = [LATE, LATE, STALE, STALE, LATE];
    const lines: string[] = [];
    const dial = (): Promise<Duplex> => Promise.reject(answers.shift() ?? LATE);
    client = startClient({ token: mintToken, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [20, 30, 60_000], dial, log: (l) => lines.push(l) });
    await waitFor(() => answers.length === 0 || undefined, { timeoutMs: 5000, what: 'five dials' });
    const waits = lines.filter((l) => l.includes('dialing again')).map((l) => Number(/in (\d+) ms/.exec(l)?.[1]));
    expect(waits.slice(0, 5)).toEqual([20, 30, 20, 30, 60_000]);
  });
});
