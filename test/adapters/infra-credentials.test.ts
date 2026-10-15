// Issues #1128 part 7, #1248 (design.md "Infra credentials on machines"): each machine's snapshot carries the infra credentials
// its job user's context holds, as its last read found them — this machine at every list, an ssh target in its probe, a client
// target in its client's `/release` answer. Only the names. A machine holding any is not ready and takes no new job.
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readRelease } from '../../src/client/release.ts';
import { mintToken } from '../../src/client/signature.ts';
import { clientRunningRelease } from '../../src/executors/client.ts';
import { createAttachedMachineSource, createClientReleaseKeeper, createLocalMachineSource, probeSsh, type MachineProbe } from '../../src/machines/index.ts';
import { startTestClient, type TestClient } from '../support/client.ts';
import { testSshAuth } from '../support/ssh.ts';
import { decide } from '../../src/decider/index.ts';
import { inputs, job } from '../decider/support.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
const SSH = fileURLToPath(new URL('../herdr/fake-ssh-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
chmodSync(SSH, 0o755);
const flush = () => new Promise((r) => setImmediate(r));

// The test HOME is a throwaway (test/support/isolate.ts): the folders are made there and removed after each test.
const made: string[] = [];
const holds = (...names: string[]) => { for (const n of names) { mkdirSync(join(homedir(), n), { recursive: true }); made.push(join(homedir(), n)); } };
let client: TestClient | undefined;
afterEach(async () => {
  for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
  await client?.stop();
  client = undefined;
});

describe('infra credential folders on machines (issue #1128)', () => {
  it('this machine: read from its home at every list; none is an empty list', async () => {
    const src = createLocalMachineSource({ maxLanes: 1, executors: () => [] });
    expect((await src.list())[0]!.infraCredentials).toEqual([]);
    holds('.aws', '.terraform.d');
    expect((await src.list())[0]!.infraCredentials).toEqual(['.aws', '.terraform.d']);
  });

  it('an attached machine carries what its last probe read; a probe that read none, or offline, drops it', async () => {
    let answer: MachineProbe = { online: true, infraCredentials: ['.keycloak'] };
    let t = 0;
    const src = createAttachedMachineSource({
      machine: () => ({ name: 'laptop', ssh: 'laptop', lanes: 1, executors: [], herdr: true, session: 'hopper' }),
      clock: { now: () => new Date(t) }, probeEveryMs: 30000, probe: async () => answer,
    });
    await src.list(); await flush();
    expect((await src.list())[0]!.infraCredentials).toEqual(['.keycloak']);
    answer = { online: true };
    t += 30000; await src.list(); await flush();
    expect((await src.list())[0]).not.toHaveProperty('infraCredentials');
    answer = { online: false, infraCredentials: ['.aws'] };
    t += 30000; await src.list(); await flush();
    expect((await src.list())[0]).not.toHaveProperty('infraCredentials');
  });

  it('an ssh target: its probe reads them in its home, in the same call', async () => {
    const dir = join(homedir(), 'probe');
    process.env.FAKE_HERDR_DIR = dir;
    mkdirSync(dir, { recursive: true });
    made.push(dir);
    const probe = () => probeSsh({ target: 'laptop', sshBin: SSH, controlDir: join(dir, 's'), auth: testSshAuth(join(dir, 'auth')) });
    expect((await probe()).infraCredentials).toEqual([]);
    holds('.aws');
    expect((await probe()).infraCredentials).toEqual(['.aws']);
  });

  it('a client target: its client answers them in /release, and the probe carries them', async () => {
    process.env.FAKE_HERDR_DIR = join(homedir(), 'herdr');
    mkdirSync(process.env.FAKE_HERDR_DIR, { recursive: true });
    made.push(process.env.FAKE_HERDR_DIR);
    process.env.FAKE_HERDR_RUNNING = '1';
    const token = mintToken();
    client = await startTestClient({ token: () => token, herdrBin: HERDR, session: 'hopper' });
    holds('.terraform.d', '.keycloak');
    expect((await clientRunningRelease(client.transport(token), [])).infraCredentials).toEqual(['.keycloak', '.terraform.d']);
    const keep = createClientReleaseKeeper({ release: readRelease(fileURLToPath(new URL('../../src/client', import.meta.url))), logger: { info: () => {}, warn: () => {} } });
    expect(await keep(client.transport(token), () => [])).toMatchObject({ online: true, infraCredentials: ['.keycloak', '.terraform.d'] });
  });
});

// Issue #1248: a machine whose job user holds credentials is not ready; once its probe finds none, it takes jobs again,
// with no restart: each probe says afresh.
describe('a machine not ready for its credentials (issue #1248)', () => {
  it('takes no job while its probe finds credentials, and takes one once the next probe finds none', async () => {
    let answer: MachineProbe = { online: true, home: '/home/job', infraCredentials: ['.kube', '.aws'] };
    let t = 0;
    const src = createAttachedMachineSource({
      machine: () => ({ name: 'wsl', ssh: 'wsl', lanes: 1, executors: ['test'], herdr: true, session: 'hopper' }),
      clock: { now: () => new Date(t) }, probeEveryMs: 30000, probe: async () => answer,
    });
    await src.list(); await flush();
    const before = decide(inputs({ machines: await src.list(), waiting: [job('a')] }), 'd1');
    expect(before.start).toEqual([]);
    expect(before.hold).toEqual([{ jobId: 'a', reason: expect.stringContaining('wsl is not ready: its job user holds credentials a job could use (.kube, .aws)') }]);
    answer = { online: true, home: '/home/job', infraCredentials: [] };
    t += 30000; await src.list(); await flush();
    const after = decide(inputs({ machines: await src.list(), waiting: [job('a')] }), 'd2');
    expect(after.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'wsl' })]);
  });
});
