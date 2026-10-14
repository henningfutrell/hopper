// Issue #1141: Tagged lists each GitHub source's tagged items; Needs you and the nav count them across the sources. A source
// that reads none (no connected account) is not shown.
import { describe, expect, it } from 'vitest';
import { readsTagged, taggedDismissed, taggedOf, taggedWaiting } from '../../ui/src/model/tagged.ts';
import type { SourceStatus } from '../../ui/src/model/wire.ts';

const item = (n: number) => ({ key: `https://github.com/o/r/pull/${n}`, repo: 'o/r', number: n, kind: 'pull', title: 'T', author: 'a', why: ['review'], createdAt: '', updatedAt: '' });
const source = (detail: Record<string, unknown>) => ({ name: 's', detail }) as unknown as SourceStatus;

describe('tagged items in the UI (issue #1141)', () => {
  it('counts the items across the sources that read them', () => {
    const sources = [source({ tagged: [item(1), item(2)], taggedDismissed: 1 }), source({ tagged: [item(3)] }), source({ intake: [] })];
    expect(sources.map(readsTagged)).toEqual([true, true, false]);
    expect(taggedWaiting(sources)).toBe(3);
    expect(taggedOf(sources[2]!)).toEqual([]);
    expect(sources.map(taggedDismissed)).toEqual([1, 0, 0]);
  });
});
