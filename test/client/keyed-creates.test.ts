// Issue #1628: a create through the client is keyed by the name it makes (src/client/once.ts). When the hopper sends a
// create again — its answer was lost, so it signs the call again with a new nonce —, the client answers the first
// answer for that name and creates nothing again. The real client on a link; the machine's Podman a libpod double, its
// herdr a script that counts its tab creates.
//
// Feature: a create sent again makes one thing
//   Scenario: a box create sent again makes one container, and answers its id
//   Scenario: a herdr tab create sent again makes one tab, and answers its ids
//   Scenario: a create that failed is not kept: sent again, it runs
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clientHerdr, runtimeRelay } from '../../src/executors/client.ts';
import { createRemoteRuntime } from '../../src/sandbox/remote.ts';
import { startTestClient, type TestClient } from '../support/client.ts';
import { createFakeLibpod } from '../support/fake-libpod.ts';
import { startFakeRuntimeApi, type FakeRuntimeApi } from '../support/fake-runtime-api.ts';

const TOKEN = 'b'.repeat(43);
let c: TestClient | undefined;
let api: FakeRuntimeApi | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await c?.stop();
  c = undefined;
  await api?.close();
  api = undefined;
  for (const f of cleanups.splice(0)) f();
});

const spec = {
  name: 'hopper-need-kube-1', image: 'example.org/kube-box:1', network: 'host', volume: 'hopper-need-kube-1-home',
  env: {}, labels: { 'io.hopper.need': 'i-1', 'io.hopper.user': 'admin' },
  limits: { cpus: 2, memoryMb: 2048 }, user: 'agent', script: 'echo hi',
};

/** A herdr that answers each tab create with a new tab, and fails while `fail` exists. */
function countingHerdr(): { bin: string; creates: () => number; fail: (on: boolean) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'hopper-keyed-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'creates');
  const failFile = join(dir, 'fail');
  writeFileSync(log, '');
  const bin = join(dir, 'herdr');
  writeFileSync(bin, `#!/bin/sh
[ -e '${failFile}' ] && { echo 'herdr: server not running' >&2; exit 1; }
echo x >> '${log}'
n=$(wc -l < '${log}' | tr -d ' ')
echo "{\\"result\\":{\\"tab\\":{\\"tab_id\\":\\"t$n\\"},\\"root_pane\\":{\\"pane_id\\":\\"p$n\\"}}}"
`);
  chmodSync(bin, 0o755);
  return {
    bin,
    creates: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).length,
    fail: (on) => { if (on) writeFileSync(failFile, ''); else rmSync(failFile, { force: true }); },
  };
}

const TAB = ['tab', 'create', '--workspace', 'w1', '--cwd', '/', '--label', 'job-1', '--no-focus'];

describe('a create sent again makes one thing (issue #1628)', () => {
  it('a box create sent again makes one container, and answers its id', async () => {
    const libpod = createFakeLibpod();
    api = await startFakeRuntimeApi(libpod.handlers);
    c = await startTestClient({ token: () => TOKEN, herdrBin: '/bin/false', session: 'hopper', runtimeSockets: () => ({ podman: api!.socket }) });
    const rt = createRemoteRuntime('studio', runtimeRelay(c.transport(TOKEN, 'studio')));
    await rt.pull(spec.image);
    const first = await rt.create(spec);
    // The answer is dropped: the hopper sends the same create again.
    const again = await rt.create(spec);
    expect(again).toBe(first);
    expect(libpod.containers.size).toBe(1);
  });

  it('a herdr tab create sent again makes one tab, and answers its ids', async () => {
    const herdr = countingHerdr();
    c = await startTestClient({ token: () => TOKEN, herdrBin: herdr.bin, session: 'hopper' });
    const t = c.transport(TOKEN, 'studio');
    const first = await clientHerdr(t, TAB, 5000);
    const again = await clientHerdr(t, TAB, 5000);
    expect(again).toEqual(first);
    expect(first.stdout).toContain('"t1"');
    expect(herdr.creates()).toBe(1);
    // Another tab is its own create.
    await clientHerdr(t, [...TAB.slice(0, 7), 'job-2', '--no-focus'], 5000);
    expect(herdr.creates()).toBe(2);
  });

  it('a create that failed is not kept: sent again, it runs', async () => {
    const herdr = countingHerdr();
    c = await startTestClient({ token: () => TOKEN, herdrBin: herdr.bin, session: 'hopper' });
    const t = c.transport(TOKEN, 'studio');
    herdr.fail(true);
    expect((await clientHerdr(t, TAB, 5000)).code).toBe(1);
    herdr.fail(false);
    const r = await clientHerdr(t, TAB, 5000);
    expect(r.code).toBe(0);
    expect(herdr.creates()).toBe(1);
  });
});
