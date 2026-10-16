// The sandbox records (issue #708, instance migration 34): one row per box an older build launched, kept in the instance
// schema. The hopper launches no box now (issue #1349): its burn pass reads them, and removes each once its box is gone.
import { describe, expect, it } from 'vitest';
import type { SandboxRecord } from '../../src/domain/ports.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const temp = useTempStore();

const record: SandboxRecord = { id: 'sbx-1', userId: 'admin', name: 'hopper-sandbox-kube', image: 'example.org/kube-box:1', machine: 'local' };

describe('sandbox records', () => {
  it('a record is added, read back and removed', () => {
    const s = openInstanceStore({ url: temp.url(), clock: fixedClock() });
    expect(s.sandboxes.add(record)).toBe(true);
    expect(s.sandboxes.add({ ...record, id: 'sbx-2' })).toBe(false);
    expect(s.sandboxes.list()).toEqual([record]);
    expect(s.sandboxes.remove('sbx-1')).toBe(true);
    expect(s.sandboxes.remove('sbx-1')).toBe(false);
    expect(s.sandboxes.list()).toEqual([]);
    s.close();
  });

  it('a row an older build wrote is read, with what the burn needs', () => {
    const s = openInstanceStore({ url: temp.url(), clock: fixedClock() });
    const older = { ...record, agent: 'claude', params: { secrets: [], cpus: 1, memoryMb: 1024 }, runtime: 'podman', state: 'ready', volume: 'hopper-sandbox-kube-home' };
    expect(s.sandboxes.add(older)).toBe(true);
    expect(s.sandboxes.list()[0]).toMatchObject(record);
    s.close();
  });
});
