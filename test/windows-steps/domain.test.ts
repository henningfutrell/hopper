// Issue #731: a Windows host as the config record keeps it, and a step's request, checked before anything runs.
import { describe, expect, it } from 'vitest';
import { STEP_DEFAULT_TIMEOUT_S, stepRequestOf, windowsHostsOf, windowsHostsProblem, type WindowsHost } from '../../src/domain/windows-steps.ts';

const HOST: WindowsHost = { name: 'build-host', ssh: 'builder@winbox', hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl', workDir: 'C:\\work\\app' };

describe('Windows hosts', () => {
  it('a host with a name, a plain ssh destination, a pinned key and an absolute Windows path loads', () => {
    expect(windowsHostsProblem({ hosts: [HOST, { ...HOST, name: 'tests', workDir: 'D:/apps/zen menu (x86)', label: 'app tests' }] })).toBeUndefined();
    expect(windowsHostsOf({ hosts: [HOST] })).toEqual([HOST]);
    expect(windowsHostsOf(undefined)).toEqual([]);
  });

  it('a host may name the vault secrets its steps may be given', () => {
    expect(windowsHostsProblem({ hosts: [{ ...HOST, secrets: ['NUGET_TOKEN', 'signing.pfx-pass'] }] })).toBeUndefined();
  });

  it.each([
    [{ hosts: [{ ...HOST, name: 'Build Host' }] }, 'name is lower case'],
    [{ hosts: [{ ...HOST, ssh: '-oProxyCommand=evil' }] }, 'ssh is a plain'],
    [{ hosts: [{ ...HOST, hostKey: 'not a key' }] }, 'hostKey is the pinned host key'],
    [{ hosts: [{ ...HOST, workDir: 'work\\app' }] }, 'workDir is an absolute Windows path'],
    [{ hosts: [{ ...HOST, workDir: "C:\\it's" }] }, 'workDir is an absolute Windows path'],
    [{ hosts: [{ ...HOST, workDir: 'C:\\work\\..\\Windows' }] }, 'workDir is an absolute Windows path'],
    [{ hosts: [{ ...HOST, workDir: 'C:\\work;rm' }] }, 'workDir is an absolute Windows path'],
    [{ hosts: [HOST, HOST] }, 'two Windows hosts are named build-host'],
    [{ hosts: [{ ...HOST, shell: 'cmd' }] }, 'no field shell'],
    [{ list: [] }, 'the Windows hosts are'],
    [{ hosts: [{ ...HOST, secrets: 'NUGET_TOKEN' }] }, 'secrets is a list of vault secret names'],
    [{ hosts: [{ ...HOST, secrets: ['system/github'] }] }, 'secrets is a list of vault secret names'],
    [{ hosts: [{ ...HOST, secrets: ['shared/x'] }] }, 'secrets is a list of vault secret names'],
    [{ hosts: [{ ...HOST, secrets: ['A', 'A'] }] }, 'names A twice'],
    [{ hosts: [{ ...HOST, secrets: Array.from({ length: 33 }, (_, i) => `S${i}`) }] }, 'at most 32 secrets'],
  ])('%j is refused: %s', (value, why) => {
    expect(windowsHostsProblem(value)).toContain(why);
    expect(windowsHostsOf(value)).toEqual([]);
  });

  it('a long work dir that does not match is refused at once', () => {
    const started = Date.now();
    expect(windowsHostsProblem({ hosts: [{ ...HOST, workDir: `C:\\${'a\\'.repeat(90)}!` }] })).toContain('workDir');
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe('a step request', () => {
  it('takes a host, a command, a timeout and outputs relative to the working directory', () => {
    expect(stepRequestOf({ host: 'build-host', command: 'msbuild App.sln', outputs: ['bin\\Release', 'logs/build.log'] }))
      .toEqual({ host: 'build-host', command: 'msbuild App.sln', timeoutSeconds: STEP_DEFAULT_TIMEOUT_S, outputs: ['bin\\Release', 'logs/build.log'], secrets: [] });
    expect(stepRequestOf({ host: 'h', command: 'dir', outputs: [], secrets: ['NUGET_TOKEN', 'NUGET_TOKEN', 'SIGN_PASS'] })).toMatchObject({ secrets: ['NUGET_TOKEN', 'SIGN_PASS'] });
    expect(stepRequestOf({ host: 'h', command: 'dir', timeout: '60', outputs: [] })).toMatchObject({ timeoutSeconds: 60 });
  });

  it('takes a box in place of a host (issue #1004): its command is POSIX sh, run in the box', () => {
    expect(stepRequestOf({ box: 'hopper-sandbox-asked-302ecc9661e2', command: 'aws sts get-caller-identity', outputs: ['out/plan.txt'] }))
      .toEqual({ box: 'hopper-sandbox-asked-302ecc9661e2', command: 'aws sts get-caller-identity', timeoutSeconds: STEP_DEFAULT_TIMEOUT_S, outputs: ['out/plan.txt'], secrets: [] });
  });

  it.each([
    [{ command: 'dir', outputs: [] }, 'name the Windows host'],
    [{ host: 'h', outputs: [] }, 'give the command'],
    [{ host: 'h', command: 'x'.repeat(5000), outputs: [] }, '--script FILE'],
    [{ host: 'h', command: 'dir', timeout: '0', outputs: [] }, 'the timeout is whole seconds'],
    [{ host: 'h', command: 'dir', timeout: '99999', outputs: [] }, 'the timeout is whole seconds'],
    [{ host: 'h', command: 'dir', outputs: ['..\\secrets'] }, 'is not a path relative'],
    [{ host: 'h', command: 'dir', outputs: ['bin/../../x'] }, 'is not a path relative'],
    [{ host: 'h', command: 'dir', outputs: ['C:\\Windows'] }, 'is not a path relative'],
    [{ host: 'h', command: 'dir', outputs: ['/etc'] }, 'is not a path relative'],
    [{ host: 'h', command: 'dir', outputs: ["a'b"] }, 'is not a path relative'],
    [{ host: 'h', command: 'dir', outputs: ['*.dll'] }, 'is not a path relative'],
    [{ host: 'h', command: 'dir', outputs: [], secrets: ['system/github'] }, 'is not a vault secret name'],
    [{ host: 'h', command: 'dir', outputs: [], secrets: ['A=B'] }, 'is not a vault secret name'],
    [{ host: 'h', command: 'dir', outputs: [], secrets: Array.from({ length: 17 }, (_, i) => `S${i}`) }, 'at most 16 secrets'],
    [{ host: 'h', box: 'b', command: 'dir', outputs: [] }, 'a Windows host or a box, not both'],
    [{ box: 'b', command: 'true', outputs: [], secrets: ['AWS_KEY'] }, 'a box step takes no --secret'],
  ])('%j is refused: %s', (fields, why) => {
    const r = stepRequestOf(fields);
    expect('problem' in r && r.problem).toContain(why);
  });
});
