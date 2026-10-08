// A machine's disk (issue #401): the filesystem holding its home, where the jobs directory and the
// scratch dirs live, read so the UI can warn before it fills. Read for real with statfs, and from the
// line `df -Pk` gives over ssh.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DF_COMMAND, diskAt, diskOf, readDf } from '../../src/machines/disk.ts';
import { createLocalMachineSource } from '../../src/machines/index.ts';

const GIB = 1024 ** 3;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jh-disk-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a disk reading', () => {
  it('is low below a tenth free or below 5 GiB free, whichever comes first', () => {
    expect(diskOf(50 * GIB, 100 * GIB)).toEqual({ freeBytes: 50 * GIB, totalBytes: 100 * GIB, low: false });
    expect(diskOf(9 * GIB, 100 * GIB).low).toBe(true);
    expect(diskOf(4 * GIB, 20 * GIB).low).toBe(true);
    expect(diskOf(6 * GIB, 20 * GIB).low).toBe(false);
    expect(diskOf(0, 2000 * GIB).low).toBe(true);
  });

  it('reads the filesystem a path is on, through the nearest directory that exists', () => {
    const here = diskAt(dir)!;
    expect(here.totalBytes).toBeGreaterThan(0);
    expect(here.freeBytes).toBeGreaterThanOrEqual(0);
    expect(here.freeBytes).toBeLessThanOrEqual(here.totalBytes);
    expect(diskAt(join(dir, 'not', 'made', 'yet'))?.totalBytes).toBe(here.totalBytes);
  });

  it('reads the line its df command prints on an ssh target: total and available, in KiB', () => {
    expect(readDf('noise\nhopper-disk 104857600 52428800\n/home/far')).toEqual(diskOf(50 * GIB, 100 * GIB));
    expect(readDf('/home/far')).toBeUndefined();
    expect(readDf('hopper-disk x y')).toBeUndefined();
    expect(DF_COMMAND).toContain('df -Pk "$HOME"');
  });
});

describe('this machine\'s disk', () => {
  it('rides on its snapshot', async () => {
    const src = createLocalMachineSource({ maxLanes: 1, executors: () => [], disk: () => diskOf(1, 2) });
    expect((await src.list())[0]!.disk).toEqual(diskOf(1, 2));
  });

  it('is read from this machine\'s home by default', async () => {
    const src = createLocalMachineSource({ maxLanes: 1, executors: () => [] });
    expect((await src.list())[0]!.disk?.totalBytes).toBeGreaterThan(0);
  });
});
