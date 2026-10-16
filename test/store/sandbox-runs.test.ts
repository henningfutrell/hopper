// The sandbox runs (issue #1349, instance migration 42): one row per sandbox made for a step, in the instance schema,
// from its start to its burn. A table only: the build before never reads it.
import { describe, expect, it } from 'vitest';
import type { SandboxRun } from '../../src/domain/sandbox-runs.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const temp = useTempStore();

const run = (id: string, startedAt: string, userId = 'admin'): SandboxRun => ({
  id, userId, jobId: 'job-1', template: 'asked-1', box: `hopper-need-asked-1-${id}`, machine: 'local', startedAt,
});

describe('sandbox runs', () => {
  it('a run is started, ended, destroyed, and read back; the open runs and a user\'s latest', () => {
    const s = openInstanceStore({ url: temp.url(), clock: fixedClock() });
    s.sandboxRuns.start(run('a', '2026-10-15T10:00:00.000Z'));
    s.sandboxRuns.start(run('b', '2026-10-15T11:00:00.000Z'));
    s.sandboxRuns.start(run('c', '2026-10-15T12:00:00.000Z', 'other'));
    s.sandboxRuns.start({ ...run('a', '2026-10-15T13:00:00.000Z'), template: 'not-kept' });
    expect(s.sandboxRuns.get('a')).toEqual(run('a', '2026-10-15T10:00:00.000Z'));

    s.sandboxRuns.end('a', { at: '2026-10-15T10:01:00.000Z', exit: 0, outcome: 'succeeded' });
    s.sandboxRuns.end('a', { at: '2026-10-15T10:02:00.000Z', exit: 1, outcome: 'failed' });
    s.sandboxRuns.destroyed('a', '2026-10-15T10:01:01.000Z');
    s.sandboxRuns.destroyed('a', '2026-10-15T10:05:00.000Z');
    expect(s.sandboxRuns.get('a')).toEqual({ ...run('a', '2026-10-15T10:00:00.000Z'), endedAt: '2026-10-15T10:01:00.000Z', exit: 0, outcome: 'succeeded', destroyedAt: '2026-10-15T10:01:01.000Z' });

    expect(s.sandboxRuns.open().map((r) => r.id)).toEqual(['b', 'c']);
    expect(s.sandboxRuns.latest('admin', 10).map((r) => r.id)).toEqual(['b', 'a']);
    expect(s.sandboxRuns.latest('admin', 1).map((r) => r.id)).toEqual(['b']);
    s.close();
  });
});
