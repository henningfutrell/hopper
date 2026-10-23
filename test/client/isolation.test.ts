// Issue #752 (Path 3, the box-side time limit): a client target cut off from the hopper longer than its max isolation
// stops the jobs the hopper last said run there, so a box out of reach does not go on with authority the hopper can no
// longer check. Once its link is back, the hopper's next probe hears which jobs it stopped, and logs it.
//
// Feature: the isolation stop
//   Scenario: a hopper that answers keeps the jobs running
//     Given a client target whose hopper said job A runs there, with a max isolation of 400 ms
//     And the hopper makes no call, but its end of the link answers the client's keepalive PINGs
//     When 1 s goes by
//     Then job A's process still runs
//   Scenario: a client cut off longer than its max isolation stops the jobs the hopper named, and no other
//     Given a client target whose hopper said job A runs there, and job B's process the hopper did not name
//     When the client is cut off from the hopper for longer than its max isolation
//     Then job A's process is stopped, and job B's still runs
//     When the link is back and the hopper probes the client
//     Then a probe hears that job A was stopped, after how long out of reach, and the hopper logs it
//     And the next probe hears no stop again
//   Scenario: a max isolation of 0 turns the stop off
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRelease } from '../../src/client/release.ts';
import { mintToken } from '../../src/client/signature.ts';
import { clientRunningRelease } from '../../src/executors/client.ts';
import { createClientReleaseKeeper } from '../../src/machines/client-release.ts';
import { startTestClient, type TestClient } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const HOPPERS = readRelease(fileURLToPath(new URL('../../src/client', import.meta.url)));
const TOKEN = mintToken();
const A = 'job-752-isolated-a';
const B = 'job-752-isolated-b';
/** The link's keepalive, fast: the client hears the hopper through the PINGs its end answers. */
const FAST_PING = { everyMs: 50, timeoutMs: 1000 };

let dir: string;
let client: TestClient | undefined;
const children: ChildProcess[] = [];
const alive = (p: ChildProcess): boolean => p.exitCode === null && p.signalCode === null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-isolation-'));
  process.env.FAKE_HERDR_DIR = dir;
  process.env.FAKE_HERDR_RUNNING = '1';
});
afterEach(async () => {
  for (const c of children.splice(0)) if (alive(c)) c.kill('SIGKILL');
  await client?.stop();
  client = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** A process of the job's, as a pane's shell would carry its id. */
function jobProcess(jobId: string): ChildProcess {
  const p = spawn('sleep', ['300'], { detached: true, stdio: 'ignore', env: { ...process.env, HOPPER_JOB_ID: jobId } });
  children.push(p);
  return p;
}

const lines: string[] = [];
const keeper = (): ReturnType<typeof createClientReleaseKeeper> =>
  createClientReleaseKeeper({ release: HOPPERS, logger: { info: (l) => lines.push(l), warn: (l) => lines.push(l) } });

describe.runIf(existsSync('/proc/self/environ'))('the isolation stop (issue #752)', () => {
  it('a hopper that answers keeps the jobs running', async () => {
    client = await startTestClient({ token: () => TOKEN, herdrBin: HERDR, session: 'hopper', maxIsolationMs: 400, ping: FAST_PING, isolationCheckMs: 50 });
    const a = jobProcess(A);
    await keeper()(client.transport(TOKEN), () => [A]);
    await new Promise((r) => setTimeout(r, 1000));
    expect(alive(a)).toBe(true);
  });

  it('a client cut off longer than its max isolation stops the jobs the hopper named, and no other; the next probe hears it', async () => {
    client = await startTestClient({ token: () => TOKEN, herdrBin: HERDR, session: 'hopper', maxIsolationMs: 400, ping: FAST_PING, isolationCheckMs: 50 });
    const a = jobProcess(A);
    const b = jobProcess(B);
    const keep = keeper();
    lines.length = 0;
    await keep(client.transport(TOKEN), () => [A]);
    client.cut(true);
    await waitFor(() => !alive(a), { timeoutMs: 5000, what: 'job A to be stopped' });
    expect(alive(b)).toBe(true);
    client.cut(false);
    await waitFor(() => client!.link(), { timeoutMs: 5000, what: 'the client to dial in again' });
    // Job A's process dies while its reap still runs; the client says the stop once the reap ends (issue #2650).
    await waitFor(async () => (await keep(client!.transport(TOKEN), () => [])).online && lines.some((l) => l.includes(A)), { timeoutMs: 5000, what: 'a probe to hear the stop' });
    expect(lines.filter((l) => l.includes(A))).toEqual([expect.stringMatching(/^hopper: client studio: stopped job job-752-isolated-a at \S+, cut off from the hopper for \d+ s$/)]);
    expect((await clientRunningRelease(client.transport(TOKEN), [])).isolationStops).toBeUndefined();
  });

  it('a max isolation of 0 turns the stop off', async () => {
    client = await startTestClient({ token: () => TOKEN, herdrBin: HERDR, session: 'hopper', maxIsolationMs: 0, ping: FAST_PING, isolationCheckMs: 50 });
    const a = jobProcess(A);
    await clientRunningRelease(client.transport(TOKEN), [A]);
    client.cut(true);
    await new Promise((r) => setTimeout(r, 1000));
    expect(alive(a)).toBe(true);
  });
});
