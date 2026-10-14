// Issue #83: the viewer dismisses a notice — an Attention item or the update notice — and this
// browser keeps it dismissed. Each notice key names one occurrence; a condition seen cleared is
// forgotten, so the next occurrence shows again. The model is pure; what a browser stored never throws.
import { describe, expect, it } from 'vitest';
import type { SourceStatus } from '../../src/domain/types.ts';
import { DISMISSED_CAP, dismiss, forgetCleared, noticeKey, parseDismissed } from '../../ui/src/model/dismissed.ts';

const health = (fallback: boolean) => ({ ok: true, version: '0', router: 'jev', fallback, executors: [], uptimeS: 1 });
const source = (name: string, state: 'ok' | 'error', lastError?: string): SourceStatus =>
  ({ name, kind: 'github', state, itemsSeen: 0, jobsCreated: 0, activeJobs: 0, detail: {}, ...(lastError ? { lastError } : {}) });

describe('parseDismissed', () => {
  it('nothing stored, or not a list of keys: nothing dismissed', () => {
    expect(parseDismissed(null)).toEqual([]);
    expect(parseDismissed('not json')).toEqual([]);
    expect(parseDismissed('{"a":1}')).toEqual([]);
  });

  it('keeps the stored keys, drops what is not a key', () => {
    expect(parseDismissed(JSON.stringify(['question:q1', 3, null, 'failed:j1']))).toEqual(['question:q1', 'failed:j1']);
  });
});

describe('dismiss', () => {
  it('adds a key once', () => {
    expect(dismiss(dismiss([], 'question:q1'), 'question:q1')).toEqual(['question:q1']);
  });

  it('keeps the newest keys only', () => {
    let list: string[] = [];
    for (let i = 0; i <= DISMISSED_CAP; i++) list = dismiss(list, `failed:j${i}`);
    expect(list).toHaveLength(DISMISSED_CAP);
    expect(list[0]).toBe('failed:j1');
    expect(list.at(-1)).toBe(`failed:j${DISMISSED_CAP}`);
  });
});

describe('noticeKey', () => {
  it('a machine\'s low disk is one occurrence per machine, not per byte (issue #401)', () => {
    expect(noticeKey.disk('desk')).toBe(noticeKey.disk('desk'));
    expect(noticeKey.disk('desk')).not.toBe(noticeKey.disk('laptop'));
  });

  it('a source error is one occurrence per error text', () => {
    expect(noticeKey.source(source('gh', 'error', 'HTTP 401'))).not.toBe(noticeKey.source(source('gh', 'error', 'HTTP 500')));
  });

  it('the update notice is one occurrence per state and target', () => {
    const base = { channel: 'stable' as const, autoUpdate: false, whatsNew: [], installedWhatsNew: [], restartBlockers: 0 };
    const a = noticeKey.update({ ...base, state: 'available', target: { commit: 'a', ref: 'stable' } });
    expect(noticeKey.update({ ...base, state: 'available', target: { commit: 'b', ref: 'stable' } })).not.toBe(a);
    expect(noticeKey.update({ ...base, state: 'error', reason: 'fetch failed' })).not.toBe(a);
  });
});

describe('forgetCleared', () => {
  const list = [noticeKey.router(health(true)), noticeKey.source(source('gh', 'error', 'HTTP 401')), noticeKey.source(source('app', 'error', 'x')), 'question:q1', 'update:available:a'];

  it('a condition still present stays dismissed', () => {
    expect(forgetCleared(list, { health: health(true), sources: [source('gh', 'error', 'HTTP 401'), source('app', 'error', 'x')], update: null })).toEqual(list);
  });

  it('the router answering again, a source syncing again, no update notice: forgotten, so a recurrence shows', () => {
    const upToDate = { state: 'current' as const, channel: 'stable' as const, autoUpdate: false, whatsNew: [], installedWhatsNew: [], restartBlockers: 0 };
    expect(forgetCleared(list, { health: health(false), sources: [source('gh', 'ok'), source('app', 'error', 'x')], update: upToDate }))
      .toEqual([noticeKey.source(source('app', 'error', 'x')), 'question:q1']);
  });

  it('nothing known yet forgets nothing', () => {
    expect(forgetCleared(list, { health: null, sources: [], update: null })).toEqual(list);
  });
});
