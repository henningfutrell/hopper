// The nav groups (ui/src/model/nav-groups.ts, issue #906), pure: a collapsed nav group shows its entries' badges as one —
// the counts summed, the high-priority ones summed, the most urgent colour — so no badge is hidden by the grouping; which
// groups are collapsed is read back from browser storage, never trusted.
import { describe, expect, it } from 'vitest';
import { badgeUrgency, groupBadges, mergedBadge, parseCollapsed, toggleCollapsed, type NavEntry } from '../../ui/src/model/nav-groups.ts';

const entry = (view: string, n: number, cls: string, o: Partial<NavEntry> = {}): NavEntry => ({ view, label: view, badge: { n, cls, title: `${n} wait` }, ...o });

describe('a merged page\'s badge (issue #2374)', () => {
  it('sums its tabs\' badges like a group, each tab\'s title as it is; no tab with a count is no badge', () => {
    expect(mergedBadge([{ n: 2, cls: 'bg-warn text-background', title: '2 access requests wait on you', high: 1 }, undefined, { n: 1, cls: 'bg-bad text-background', title: '1 deployment waits' }]))
      .toEqual({ n: 3, high: 1, cls: 'bg-bad text-background', title: '2 access requests wait on you; 1 deployment waits' });
    expect(mergedBadge([undefined, { n: 0, cls: 'bg-bad text-background' }])).toBeUndefined();
  });
});

describe('a nav group\'s badge', () => {
  it('sums its entries\' counts and their high-priority ones; the most urgent colour wins', () => {
    const g = groupBadges([
      entry('questions', 2, 'bg-question text-background', { badge: { n: 2, cls: 'bg-question text-background', title: '2 wait', high: 1 } }),
      entry('failures', 1, 'bg-bad text-background'),
      entry('parked', 3, 'bg-muted text-muted-foreground'),
    ]);
    expect(g.badge).toEqual({ n: 6, high: 1, cls: 'bg-bad text-background', title: 'questions: 2 wait; failures: 1 wait; parked: 3 wait' });
  });

  it('leaves out entries with no badge or a zero count; none at all is no badge', () => {
    expect(groupBadges([entry('a', 0, 'bg-bad text-background'), { view: 'b', label: 'b' }]).badge).toBeUndefined();
    expect(groupBadges([entry('a', 0, 'bg-bad text-background'), entry('b', 4, 'bg-warn text-background')]).badge)
      .toEqual({ n: 4, cls: 'bg-warn text-background', title: 'b: 4 wait' });
  });

  it('sums the backburner counts on their own', () => {
    expect(groupBadges([{ view: 'a', label: 'a', backburner: 2 }, { view: 'b', label: 'b', backburner: 1 }])).toEqual({ backburner: 3 });
  });

  it('ranks the colours: bad over warn over question over the plain and the quiet ones', () => {
    const order = ['bg-bad text-background', 'bg-warn text-background', 'bg-question text-background', 'bg-foreground text-background', 'bg-muted text-muted-foreground'];
    const ranks = order.map(badgeUrgency);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
    expect(new Set(ranks).size).toBe(order.length);
  });

  it('every entry badge surfaces at its group: in the count, and at least as urgent', () => {
    const colours = ['bg-bad text-background', 'bg-warn text-background', 'bg-question text-background', 'bg-foreground text-background', 'bg-muted text-muted-foreground'];
    for (let seed = 1; seed < 200; seed++) {
      const entries = colours.map((cls, i) => entry(`v${i}`, (seed * (i + 3)) % 5, cls));
      const g = groupBadges(entries);
      for (const e of entries) {
        if (!e.badge || e.badge.n === 0) continue;
        expect(g.badge!.n).toBeGreaterThanOrEqual(e.badge.n);
        expect(badgeUrgency(g.badge!.cls)).toBeGreaterThanOrEqual(badgeUrgency(e.badge.cls));
        expect(g.badge!.title).toContain(`${e.label}: ${e.badge.title}`);
      }
      expect(g.badge?.n ?? 0).toBe(entries.reduce((t, e) => t + (e.badge?.n ?? 0), 0));
    }
  });
});

describe('which nav groups are collapsed', () => {
  it('reads a list of group ids; anything else is none', () => {
    expect(parseCollapsed('["jobs","settings"]')).toEqual(['jobs', 'settings']);
    expect(parseCollapsed(null)).toEqual([]);
    expect(parseCollapsed('not json')).toEqual([]);
    expect(parseCollapsed('{"jobs":true}')).toEqual([]);
    expect(parseCollapsed('["jobs",3]')).toEqual(['jobs']);
  });

  it('a toggle collapses an open group and opens a collapsed one', () => {
    expect(toggleCollapsed([], 'jobs')).toEqual(['jobs']);
    expect(toggleCollapsed(['jobs', 'infra'], 'jobs')).toEqual(['infra']);
  });
});
