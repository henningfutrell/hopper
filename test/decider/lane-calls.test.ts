// Decider calls in lane tuning (issue #688): the lanes Jev may pick for a machine stay within what the rules allow and
// the machine's bounds; its applied pick stands only at the rules' recommendation it was picked at; an applied pick of
// a job's machine goes first among the machines the job may go to, and is passed over when it is not one of them.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { laneCountOptions, withJevLanes } from '../../src/decider/lane-calls.ts';
import type { LaneRecommendation, ResourceReading } from '../../src/domain/types.ts';
import { inputs, job, machine } from './support.ts';

const rec = (over: Partial<LaneRecommendation> = {}): LaneRecommendation => ({
  machineId: 'm', online: true, configured: 2, lanes: 4, headroom: 4, reason: 'room for 2 more', confidence: 0.5, usedFrac: 0, usage: 'free',
  tuning: { autoTune: true, minLanes: 1, maxLanes: 8 }, ...over,
});

describe('the lanes Jev may pick', () => {
  it('runs from one fewer than the lower of the configured and the recommended lanes to the higher', () => {
    expect(laneCountOptions(rec()).map((o) => o.id)).toEqual(['1', '2', '3', '4']);
    expect(laneCountOptions(rec({ configured: 5, lanes: 3 })).map((o) => o.id)).toEqual(['2', '3', '4', '5']);
    expect(laneCountOptions(rec()).map((o) => o.label)).toEqual(['1 lane', '2 lanes (configured now)', '3 lanes', '4 lanes (the rules recommend it)']);
  });

  it('stays within the machine\'s bounds; fewer than two lanes leaves nothing to pick', () => {
    expect(laneCountOptions(rec({ tuning: { autoTune: true, minLanes: 2, maxLanes: 3 }, lanes: 3 })).map((o) => o.id)).toEqual(['2', '3']);
    expect(laneCountOptions(rec({ configured: 1, lanes: 1, tuning: { autoTune: true, minLanes: 1, maxLanes: 8 } }))).toEqual([]);
  });
});

describe('Jev\'s applied lanes', () => {
  const pick = { lanes: 3, confidence: 0.9, rulesLanes: 4, configured: 2 };

  it('are the recommendation, with the rules\' own beside it', () => {
    expect(withJevLanes(rec(), pick)).toMatchObject({
      lanes: 3, confidence: 0.9, decidedBy: 'jev', rules: { lanes: 4, reason: 'room for 2 more', confidence: 0.5 },
      reason: 'Jev picked 3 lanes at 90%; the rules: 4 lanes, room for 2 more',
    });
  });

  it('stand only while the rules recommend the same at the same configured lanes, auto-tune on and the machine online', () => {
    expect(withJevLanes(rec({ lanes: 5 }), pick)).toEqual(rec({ lanes: 5 }));
    expect(withJevLanes(rec({ configured: 3 }), pick)).toEqual(rec({ configured: 3 }));
    expect(withJevLanes(rec({ online: false }), pick).lanes).toBe(4);
    expect(withJevLanes(rec(), undefined)).toEqual(rec());
  });
});

describe('Jev\'s applied pick of a job\'s machine', () => {
  const GIB = 1024 ** 3;
  const res: ResourceReading = { cores: 8, cpuBusyFrac: 0.1, memTotalBytes: 16 * GIB, memAvailableBytes: 12 * GIB };
  const two = [machine({ id: 'a', label: 'a', resources: res }), machine({ id: 'b', label: 'b', resources: res })];

  it('goes first among the machines the job may go to, and the start reason says so', () => {
    const d = decide(inputs({ machines: two, waiting: [job('j')], placementPicks: { j: { machineId: 'b', confidence: 0.92 } } }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'j', machineId: 'b' })]);
    expect(d.start[0]!.reason).toContain('Jev picked b at 92%');
  });

  it('is passed over when the job may not go there: the job is placed as before', () => {
    const d = decide(inputs({ machines: [two[0]!, machine({ id: 'b', label: 'b', online: false })], waiting: [job('j')], placementPicks: { j: { machineId: 'b', confidence: 0.92 } } }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'j', machineId: 'a' })]);
    expect(d.start[0]!.reason).not.toContain('Jev');
  });
});
