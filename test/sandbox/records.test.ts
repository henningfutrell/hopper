// Issue #708: the hopper keeps the sandbox records in memory over the instance's table. The vault reads a box's launch
// scope at each ask, from timers and process events too; those reads must not reach the database, which the hopper
// closes when it stops. The hopper is the table's one writer, so its memory is the table.
//
// Feature: the sandbox records in memory
//   Scenario: the records are written through to the table and read from memory
//     Given the records over a store that holds one box
//     When a box is added, one updated, one removed, a name taken twice
//     Then the table holds what memory holds
//     And once the store is closed, the records still answer, in name order
import { describe, expect, it } from 'vitest';
import type { SandboxRecord } from '../../src/domain/ports.ts';
import { cachedSandboxes } from '../../src/sandbox/records.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from '../store/helpers.ts';

const temp = useTempStore();

const box = (id: string, name: string): SandboxRecord => ({
  id, userId: 'admin', name, agent: 'claude', template: { name: 'kube', version: '2026-10-02T09:00:00.000Z' },
  image: 'example.org/kube-box:1', params: { secrets: ['KUBE_TOKEN'], cpus: 1, memoryMb: 1024, ttlMinutes: 60 }, runtime: 'podman', machine: 'local',
  containerId: '', volume: `${name}-home`, keepHome: true, state: 'starting', createdAt: '2026-10-02T10:00:00.000Z',
  expiresAt: '2026-10-02T11:00:00.000Z', address: 'http://hopper:4790',
});

describe('the sandbox records in memory', () => {
  it('are written through to the table and read from memory, also once the store is closed', () => {
    const s = openInstanceStore({ url: temp.url(), clock: fixedClock() });
    s.sandboxes.add(box('sbx-z', 'hopper-sandbox-z'));
    const records = cachedSandboxes(s.sandboxes);
    expect(records.add(box('sbx-a', 'hopper-sandbox-a'))).toBe(true);
    expect(records.add(box('sbx-b', 'hopper-sandbox-a'))).toBe(false);
    expect(records.add(box('sbx-m', 'hopper-sandbox-m'))).toBe(true);
    records.update({ ...box('sbx-a', 'hopper-sandbox-a'), state: 'ready' });
    expect(records.remove('sbx-m')).toBe(true);
    expect(records.remove('sbx-m')).toBe(false);
    const held = records.list();
    expect(held.map((r) => [r.id, r.state])).toEqual([['sbx-a', 'ready'], ['sbx-z', 'starting']]);
    expect(s.sandboxes.list()).toEqual(held);
    held[0]!.containerId = 'changed by a reader';
    s.close();
    expect(records.list().map((r) => [r.id, r.state])).toEqual([['sbx-a', 'ready'], ['sbx-z', 'starting']]);
    expect(records.get('sbx-a')?.containerId).toBe('');
    expect(records.get('sbx-z')?.name).toBe('hopper-sandbox-z');
  });
});
