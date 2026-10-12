// Issue #715: a box of a read-only template has a terraform wrapper first on PATH. It runs the commands that read, and
// refuses each one that writes infrastructure or state, before the real binary sees it. It is one layer: the read-only
// AWS session is the boundary, and the real binary stays in $HOPPER_TOOLS. Run by a real `sh`, with a fake real binary
// that logs what it was given.
//
// Feature: the read-only terraform wrapper
//   Scenario: the commands that read go to the real binary as they were given
//   Scenario: plan takes no state lock, and init keeps the lock file as it is
//   Scenario: each command that writes is refused in words the read-only check knows, and the real binary is not run
//   Scenario: init that would change the lock file or move state is refused
//   Scenario: every command runs with the image's provider mirror config, whatever the caller set; providers lock and
//     providers mirror, which download providers, are refused
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DENIAL } from '../../src/sandbox/probes.ts';
import { TERRAFORM_WRAPPER } from '../../src/sandbox/terraform-wrapper.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

interface Ran { code: number; stderr: string; real: string[]; config: string[] }

function setup(): { dir: string; run(args: string[], o?: { cwd?: string; env?: Record<string, string> }): Promise<Ran> } {
  const dir = mkdtempSync(join(tmpdir(), 'tf-wrapper-'));
  dirs.push(dir);
  const log = join(dir, 'real.log');
  const config = join(dir, 'config.log');
  writeFileSync(log, '');
  writeFileSync(config, '');
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'terraform'), `#!/bin/sh\nprintf '%s|' "$@" >> ${JSON.stringify(log)}\nprintf '%s\\n' "\${TF_CLI_ARGS-unset}" >> ${JSON.stringify(log)}\nprintf '%s\\n' "\${TF_CLI_CONFIG_FILE-unset}" >> ${JSON.stringify(config)}\n`);
  chmodSync(join(dir, 'bin', 'terraform'), 0o755);
  writeFileSync(join(dir, 'terraform'), TERRAFORM_WRAPPER);
  chmodSync(join(dir, 'terraform'), 0o755);
  return {
    dir,
    run: (args, o = {}) => new Promise((resolve) => {
      execFile(join(dir, 'terraform'), args, { cwd: o.cwd ?? dir, env: { PATH: '/usr/bin:/bin', HOPPER_TOOLS: join(dir, 'bin'), ...o.env }, encoding: 'utf8' }, (err, _stdout, stderr) => {
        const lines = (f: string): string[] => readFileSync(f, 'utf8').split('\n').filter((x) => x !== '');
        resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stderr, real: lines(log), config: lines(config) });
      });
    }),
  };
}

describe('the read-only terraform wrapper (issue #715)', () => {
  it('the commands that read go to the real binary as they were given', async () => {
    const w = setup();
    const reads = [['version'], ['-version'], ['show', '-json'], ['validate'], ['output', '-json'], ['providers'], ['providers', 'schema', '-json'], ['state', 'list'], ['state', 'show', 'aws_ssm_parameter.x'], ['workspace', 'list'], ['workspace', 'show'], ['-chdir=stack', 'validate']];
    for (const args of reads) {
      const r = await w.run(args);
      expect(r.code, args.join(' ')).toBe(0);
    }
    const { real } = await w.run(['show', 'with space']);
    expect(real.slice(0, reads.length + 1)).toEqual([...reads, ['show', 'with space']].map((a) => `${a.join('|')}|unset`));
  });

  it('plan takes no state lock, and init keeps the lock file as it is', async () => {
    const w = setup();
    expect((await w.run(['plan', '-input=false'])).code).toBe(0);
    expect((await w.run(['plan', '-lock=false'])).code).toBe(0);
    // A lock asked for is a write to the lock table: refused.
    const locked = await w.run(['plan', '-lock=true']);
    expect(locked.code).not.toBe(0);
    expect(locked.stderr).toMatch(DENIAL);
    // No lock file: init writes one, as a fresh checkout needs. With one: it may not change it.
    expect((await w.run(['init', '-input=false'])).code).toBe(0);
    writeFileSync(join(w.dir, '.terraform.lock.hcl'), '');
    expect((await w.run(['init', '-backend-config=bucket=b'])).code).toBe(0);
    mkdirSync(join(w.dir, 'stack'));
    writeFileSync(join(w.dir, 'stack', '.terraform.lock.hcl'), '');
    const { real } = await w.run(['-chdir=stack', 'init']);
    // TF_CLI_ARGS cannot slip a flag past it.
    expect((await w.run(['plan'], { env: { TF_CLI_ARGS: '-lock=true', TF_CLI_ARGS_plan: '-lock=true' } })).real.at(-1)).toBe('plan|-lock=false|unset');
    expect(real).toEqual([
      'plan|-input=false|-lock=false|unset',
      'plan|-lock=false|unset',
      'init|-input=false|unset',
      'init|-backend-config=bucket=b|-lockfile=readonly|unset',
      '-chdir=stack|init|-lockfile=readonly|unset',
    ]);
  });

  it('each command that writes is refused in words the read-only check knows, and the real binary is not run', async () => {
    const w = setup();
    const writes = [
      ['apply', '-auto-approve'], ['destroy', '-auto-approve'], ['import', 'aws_ssm_parameter.x', 'x'], ['refresh'], ['taint', 'x'], ['untaint', 'x'],
      ['force-unlock', '-force', 'id'], ['state', 'rm', 'x'], ['state', 'mv', 'a', 'b'], ['state', 'push', 'f'], ['state', 'replace-provider', 'a', 'b'],
      ['workspace', 'new', 'w'], ['workspace', 'delete', 'w'], ['workspace', 'select', '-or-create', 'w'], ['console'], ['-chdir=stack', 'apply'], ['login'],
    ];
    for (const args of writes) {
      const r = await w.run(args);
      expect(r.code, args.join(' ')).not.toBe(0);
      expect(r.stderr, args.join(' ')).toMatch(DENIAL);
    }
    expect((await w.run(['destroy'])).stderr).toContain('terraform destroy: refused by the read-only wrapper');
    expect((await w.run(['state', 'rm', 'x'])).real).toEqual([]);
  });

  it('init that would change the lock file or move state is refused', async () => {
    const w = setup();
    for (const flag of ['-upgrade', '-migrate-state', '-force-copy']) {
      const r = await w.run(['init', flag]);
      expect(r.code, flag).not.toBe(0);
      expect(r.stderr).toMatch(DENIAL);
    }
    expect((await w.run(['version'])).real).toEqual(['version|unset']);
  });

  it('every command runs with the image\'s provider mirror config, whatever the caller set; providers lock and mirror are refused', async () => {
    const w = setup();
    // The config sits beside the tools' bin directory: /opt/hopper-tools/terraform.rc in a read-only image.
    const rc = join(w.dir, 'terraform.rc');
    expect((await w.run(['init', '-input=false'])).code).toBe(0);
    expect((await w.run(['plan'], { env: { TF_CLI_CONFIG_FILE: '/elsewhere/download.rc' } })).code).toBe(0);
    expect((await w.run(['providers'])).config).toEqual([rc, rc, rc]);
    // Each one asks the registry for providers, past the mirror: an arbitrary download.
    for (const args of [['providers', 'lock'], ['providers', 'lock', '-platform=linux_arm64'], ['providers', 'mirror', '/tmp/m']]) {
      const r = await w.run(args);
      expect(r.code, args.join(' ')).not.toBe(0);
      expect(r.stderr, args.join(' ')).toMatch(DENIAL);
    }
    expect((await w.run(['providers', 'lock'])).stderr).toContain('terraform providers lock: refused by the read-only wrapper');
    expect((await w.run(['version'])).real).toEqual(['init|-input=false|unset', 'plan|-lock=false|unset', 'providers|unset', 'version|unset']);
  });
});
