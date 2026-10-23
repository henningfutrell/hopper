// Issue #691: a Windows client has no `env` program on its PATH, so every fixed script it ran (discovery, a reap, a
// survey) failed with `spawn env ENOENT`. The client unsets the variables itself and runs the script's own program.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_SCRIPT_SH, spawnOf } from '../../src/client/spawn.ts';
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

// Issue #2676: a native Windows client cut the reap off near 8 KiB on its command line (`sh: -c: line 2: syntax error:
// unexpected end of file`). There the script goes in the environment, and the command line holds only a short `-c`.
describe('a fixed script on a Windows client (issue #2676)', () => {
  it('goes in HOPPER_CLIENT_SCRIPT, with its arguments as they are', () => {
    const s = spawnOf(['env', '-u', 'HOPPER_JOB_ID', 'sh', '-c', 'echo "$1"', 'sh', 'job-1', ''], { HOPPER_JOB_ID: 'j', KEEP: 'k' }, 'win32');
    expect(s.file).toBe('sh');
    expect(s.args).toEqual(['-c', CLIENT_SCRIPT_SH, 'sh', 'job-1', '']);
    expect(s.env).toEqual({ KEEP: 'k', HOPPER_CLIENT_SCRIPT: 'echo "$1"' });
  });

  it('runs as sh -c would: its arguments, its exit, and nothing of it left in what it starts', () => {
    const script = 'f() { printf "%s|%s|%s\\n" "$0" "$1" "$2"; }; f "$@"; printf "%s\\n" "${HOPPER_CLIENT_SCRIPT-unset}"; sh -c \'printf "%s\\n" "${HOPPER_CLIENT_SCRIPT-unset}"\'; exit 3';
    const s = spawnOf(['sh', '-c', script, 'name', 'a b', ''], {}, 'win32');
    let out = '';
    try { execFileSync(s.file, s.args, { env: { ...s.env, PATH: process.env.PATH }, encoding: 'utf8' }); } catch (e) { out = (e as { stdout: string; status: number }).stdout; expect((e as { status: number }).status).toBe(3); }
    expect(out).toBe('name|a b|\nunset\nunset\n');
  });

  it('every script the client runs leaves a short command line: the reap, the survey, discovery', () => {
    for (const argv of [reapArgv('job-1', 'C:/w/.worktrees/@scratch/job-1'), surveyArgv(['C:/w']), discoverArgv()]) {
      expect(argv.join(' ').length).toBeGreaterThan(1000);
      expect(spawnOf(argv, {}, 'win32').args.join(' ').length).toBeLessThan(200);
    }
  });

  // Issue #2690: jobs on a Windows client still failed at the reap with the same error. Its client ran a build before the fix:
  // a `-c` of CLIENT_SCRIPT_SH is one line, and cannot say `line 2`.
  it('the reap reaches sh whole through the environment: it parses, and it fits a Windows environment variable', () => {
    for (const argv of [reapArgv('job-1', 'C:/w/.worktrees/@scratch/job-1'), reapArgv('job-1', 'C:/w/.worktrees/@scratch/job-1', true), surveyArgv(['C:/w']), discoverArgv()]) {
      const s = spawnOf(argv, {}, 'win32');
      const script = s.env.HOPPER_CLIENT_SCRIPT!;
      expect(script).toBe(argv[argv.indexOf('-c') + 1]);
      // Windows holds at most 32767 characters in one variable.
      expect(script.length).toBeLessThan(32_767);
      execFileSync('sh', ['-c', 'printf "%s" "$HOPPER_CLIENT_SCRIPT" | sh -n'], { env: { ...s.env, PATH: process.env.PATH }, stdio: 'pipe' });
    }
    expect(CLIENT_SCRIPT_SH).not.toContain('\n');
    // Cut where the command line cut it, the reap is the error the client said.
    const reap = reapArgv('job-1', 'C:/w/.worktrees/@scratch/job-1');
    expect(() => execFileSync('bash', ['-n', '-c', reap[reap.indexOf('-c') + 1]!.slice(0, 8191)], { stdio: 'pipe' })).toThrow(/unexpected end of file/);
  });

  it('elsewhere the script stays on the command line', () => {
    expect(spawnOf(['sh', '-c', 'true'], {}, 'linux')).toEqual({ file: 'sh', args: ['-c', 'true'], env: {} });
  });
});
