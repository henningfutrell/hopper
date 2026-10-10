// Issue #308, opt-in (HOPPER_TEST_SANDBOX_BOX=1: it builds scripts/box/Dockerfile, which installs the agent
// CLI and herdr from the network, then runs a real container): the sandbox box Add machine's line starts
// joins a real daemon and is online, locked down as the line says; after the join nothing in it holds the join
// code, and a restart dials in without it (issue #606). The line is the UI's own (joinLine), with
// the host network a hopper installed on the host gives; the daemon is a test daemon on loopback.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { boxPlace, joinLine } from '../../ui/src/model/machines.ts';
import type { MachinesConfig } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const ON = process.env.HOPPER_TEST_SANDBOX_BOX === '1';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENGINE = process.env.HOPPER_TEST_ENGINE ?? 'docker';
const IMAGE = 'localhost/hopper-test';
const BOX = 'hopper-sandbox-claude';
const docker = (args: string[]): string => execFileSync(ENGINE, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
afterAll(async () => {
  try { docker(['rm', '-f', BOX]); docker(['volume', 'rm', '-f', `${BOX}-home`]); } catch { /* none */ }
  await t?.stop();
  for (const c of cleanups) c();
});

describe.runIf(ON)('a sandbox box from the Add machine line', () => {
  it('joins the daemon and is online, its herdr session answering; root read-only, no capabilities', async () => {
    execFileSync(ENGINE, ['build', '-q', '-f', 'scripts/box/Dockerfile', '--build-arg', 'AGENT=claude', '-t', `${IMAGE}:box-claude`, '.'], { cwd: ROOT, stdio: 'ignore', timeout: 900000 });
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['test'] } } });
    const config = (await t.api<MachinesConfig>('GET', '/api/machines/config')).body;
    const { code } = (await t.ui<{ code: string }>('/ui/api/machines/join', {}, { token: await t.login() })).body;
    const join = { ...boxPlace(config, String(new URL(t.url).port)), boxImage: IMAGE };
    const line = joinLine({ kind: 'box', agent: 'claude', engine: ENGINE === 'podman' ? 'podman' : 'docker' }, { origin: t.url, code, join });
    execFileSync('sh', ['-c', line], { stdio: 'ignore' });
    const m = await waitFor(async () => ((await t!.api('GET', '/api/machines')).body.machines as { id: string; online: boolean; home?: string }[]).find((x) => x.id === BOX && x.online), { timeoutMs: 60000, what: 'the box online' });
    expect(m.home).toBe('/home/agent');
    const inspect = JSON.parse(docker(['inspect', BOX]))[0] as { HostConfig: { ReadonlyRootfs: boolean; CapDrop: string[]; SecurityOpt: string[] }; Mounts: { Type: string }[] };
    expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspect.HostConfig.CapDrop.map((c) => c.toUpperCase())).toContain('ALL');
    expect(inspect.HostConfig.SecurityOpt.join(' ')).toMatch(/no-new-privileges/);
    // Its home volume, and nothing of the computer.
    expect(inspect.Mounts.map((x) => x.Type).filter((x) => x !== 'volume' && x !== 'tmpfs')).toEqual([]);
    // Issue #606: after the join no process in the box holds the code — the entrypoint, herdr (whose panes
    // run the jobs), the client — and the file it came through is gone. The check itself runs without
    // HOPPER_JOIN: an exec into a container gets the environment the container was created with.
    const holders = (): string => docker(['exec', BOX, 'env', '-u', 'HOPPER_JOIN', 'sh', '-c', `grep -l -a -e HOPPER_JOIN= -e '${code}' /proc/[0-9]*/environ 2>/dev/null || true`]);
    expect(holders()).toBe('');
    expect(docker(['exec', BOX, 'sh', '-c', 'ls /tmp/hopper-join 2>/dev/null || true'])).toBe('');
    // A restart dials in with the box's link: the spent code is not needed.
    docker(['restart', BOX]);
    await waitFor(async () => (docker(['exec', BOX, 'sh', '-c', 'pgrep -f hopper-client/main.ts || true']) ? true : undefined), { timeoutMs: 60000, what: 'the box\'s client again' });
    await waitFor(async () => ((await t!.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[]).find((x) => x.id === BOX && x.online), { timeoutMs: 60000, what: 'the box online after a restart' });
    expect(docker(['inspect', '-f', '{{.State.Running}}', BOX])).toBe('true');
    expect(holders()).toBe('');
  }, 1000000);
});
