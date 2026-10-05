// Every place that names a lane names its machine too (issue #166): the decision log and event lines.
import { describe, expect, it } from 'vitest';
import { subjectOf } from '../../ui/src/components/event-line.tsx';
import { startTarget } from '../../ui/src/model/board.ts';
import type { DomainEvent, MachineView } from '../../ui/src/model/wire.ts';

const on = (id: string, label: string): MachineView => ({ id, label, maxLanes: 1, online: true, executors: [], lanes: [], usage: [] });
const ms = [on('m1', 'laptop'), on('m2', 'laptop')];
const ev = (o: Partial<DomainEvent>): DomainEvent => ({ seq: 1, type: 'lane.opened', at: '2026-10-05T10:00:00Z', data: {}, ...o } as DomainEvent);
const nameOf = (id: string) => `job ${id}`;

describe('lane names outside the lane board (issue #166)', () => {
  it("a Decision's start names the lane's machine, so two lane-1s on two machines differ", () => {
    expect(startTarget({ machineId: 'm1', laneId: 'm1/lane-1' }, ms)).toBe('laptop (m1) · lane-1');
    expect(startTarget({ machineId: 'm2', laneId: 'm2/lane-1' }, ms)).toBe('laptop (m2) · lane-1');
  });
  it('a start without a lane yet names its machine and a new lane', () => {
    expect(startTarget({ machineId: 'm2' }, ms)).toBe('laptop (m2) · new lane');
  });
  it("an event about a lane names the lane's machine; one about a machine names the machine", () => {
    expect(subjectOf(ev({ laneId: 'm1/lane-1', machineId: 'm1' }), nameOf, ms)).toBe('laptop (m1) · lane-1');
    expect(subjectOf(ev({ machineId: 'm2' }), nameOf, ms)).toBe('laptop (m2)');
    expect(subjectOf(ev({ jobId: 'a', laneId: 'm1/lane-1' }), nameOf, ms)).toBe('job a');
  });
});
