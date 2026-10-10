// The sandbox records (issue #708, instance migration 34): one row per box the hopper launched, kept in the instance
// schema; the sandbox module reconciles from them. A table only: the build before never reads it.
import { describe, expect, it } from 'vitest';
import type { SandboxRecord } from '../../src/domain/ports.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const temp = useTempStore();

const record: SandboxRecord = {
  id: 'sbx-1', userId: 'admin', name: 'hopper-sandbox-kube', agent: 'claude', template: { name: 'kube', version: '2026-10-02T09:00:00.000Z' },
  image: 'example.org/kube-box:1', params: { secrets: ['KUBE_TOKEN'], cpus: 1, memoryMb: 1024, ttlMinutes: 60 }, runtime: 'podman', machine: 'local',
  containerId: '', volume: 'hopper-sandbox-kube-home', keepHome: true, state: 'starting', createdAt: '2026-10-02T10:00:00.000Z',
  expiresAt: '2026-10-02T11:00:00.000Z', address: 'http://hopper:4790',
};

describe('sandbox records', () => {
  it('a record is added, read back, updated and removed', () => {
    const s = openInstanceStore({ url: temp.url(), clock: fixedClock() });
    expect(s.sandboxes.add(record)).toBe(true);
    expect(s.sandboxes.add({ ...record, id: 'sbx-2' })).toBe(false);
    expect(s.sandboxes.list()).toEqual([record]);
    expect(s.sandboxes.get('sbx-1')).toEqual(record);
    s.sandboxes.update({ ...record, containerId: 'c0ffee', state: 'ready' });
    expect(s.sandboxes.get('sbx-1')).toMatchObject({ containerId: 'c0ffee', state: 'ready' });
    expect(s.sandboxes.remove('sbx-1')).toBe(true);
    expect(s.sandboxes.remove('sbx-1')).toBe(false);
    expect(s.sandboxes.list()).toEqual([]);
    s.close();
  });
});
