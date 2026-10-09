// Issue #535: the UI's model of high priority. A job is high priority at or above the threshold the queue answers;
// with none answered yet nothing is tagged. High-priority questions, logins and hand-offs come first, each list's
// own order within; the nav badges count the high-priority ones apart. Priority lanes read as people say them.
import { describe, expect, it } from 'vitest';
import { loginsBadge, sortByTimeLeft } from '../../ui/src/model/logins.ts';
import { highHandoffs, highQuestions, isHighJob, questionOrder, reliabilityText, startText } from '../../ui/src/model/priority.ts';
import type { FailuresView, HandoffView, Job, LoginSettings, LoginView, PriorityLaneView, QuestionView } from '../../ui/src/model/wire.ts';

const T0 = Date.parse('2026-10-09T12:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const job = (priority: number) => ({ id: 'j', priority }) as Job;
const question = (id: string, createdAt: string, high: boolean, over: Partial<QuestionView> = {}): QuestionView => ({
  id, jobId: `job-${id}`, text: '?', recentOutput: '', detectedBy: 'marker', status: 'open', tier: 'human', attempts: [], notifyCount: 1,
  createdAt, updatedAt: createdAt, priority: high ? 80 : 50, high, ...over,
});
const SETTINGS: LoginSettings = { onExpiry: 'fail', warnSec: 60 };
const login = (id: string, expiresIn: number, high: boolean | undefined, over: Partial<LoginView> = {}): LoginView => ({
  id, kind: 'device_code', tool: 'gh', status: 'pending', expiresAt: at(expiresIn), jobId: `job-${id}`, run: 'herdr-claude', renewable: true,
  createdAt: at(0), updatedAt: at(0), codeKept: true, ...(high === undefined ? {} : { priority: high ? 80 : 50, high }), ...over,
});

describe('high priority in the UI', () => {
  it('a job is high priority at or above the threshold; with no threshold yet, none is', () => {
    expect(isHighJob(job(75), 75)).toBe(true);
    expect(isHighJob(job(74), 75)).toBe(false);
    expect(isHighJob(job(99), null)).toBe(false);
    expect(isHighJob(undefined, 75)).toBe(false);
  });

  it('questions: high-priority ones first, then the longest waiting', () => {
    const qs = [question('new-high', at(30), true), question('old', at(0), false), question('old-high', at(10), true), question('newer', at(20), false)];
    expect(questionOrder(qs).map((q) => q.id)).toEqual(['old-high', 'new-high', 'old', 'newer']);
    expect(highQuestions(qs)).toBe(2);
    expect(highQuestions([question('with-level', at(0), true, { tier: 'opus' })])).toBe(0);
  });

  it('logins: an open high-priority login before an open one with less time left; ended ones after', () => {
    const ls = [login('soon', 100, false), login('high', 600, true), login('ended', 50, true, { status: 'completed', endedAt: at(5) })];
    expect(sortByTimeLeft(ls, T0, SETTINGS).map((l) => l.id)).toEqual(['high', 'soon', 'ended']);
    expect(loginsBadge(ls, T0, SETTINGS)).toEqual({ n: 2, warn: false, high: 1 });
  });

  it('hand-offs: the open ones of high-priority jobs counted apart', () => {
    const h = (id: string, status: 'open' | 'closed', high: boolean) => ({ id, jobId: id, status, high, priority: high ? 80 : 50 }) as HandoffView;
    const f = { handoffs: [h('a', 'open', true), h('b', 'open', false), h('c', 'closed', true)], problems: [] } as unknown as FailuresView;
    expect(highHandoffs(f)).toBe(1);
    expect(highHandoffs(null)).toBe(0);
  });

  it('a lane\'s reliability and start time read as people say them', () => {
    const lane = { laneId: 'desk/lane-1', machineId: 'desk', runs: 31, finished: 28, failed: 3, laneFaults: 1, recentFaults: 0, score: 0.968, successRate: 28 / 31, medianStartMs: 12_400, priority: true, reason: '' } as PriorityLaneView;
    expect(reliabilityText(lane)).toBe('97% without a lane fault · 31 runs · 1 lane fault');
    expect(reliabilityText({ ...lane, runs: 0, laneFaults: 0, score: 0 })).toBe('no runs');
    expect(startText(12_400)).toBe('12 s');
    expect(startText(95_000)).toBe('1 min 35 s');
    expect(startText(undefined)).toBe('—');
  });
});
