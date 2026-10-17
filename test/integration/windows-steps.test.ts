// Issue #731: a job on a Linux machine runs one step on a Windows host through the hopper. The daemon, store, HTTP edge
// and a joined client are real; the Windows host is a double at its ports.ts seam (`WindowsStepHost`). The job runs the
// real `hopper-step` script (sh, curl, tar and od) against the hopper, with its own proxy token (issue #563).
//
// Feature: Windows sandbox steps
//   Scenario: a person adds a Windows host; a job lists the hosts
//     Given no Windows host, `hosts` says a person adds one in Settings → Windows hosts
//     When an admin saves one with POST /ui/api/windows-hosts
//     Then `hosts` lists it
//   Scenario: a job builds on the host and gets its log, its exit code and its outputs
//     When the job runs `run build-host --input src --command "msbuild App.sln" --output bin --into out`
//     Then the host gets the inputs as a tar and the command
//     And the job sees the step's output as it streams, exits with the step's exit code, and finds the outputs in out
//     And `step.started` and `step.finished` are on the job's timeline
//   Scenario: a long command goes as a script with the inputs
//   Scenario: a no is clear: an unknown host, a bad output, a token that is no job's — exit 125, `step.refused`
//   Scenario: a step past its timeout is stopped: exit 125, and why
//   Scenario: a host that is not one is refused when it is saved, and a stale version conflicts
//   Scenario: a step gets a vault secret only when its host gives it and a person granted the job the vault
//     Given the vault secret NUGET_TOKEN, and a host that gives it
//     When the job runs a step with `--secret NUGET_TOKEN` and has no vault grant
//     Then the step does not run, exit 125, and the Vault page asks a person to grant the job the vault
//     When a person grants it
//     Then the step gets NUGET_TOKEN in its environment, the job's copy of the log has it masked, and
//       `vault.step_delivered` names the secret, the host and the job, never the value
//     And a secret the host does not give is refused before the vault is asked
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WindowsStepHost } from '../../src/domain/ports.ts';
import type { WindowsHost, WindowsHostsView } from '../../src/domain/types.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { STEP_NOT_RUN, STEP_SCRIPT } from '../../src/windows-steps/index.ts';
import { artifactHarness, eventsOf } from '../support/artifacts.ts';
import { KEY as MASTER_KEY } from '../support/webhooks.ts';
import type { TestApp } from '../support/app.ts';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const HOST: WindowsHost = { name: 'build-host', ssh: 'builder@winbox', hostKey: KEY, workDir: 'C:\\work\\app', label: '.NET builds' };

interface Seen { host: string; command: string; inputs: string[]; outputs: string[]; secrets?: Record<string, string> }

/** A Windows host double: it lists the inputs it got, streams two lines, packs `bin/App.exe` as the outputs, exits 3. */
function fakeHost(o: { hang?: boolean; exeBytes?: number } = {}): { host: WindowsStepHost; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    host: {
      async run(host, step, io) {
        const inputs = step.inputs ? execFileSync('tar', ['-tf', join(step.dir, 'inputs.tar')], { encoding: 'utf8' }).trim().split('\n') : [];
        seen.push({ host: host.name, command: step.command, inputs, outputs: step.outputs, ...(step.secrets ? { secrets: { ...step.secrets } } : {}) });
        io.log('building App.sln\n');
        // A step that prints its secret, split across two chunks: the job's copy of the log masks it.
        for (const value of Object.values(step.secrets ?? {})) { io.log(`token ${value.slice(0, 5)}`); io.log(`${value.slice(5)} used\n`); }
        if (o.hang) {
          await new Promise((resolve) => { io.signal.addEventListener('abort', resolve, { once: true }); });
          return { exit: 255, problem: 'stopped before it ended' };
        }
        io.log('done\n');
        if (step.outputs.length === 0) return { exit: 3 };
        const made = mkdtempSync(join(tmpdir(), 'win-out-'));
        mkdirSync(join(made, 'bin'));
        writeFileSync(join(made, 'bin', 'App.exe'), o.exeBytes ? randomBytes(o.exeBytes) : 'MZ');
        execFileSync('tar', ['-cf', join(step.dir, 'outputs.tar'), '-C', made, 'bin']);
        return { exit: 3, outputsBytes: statSync(join(step.dir, 'outputs.tar')).size };
      },
    },
  };
}

interface Run { code: number; stdout: string; stderr: string }

describe('Windows sandbox steps (issue #731)', () => {
  const h = artifactHarness();
  afterEach(() => h.stop());

  /** `hopper-step`, run as the job runs it, in `cwd`. */
  const step = (a: TestApp, job: string, args: string[], o: { cwd?: string; token?: string } = {}): Promise<Run> => {
    const creds = h.temp('job-credentials-');
    writeFileSync(join(creds, 'token'), `${o.token ?? proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job)}\n`, { mode: 0o600 });
    writeFileSync(join(creds, 'step'), STEP_SCRIPT, { mode: 0o700 });
    const scratch = h.temp('job-tmp-');
    return new Promise((resolve) => {
      execFile('sh', [join(creds, 'step'), ...args], {
        cwd: o.cwd, env: { PATH: process.env.PATH, TMPDIR: scratch, HOPPER_URL: a.url, HOPPER_TOKEN_FILE: join(creds, 'token') } as NodeJS.ProcessEnv, encoding: 'utf8',
      }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
    });
  };

  const saveHosts = async (a: TestApp, session: string, hosts: WindowsHost[]) => {
    const view = (await a.api<WindowsHostsView>('GET', '/api/windows-hosts', undefined, { 'x-hopper-session': session })).body;
    return a.ui<WindowsHostsView>('/ui/api/windows-hosts', { hosts, version: view.version }, { token: session });
  };

  /** A work tree with `src/App.sln` and `src/a.cs`. */
  const workTree = (): string => {
    const dir = h.temp('job-work-');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'App.sln'), 'solution');
    writeFileSync(join(dir, 'src', 'a.cs'), 'class A {}');
    return dir;
  };

  it('lists the hosts a person added, runs a step there and brings back its log, exit code and outputs', async () => {
    const fake = fakeHost();
    const { a, session, job } = await h.boot({ seams: { windowsStepHost: fake.host } });

    const none = await step(a, job, ['hosts']);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain('a person adds one in Settings → Windows hosts');

    expect((await saveHosts(a, session, [HOST])).status).toBe(200);
    const listed = await step(a, job, ['hosts']);
    expect(listed.stdout).toBe('build-host  C:\\work\\app  .NET builds\n');

    const cwd = workTree();
    const r = await step(a, job, ['run', 'build-host', '--input', 'src', '--command', 'msbuild App.sln /p:Configuration=Release', '--output', 'bin', '--into', 'out'], { cwd });
    expect(r.stdout).toBe('building App.sln\ndone\n');
    expect(r.stderr).toContain('hopper-step: outputs in out');
    expect(r.stderr).toContain('hopper-step: exit 3');
    expect(r.code).toBe(3);
    expect(readFileSync(join(cwd, 'out', 'bin', 'App.exe'), 'utf8')).toBe('MZ');
    expect(fake.seen).toEqual([{ host: 'build-host', command: 'msbuild App.sln /p:Configuration=Release', inputs: expect.arrayContaining(['src/', 'src/App.sln', 'src/a.cs']), outputs: ['bin'] }]);

    const started = eventsOf(a, 'step.started');
    expect(started).toHaveLength(1);
    expect(started[0]!.jobId).toBe(job);
    expect(started[0]!.data).toMatchObject({ host: 'build-host', command: 'msbuild App.sln /p:Configuration=Release', timeoutSeconds: 1800, outputs: ['bin'] });
    expect((started[0]!.data as { inputsBytes: number }).inputsBytes).toBeGreaterThan(0);
    expect(eventsOf(a, 'step.finished')[0]!.data).toMatchObject({ host: 'build-host', exit: 3, outputsBytes: expect.any(Number) });
  }, 60_000);

  it('brings back outputs of many megabytes whole (issue #1255)', async () => {
    const fake = fakeHost({ exeBytes: 8 * 1024 * 1024 });
    const { a, session, job } = await h.boot({ seams: { windowsStepHost: fake.host } });
    expect((await saveHosts(a, session, [HOST])).status).toBe(200);
    const cwd = workTree();
    const r = await step(a, job, ['run', 'build-host', '--command', 'msbuild App.sln', '--output', 'bin', '--into', 'out'], { cwd });
    expect(r.stderr).not.toContain('could not be unpacked');
    expect(r.code).toBe(3);
    expect(statSync(join(cwd, 'out', 'bin', 'App.exe')).size).toBe(8 * 1024 * 1024);
  }, 60_000);

  it('sends a script of any size with the inputs, and runs it from the step\'s scratch directory', async () => {
    const fake = fakeHost();
    const { a, session, job } = await h.boot({ seams: { windowsStepHost: fake.host } });
    await saveHosts(a, session, [HOST]);
    const cwd = workTree();
    writeFileSync(join(cwd, 'build.ps1'), `# ${'x'.repeat(10_000)}\nmsbuild App.sln\n`);
    const r = await step(a, job, ['run', 'build-host', '--script', 'build.ps1'], { cwd });
    expect(r.code).toBe(3);
    expect(fake.seen[0]!.command).toBe("& '.\\.hopper-step\\script.ps1'");
    expect(fake.seen[0]!.inputs).toEqual(['.hopper-step/script.ps1']);
    expect(existsSync(join(cwd, 'out'))).toBe(false);
  }, 60_000);

  it('says no, clearly, to an unknown host, a bad output and a token that is no job\'s', async () => {
    const fake = fakeHost();
    const { a, session, job } = await h.boot({ seams: { windowsStepHost: fake.host } });
    await saveHosts(a, session, [HOST]);

    const unknown = await step(a, job, ['run', 'nope', '--command', 'dir']);
    expect(unknown.code).toBe(STEP_NOT_RUN);
    expect(unknown.stdout).toBe('no: the hopper has no Windows host nope. It has: build-host.\n');

    const bad = await step(a, job, ['run', 'build-host', '--command', 'dir', '--output', '..\\secrets']);
    expect(bad.code).toBe(STEP_NOT_RUN);
    expect(bad.stdout).toContain('is not a path relative to the working directory');

    const stranger = await step(a, job, ['run', 'build-host', '--command', 'dir'], { token: 'not-a-token' });
    expect(stranger.code).toBe(STEP_NOT_RUN);
    expect(stranger.stdout).toContain('no: the token is not a job\'s of this hopper');

    expect(fake.seen).toEqual([]);
    const refused = eventsOf(a, 'step.refused').map((e) => e.data);
    expect(refused).toHaveLength(2);
    expect(refused).toEqual(expect.arrayContaining([
      { reason: 'the hopper has no Windows host nope. It has: build-host.', host: 'nope' },
      expect.objectContaining({ host: 'build-host', reason: expect.stringContaining('is not a path relative') }),
    ]));
  }, 60_000);

  it('stops a step past its timeout, and says why', async () => {
    const fake = fakeHost({ hang: true });
    const { a, session, job } = await h.boot({ seams: { windowsStepHost: fake.host } });
    await saveHosts(a, session, [HOST]);
    const r = await step(a, job, ['run', 'build-host', '--command', 'sleep', '--timeout', '1']);
    expect(r.stdout).toBe('building App.sln\n');
    expect(r.code).toBe(STEP_NOT_RUN);
    expect(r.stderr).toContain('hopper-step: timed out after 1 s');
    expect(eventsOf(a, 'step.finished')[0]!.data).toMatchObject({ exit: 255, problem: 'timed out after 1 s' });
  }, 60_000);

  it('refuses a host that is not one, and an edit against a version that moved', async () => {
    const { a, session } = await h.boot({ seams: { windowsStepHost: fakeHost().host } });
    const bad = await saveHosts(a, session, [{ ...HOST, workDir: 'C:\\it\'s' }]);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('workDir is an absolute Windows path');
    const stale = await a.ui('/ui/api/windows-hosts', { hosts: [HOST], version: 'missing' }, { token: session });
    expect(stale.status).toBe(200);
    const again = await a.ui('/ui/api/windows-hosts', { hosts: [], version: 'missing' }, { token: session });
    expect(again.status).toBe(409);
  }, 60_000);

  it('gives a step a vault secret only when its host gives it and a person granted the job the vault, and masks it in the log', async () => {
    const VALUE = 'nuget-key-0123456789-never-to-the-job';
    const fake = fakeHost();
    const { a, session, job } = await h.boot({ secrets: { HOPPER_MASTER_KEY: MASTER_KEY }, seams: { windowsStepHost: fake.host } });
    const edit = (body: Record<string, unknown>) => a.ui('/ui/api/vault', body, { token: session });
    expect((await edit({ action: 'set', name: 'NUGET_TOKEN', value: VALUE })).status).toBe(200);
    expect((await edit({ action: 'set', name: 'PROD_KEY', value: 'prod-never-given' })).status).toBe(200);
    expect((await saveHosts(a, session, [{ ...HOST, secrets: ['NUGET_TOKEN'] }])).status).toBe(200);
    expect((await step(a, job, ['hosts'])).stdout).toBe('build-host  C:\\work\\app  .NET builds  secrets: NUGET_TOKEN\n');

    const ungranted = await step(a, job, ['run', 'build-host', '--secret', 'NUGET_TOKEN', '--command', 'nuget push']);
    expect(ungranted.code).toBe(STEP_NOT_RUN);
    expect(ungranted.stdout).toMatch(/^no: NUGET_TOKEN: job [0-9a-f]{8} has no vault grant/);
    expect(fake.seen).toEqual([]);
    const asks = (await a.api<{ grantAsks?: unknown[] }>('GET', '/api/vault', undefined, { 'x-hopper-session': session })).body.grantAsks;
    expect(asks).toEqual([expect.objectContaining({ job, windowsHost: 'build-host', names: ['NUGET_TOKEN'] })]);
    expect(eventsOf(a, 'vault.grant_asked')[0]!.data).toMatchObject({ job, windowsHost: 'build-host', name: 'NUGET_TOKEN' });
    expect(eventsOf(a, 'vault.step_refused')[0]!.data).toMatchObject({ name: 'NUGET_TOKEN', host: 'build-host', job });

    const outside = await step(a, job, ['run', 'build-host', '--secret', 'PROD_KEY', '--command', 'dir']);
    expect(outside.code).toBe(STEP_NOT_RUN);
    expect(outside.stdout).toBe('no: build-host does not give PROD_KEY to its steps: it gives NUGET_TOKEN. A person adds a secret to the host in Settings → Windows hosts.\n');

    expect((await a.ui(`/ui/api/jobs/${job}/grant-vault`, {}, { token: session })).status).toBe(200);
    const r = await step(a, job, ['run', 'build-host', '--secret', 'NUGET_TOKEN', '--command', 'nuget push']);
    expect(r.code).toBe(3);
    expect(fake.seen).toEqual([expect.objectContaining({ command: 'nuget push', secrets: { NUGET_TOKEN: VALUE } })]);
    expect(r.stdout).toBe('building App.sln\ntoken *** used\ndone\n');
    expect(r.stdout + r.stderr).not.toContain(VALUE);
    expect(eventsOf(a, 'vault.step_delivered').map((e) => e.data)).toEqual([{ name: 'NUGET_TOKEN', host: 'build-host', job }]);
    expect(eventsOf(a, 'step.started')[0]!.data).toMatchObject({ secrets: ['NUGET_TOKEN'] });
    expect(JSON.stringify(await a.events())).not.toContain(VALUE);
  }, 60_000);
});
