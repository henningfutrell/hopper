// Issue #1627: the jobs the hopper named on a client target are kept on disk, with when it was last heard, so a client
// that restarts while cut off from the hopper still stops them past its max isolation; a file older than a day is not read.
//
// Feature: the isolation stop survives a client restart
//   Scenario: a client restarted while cut off stops the jobs the hopper named before
//     Given a client whose hopper named job A, with a max isolation of 30 min
//     When the client restarts 10 min later, still cut off
//     Then 30 min after the hopper was last heard it stops job A, and no job twice
//   Scenario: a kept file past its life is not read
//     Given a kept file whose last hearing is more than a day old
//     When the client starts
//     Then it names no job to stop
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createIsolationWatch, ISOLATION_FILE, ISOLATION_FILE_LIFE_MS } from '../../src/client/isolation.ts';

const MAX = 30 * 60_000;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function client(file: string, at: { t: number }) {
  const stopped: string[] = [];
  const watch = createIsolationWatch({ maxIsolationMs: MAX, file, log: () => {}, now: () => at.t, stopJob: async (id) => { stopped.push(id); } });
  return { watch, stopped };
}

const fileIn = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'jh-isolation-file-'));
  dirs.push(d);
  return join(d, ISOLATION_FILE);
};

describe('the isolation file', () => {
  it('stops the jobs named before a restart once the max isolation passed since the hopper was last heard', async () => {
    const file = fileIn();
    const at = { t: Date.parse('2026-10-17T10:00:00Z') };
    const before = client(file, at);
    before.watch.heard();
    before.watch.told(['job-a']);

    at.t += 10 * 60_000;
    const after = client(file, at);
    await after.watch.check();
    expect(after.stopped).toEqual([]);

    at.t += 20 * 60_000;
    await after.watch.check();
    expect(after.stopped).toEqual(['job-a']);
    expect(after.watch.takeStops().map((s) => s.jobId)).toEqual(['job-a']);

    const again = client(file, at);
    at.t += 60_000;
    await again.watch.check();
    expect(again.stopped).toEqual([]);
  });

  it('reads no file past its life', async () => {
    const file = fileIn();
    const at = { t: Date.parse('2026-10-17T10:00:00Z') };
    client(file, at).watch.told(['job-a']);
    at.t += ISOLATION_FILE_LIFE_MS + 60_000;
    const later = client(file, at);
    await later.watch.check();
    at.t += MAX;
    await later.watch.check();
    expect(later.stopped).toEqual([]);
  });
});
