// The Usage view's model (ui/src/model/usage.ts): how a reading, a usage source, a lane effect and
// an account are written. Pure; the view renders what these return.
import { describe, expect, it } from 'vitest';
import type { MachineLaneEffect, PartAccount, UsageReading } from '../../src/domain/types.ts';
import { accountFacts, executorEffectLines, laneEffectText, orderReadings, readingKey, readingLabel, resetsIn, serviceLabel, shownSource, sourceLine } from '../../ui/src/model/usage.ts';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const r = (over: Partial<UsageReading>): UsageReading => ({ source: 'claude', used: 10, limit: 100, unit: '%', at: '2026-10-03T11:58:00Z', ...over });
const m = (over: Partial<MachineLaneEffect>): MachineLaneEffect => ({ machineId: 'local', label: 'server', online: true, maxLanes: 4, usedFrac: 0.1, cap: 4, band: 'free', executors: [], ...over });

describe('usage model', () => {
  it('a reading is labelled by its window, else by its source; keys tell windows and machines apart', () => {
    expect(readingLabel(r({ window: 'session' }))).toBe('session');
    expect(readingLabel(r({ window: 'week (Fable)' }))).toBe('week (Fable)');
    expect(readingLabel(r({ source: 'budget' }))).toBe('budget');
    expect(new Set([readingKey(r({ window: 'session' })), readingKey(r({ window: 'week' })), readingKey(r({ window: 'week', machineId: 'laptop' }))]).size).toBe(3);
  });

  it('throttling readings come first, informational ones after, each in source order', () => {
    const fable = r({ window: 'week (Fable)', informational: true });
    const session = r({ window: 'session' });
    const week = r({ window: 'week' });
    expect(orderReadings([fable, session, week]).map(readingLabel)).toEqual(['session', 'week', 'week (Fable)']);
  });

  it('resets in: minutes, hours and minutes, days and hours; nothing once past', () => {
    expect(resetsIn('2026-10-03T12:40:00Z', NOW)).toBe('resets in 40m');
    expect(resetsIn('2026-10-03T14:05:00Z', NOW)).toBe('resets in 2h 5m');
    expect(resetsIn('2026-10-06T17:00:00Z', NOW)).toBe('resets in 3d 5h');
    expect(resetsIn('2026-10-03T11:00:00Z', NOW)).toBe('');
  });

  it('a usage source line: its problem, else when it last read', () => {
    expect(sourceLine({ name: 'claude', refreshedAt: '2026-10-03T11:58:00Z' }, NOW)).toEqual({ text: 'read 2m ago', problem: false });
    expect(sourceLine({ name: 'claude', problem: 'usage unavailable: x' }, NOW)).toEqual({ text: 'usage unavailable: x', problem: true });
    expect(sourceLine({ name: 'fake' }, NOW)).toEqual({ text: 'no state reported', problem: false });
  });

  it('the lane effect per machine, in words', () => {
    expect(laneEffectText(m({}))).toBe('all 4 lanes');
    expect(laneEffectText(m({ usedFrac: 0.8, cap: 2, band: 'soft' }))).toBe('capped at 2 of 4 lanes (past the soft limit)');
    expect(laneEffectText(m({ usedFrac: 0.96, cap: 0, band: 'hard' }))).toBe('stopped: 0 of 4 lanes (hard limit)');
    expect(laneEffectText(m({ online: false, cap: 0, band: 'offline' }))).toBe('offline: no lanes');
  });

  it('an executor whose budget limits it apart from the machine gets its own line; one the same as the machine gets none', () => {
    const mixed = m({ executors: [
      { executor: 'herdr-claude', usedFrac: 0.8, cap: 2, band: 'soft' },
      { executor: 'herdr-codex', usedFrac: 0.1, cap: 4, band: 'free' },
    ] });
    expect(executorEffectLines(mixed)).toEqual(['herdr-claude: 80% used, capped at 2 of 4 lanes (past the soft limit)']);
    expect(executorEffectLines(m({ executors: [{ executor: 'test', usedFrac: 0.1, cap: 4, band: 'free' }] }))).toEqual([]);
    expect(executorEffectLines(m({ executors: [{ executor: 'herdr-claude', usedFrac: 0.96, cap: 0, band: 'hard' }, { executor: 'command', usedFrac: 0, cap: 4, band: 'free' }] })))
      .toEqual(['herdr-claude: 96% used, stopped: 0 of 4 lanes (hard limit)']);
  });

  it('an account: the service by name, its facts as label/value pairs (lists joined, empty ones left out)', () => {
    const app: PartAccount = { role: 'job-source', instance: 'github-app', service: 'github', identity: 'jh[bot]', detail: { via: 'GitHub App', installedRepos: ['o/a', 'o/b'] } };
    expect(serviceLabel('claude')).toBe('Claude');
    expect(serviceLabel('github')).toBe('GitHub');
    expect(serviceLabel('other')).toBe('other');
    expect(accountFacts(app)).toEqual([['via', 'GitHub App'], ['installed repos', 'o/a, o/b']]);
    expect(accountFacts({ ...app, detail: { via: 'GitHub App', installedRepos: [] } })).toEqual([['via', 'GitHub App']]);
    expect(accountFacts({ ...app, detail: { plan: 'max', organization: 'Org', authMethod: 'claude.ai' } })).toEqual([['plan', 'max'], ['organization', 'Org'], ['sign-in', 'claude.ai']]);
  });

  it('the overview shows one usage source of several (issue #85): the chosen one while it reports, else the first', () => {
    const sources = [{ name: 'work' }, { name: 'personal' }];
    expect(shownSource(sources, 'personal')).toBe('personal');
    expect(shownSource(sources, undefined)).toBe('work');
    expect(shownSource(sources, 'gone')).toBe('work');
    expect(shownSource([], 'work')).toBeUndefined();
  });
});
