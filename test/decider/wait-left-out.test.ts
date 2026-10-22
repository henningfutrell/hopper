// Issue #2499: a job that waits names every machine of its executor and why it was left out — full, drained, offline,
// at a usage limit, short of memory —, not only the machine with the most lanes. A drained machine hid behind
// "fleet-l2's lane cap is 2" for a day while jobs queued.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { NOW, busy, inputs, job, machine, reading } from './support.ts';

const GIB = 1024 ** 3;
const full = (id: string, lanes: number) => Array.from({ length: lanes }, (_, i) => busy(i + 1, `${id}-r${i + 1}`, { machineId: id }));

describe('the machines a waiting job was left out of (issue #2499)', () => {
  it('a lane wait names every other machine with its cause', () => {
    const machines = [
      machine({ id: 'big', maxLanes: 4 }),
      machine({ id: 'small', maxLanes: 2 }),
      machine({ id: 'drained', maxLanes: 3, drained: { person: 'admin', via: 'ui', at: NOW } }),
      machine({ id: 'gone', maxLanes: 3, online: false }),
      machine({ id: 'paced', maxLanes: 3, usageLimits: { soft: 0.5, hard: 0.7 } }),
      machine({ id: 'other', executors: ['codex'] }),
    ];
    const d = decide(inputs({ machines, lanes: [...full('big', 4), ...full('small', 2)], usage: [reading(80, 100, { machineId: 'paced' })], waiting: [job('a')] }), 'd1');
    expect(d.wait).toEqual([{
      jobId: 'a',
      reason: "waiting for a lane: machine big's lane cap is 4, all 4 in use; left out: small is full: machine small's lane cap is 2, all 2 in use; "
        + `drained is drained since ${NOW}; gone is offline; paced is full: usage hard limit stops executor test on paced (used 80%)`,
    }]);
  });

  it('a memory wait names the machines with no lane for it too', () => {
    const machines = [
      machine({ id: 'seat', maxLanes: 2, resources: { cores: 2, memTotalBytes: 4 * GIB, memAvailableBytes: 0.4 * GIB, container: true } }),
      machine({ id: 'host', maxLanes: 1 }),
    ];
    const d = decide(inputs({ machines, lanes: full('host', 1), waiting: [job('a')] }), 'd1');
    expect(d.wait).toEqual([{
      jobId: 'a',
      reason: "waiting for memory: seat has 0.4 GiB available, and a new job needs 2 GiB over its floor of 1 GiB; left out: host is full: machine host's lane cap is 1, all 1 in use",
    }]);
  });

  it('a job pinned to a machine is told of that machine only', () => {
    const d = decide(inputs({ machines: [machine({ id: 'big', maxLanes: 1 }), machine({ id: 'gone', online: false })], lanes: full('big', 1), waiting: [job('a', { machineId: 'big' })] }), 'd1');
    expect(d.wait).toEqual([{ jobId: 'a', reason: "waiting for a lane: machine big's lane cap is 1, all 1 in use" }]);
  });
});
