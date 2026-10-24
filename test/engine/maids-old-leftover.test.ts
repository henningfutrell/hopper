// Issue #2715: an entry the old reap left failed ("… is still there", its attempts spent on a client that could not remove an
// overlay work dir) closes on the maids' next pass once the reap there can remove it, with no person's act. Real database,
// the real reap of this machine (localShell) on a real scratch dir. Not as root: root removes what this test makes unreadable.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineSnapshot } from '../../src/domain/types.ts';
import { createMaids } from '../../src/engine/maids.ts';
import { localShell } from '../../src/executors/machine-shell.ts';
import { fixedClock, spec, useTempStore } from '../store/helpers.ts';

const t = useTempStore();
const T0 = '2026-10-17T12:00:00.000Z';
let root: string | undefined;
afterEach(() => { if (root) { execFileSync('chmod', ['-R', 'u+rwX', root]); rmSync(root, { recursive: true, force: true }); } root = undefined; });

describe.skipIf(process.getuid?.() === 0)('an entry the old reap left failed (issue #2715)', () => {
  it('closes reaped on the next pass, and its scratch dir is gone', async () => {
    const clock = fixedClock('2026-10-24T12:00:00.000Z');
    const store = t.open(t.url(), clock);
    const job = store.jobs.create(spec, 1);
    store.jobs.update(job.id, { status: 'finished', finishedAt: T0 });
    root = mkdtempSync(join(tmpdir(), 'jh-maid-'));
    const scratch = join(root, 'work', '.worktrees', '@scratch', job.id);
    const work = join(scratch, 'containers', 'storage', 'overlay', 'abc', 'work');
    mkdirSync(join(work, 'work', 'inner'), { recursive: true });
    writeFileSync(join(scratch, 'out.txt'), 'x');
    chmodSync(join(work, 'work'), 0o000);
    const e = { jobId: job.id, machineId: 'm1', createdAt: T0 };
    store.resourceLedger.record({ ...e, kind: 'scratch_dir', locator: scratch });
    store.resourceLedger.record({ ...e, kind: 'container_runtime', locator: join(scratch, 'containers') });
    for (const [kind, locator] of [['scratch_dir', scratch], ['container_runtime', join(scratch, 'containers')]] as const) {
      store.resourceLedger.close(job.id, kind, locator, 'failed', T0, `${scratch} is still there`);
      store.resourceLedger.tried(job.id, kind, locator, T0, `${scratch} is still there`, T0);
    }
    const m = { id: 'm1', executors: ['x'], online: true } as MachineSnapshot;
    const maids = createMaids({
      store, clock, stopping: () => false, machines: { list: () => Promise.resolve([m]) } as never,
      executors: new Map([['x', { machineShell: () => localShell() }]]) as never,
    }, () => {});

    await maids();

    expect(existsSync(scratch)).toBe(false);
    expect(store.resourceLedger.forJob(job.id).map((x) => [x.kind, x.state])).toEqual([['container_runtime', 'reaped'], ['scratch_dir', 'reaped']]);
    expect(store.resourceLedger.open()).toEqual([]);
  });
});
