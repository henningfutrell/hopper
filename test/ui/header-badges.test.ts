// Header badges (issue #1181): the dashboard's KPI cards the viewer picks show their totals in the header. A badge reads
// the card's own total, so the two never disagree; the default is one Lanes badge, the lanes that hold a job.
import { describe, expect, it } from 'vitest';
import type { Job, Lane } from '../../src/domain/types.ts';
import { jobBoard, kpis } from '../../ui/src/model/board.ts';
import { BADGES, DEFAULT_HEADER_BADGES, cardTotals, shownBadges } from '../../ui/src/model/header-badges.ts';
import type { InFlight, MachineView } from '../../ui/src/model/wire.ts';

const job = (id: string, o: Partial<Job> = {}): Job => ({
  id, spec: { executor: 'test', payload: {} }, priority: 50, status: 'queued', approved: false, attempts: 0,
  createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z', ...o,
});
const lane = (n: number, state: Lane['state']): Lane => ({ id: `m1/lane-${n}`, machineId: 'm1', state, openedAt: '2026-10-03T10:00:00Z' });
const machine = (lanes: Lane[]): MachineView => ({ id: 'm1', label: 'laptop', maxLanes: 6, online: true, executors: ['test'], lanes, usage: [] });
const inFlight: InFlight = { total: 8, running: 6, ownCommand: 0, pullRequests: 2 };
const items = { waiting_for_approval: 0, queued: 0, working: 0, needs_you: 0, waiting_outside: 0, pr_open: 0, partly_done: 0, done: 0, failed: 3, dropped: 0 };

describe('header badges (issue #1181)', () => {
  it('each badge is its card\'s total', () => {
    const board = jobBoard([
      job('q1'), job('q2', { status: 'held' }), job('a', { status: 'waiting_answer' }),
      job('f', { status: 'finished', finishedAt: '2026-10-03T11:00:00Z' }),
    ], []);
    const k = kpis(board, [machine([lane(1, 'draining'), lane(2, 'busy'), lane(3, 'idle')])], items, null);
    const totals = cardTotals(k, inFlight);
    expect(totals).toEqual({ inFlight: 8, lanes: k.lanesBusy, waiting: k.waiting, waitingAnswer: k.waitingAnswer, finished: k.finished, failed: k.failed });
    expect(Object.keys(totals).sort()).toEqual(Object.keys(BADGES).sort());
  });

  it('the default is one Lanes badge: the lanes holding a job, busy and draining; never the ledger\'s in flight', () => {
    expect(DEFAULT_HEADER_BADGES).toEqual(['lanes']);
    const k = kpis(jobBoard([], []), [machine([lane(1, 'draining'), ...[3, 4, 5, 6, 7].map((n) => lane(n, 'busy'))])], null, null);
    expect(cardTotals(k, inFlight).lanes).toBe(6);
    expect(cardTotals(k, inFlight).lanes).toBeLessThanOrEqual(k.lanesMax);
  });

  it('the badges shown: the saved choice in the cards\' order, the default until one is read', () => {
    expect(shownBadges(undefined)).toEqual(['lanes']);
    expect(shownBadges({ badges: ['failed', 'inFlight'] })).toEqual(['inFlight', 'failed']);
    expect(shownBadges({ badges: [] })).toEqual([]);
    // An answer with no list (an older daemon) is no choice.
    expect(shownBadges({} as never)).toEqual(['lanes']);
  });
});
