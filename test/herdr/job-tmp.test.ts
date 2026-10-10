// Issue #506: a job's TMPDIR held its scratch dir's full path, so a Unix socket a tool makes under it —
// Chromium's `$TMPDIR/org.chromium.Chromium.XXXXXX/SingletonSocket` — overflowed the 108 bytes a socket
// path may take, and Chromium aborted at startup in every job. Run for real: the scratch command in a real
// shell, under a work tree as deep as a real one, then a socket bound where Chromium binds its own.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jobScratchOf, jobTmpOf, scratchCommand } from '../../src/executors/herdr/start.ts';

/** Chromium's process singleton socket, under a temp dir it makes in TMPDIR (process_singleton_posix.cc). */
const SINGLETON = join('org.chromium.Chromium.a1B2c3', 'SingletonSocket');

let root: string;
let id: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jh-506-'));
  id = randomUUID();
});
afterEach(() => {
  rmSync(jobTmpOf(id), { force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('a job\'s TMPDIR (issue #506)', () => {
  it('is a short link to its scratch dir, so a Unix socket a tool binds under it fits, and lands in the scratch dir', async () => {
    const cwd = join(root, 'home', 'someone', 'workbench', 'a-workflow-repository-with-a-long-name');
    const scratch = jobScratchOf(cwd, id);
    expect(Buffer.byteLength(join(scratch, SINGLETON))).toBeGreaterThan(107);
    expect(execFileSync('sh', ['-c', scratchCommand(cwd, id, true)], { encoding: 'utf8' })).toContain('hopper-scratch-ready');
    expect(readlinkSync(jobTmpOf(id))).toBe(scratch);
    const path = join(jobTmpOf(id), SINGLETON);
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(107);
    execFileSync('mkdir', ['-p', join(jobTmpOf(id), 'org.chromium.Chromium.a1B2c3')]);
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    await new Promise((r) => server.close(r));
    expect(existsSync(join(scratch, 'org.chromium.Chromium.a1B2c3'))).toBe(true);
  });

  it('a link there that is not the job\'s makes the scratch command say unusable', () => {
    const cwd = join(root, 'w');
    execFileSync('mkdir', ['-p', jobTmpOf(id)]);
    try {
      expect(execFileSync('sh', ['-c', scratchCommand(cwd, id, true)], { encoding: 'utf8' })).toContain('hopper-scratch-unusable');
    } finally {
      rmSync(jobTmpOf(id), { recursive: true, force: true });
    }
  });
});
