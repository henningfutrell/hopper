// Issue #691: a Windows client has no `env` program on its PATH, so every fixed script it ran (discovery, a reap, a
// survey) failed with `spawn env ENOENT`. The client unsets the variables itself and runs the script's own program.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnOf } from '../../src/client/spawn.ts';
import { discoverArgv } from '../../src/client/discover.ts';
import { reapArgv, surveyArgv } from '../../src/client/reap.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('a fixed script on the client (issue #691)', () => {
  it('runs its program with the variables `env -u` names removed, never the env program', () => {
    const s = spawnOf(['env', '-u', 'HOPPER_JOB_ID', '-u', 'OTHER', 'sh', '-c', 'echo hi', 'sh'], { HOPPER_JOB_ID: 'j', OTHER: 'o', KEEP: 'k' });
    expect(s).toEqual({ file: 'sh', args: ['-c', 'echo hi', 'sh'], env: { KEEP: 'k' } });
  });

  it('an argv that does not start with env runs as it is, with the environment given', () => {
    expect(spawnOf(['sh', '-c', 'true'], { A: '1' })).toEqual({ file: 'sh', args: ['-c', 'true'], env: { A: '1' } });
  });

  it('discovery, a reap and a survey run on a PATH with sh and no env, and see no HOPPER_JOB_ID', () => {
    const bin = mkdtempSync(join(tmpdir(), 'jh-691-'));
    dirs.push(bin);
    mkdirSync(join(bin, 'b'));
    symlinkSync(execFileSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).trim(), join(bin, 'b', 'sh'));
    const env = { PATH: join(bin, 'b'), HOPPER_JOB_ID: 'job-1' };
    for (const argv of [discoverArgv(), reapArgv('job-1'), surveyArgv([bin])]) {
      const s = spawnOf(argv, env);
      expect(s.file).toBe('sh');
      expect(s.env).not.toHaveProperty('HOPPER_JOB_ID');
    }
    const s = spawnOf(['env', '-u', 'HOPPER_JOB_ID', 'sh', '-c', 'printf "%s" "${HOPPER_JOB_ID-unset}"'], env);
    expect(execFileSync(s.file, s.args, { env: s.env, encoding: 'utf8' })).toBe('unset');
  });
});
