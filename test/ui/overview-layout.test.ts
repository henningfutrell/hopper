// Issue #73: the overview layout — which overview panels show, in what order, how wide, and each
// panel's settings — is the viewer's, kept per browser. The model is pure; reading what a browser
// stored never throws and never loses a panel.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT, PANEL_IDS, movePanel, parseLayout, placePanel, setPanel, setSetting,
} from '../../ui/src/model/overview-layout.ts';

const ids = (l = DEFAULT_LAYOUT) => l.panels.map((p) => p.id);

describe('parseLayout', () => {
  it('nothing stored, or something that is not a layout: the default layout', () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('not json')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('[1,2]')).toEqual(DEFAULT_LAYOUT);
  });

  it('the default shows every panel once', () => {
    expect([...ids()].sort()).toEqual([...PANEL_IDS].sort());
    expect(DEFAULT_LAYOUT.panels.every((p) => p.shown)).toBe(true);
  });

  it('keeps the stored order, visibility, widths and settings', () => {
    const stored = setSetting(setPanel(movePanel(DEFAULT_LAYOUT, 'usage', -1), 'live', { shown: false, width: 1 }), 'liveEvents', 5);
    expect(parseLayout(JSON.stringify(stored))).toEqual(stored);
  });

  it('drops a panel it does not know, adds a panel missing from the stored layout at the end, shown', () => {
    const stored = { panels: [{ id: 'gone', shown: true, width: 1 }, ...DEFAULT_LAYOUT.panels.filter((p) => p.id !== 'live').reverse()], settings: DEFAULT_LAYOUT.settings };
    const l = parseLayout(JSON.stringify(stored));
    expect(ids(l)).toEqual([...ids().filter((id) => id !== 'live').reverse(), 'live']);
    expect(l.panels.at(-1)).toEqual(DEFAULT_LAYOUT.panels.find((p) => p.id === 'live'));
  });

  it('a field it cannot use takes its default; the rest of the layout stands', () => {
    const stored = {
      panels: DEFAULT_LAYOUT.panels.map((p) => p.id === 'ended' ? { id: 'ended', shown: 'no', width: 7 } : p.id === 'live' ? { ...p, shown: false } : p),
      settings: { timelineWindow: '3h', throughputHours: 12, liveEvents: -1 },
    };
    const l = parseLayout(JSON.stringify(stored));
    expect(l.panels.find((p) => p.id === 'ended')).toEqual(DEFAULT_LAYOUT.panels.find((p) => p.id === 'ended'));
    expect(l.panels.find((p) => p.id === 'live')?.shown).toBe(false);
    expect(l.settings).toEqual({ ...DEFAULT_LAYOUT.settings, throughputHours: 12 });
  });

  it('keeps the usage source chosen for the overview (issue #85); anything but a name is dropped', () => {
    expect(parseLayout(JSON.stringify({ panels: [], settings: { usageSource: 'personal' } })).settings.usageSource).toBe('personal');
    expect(parseLayout(JSON.stringify({ panels: [], settings: { usageSource: 3 } })).settings).toEqual(DEFAULT_LAYOUT.settings);
    expect(parseLayout(JSON.stringify({ panels: [], settings: { usageSource: '' } })).settings).toEqual(DEFAULT_LAYOUT.settings);
  });

  it('a panel stored twice counts once, where it first stands', () => {
    const stored = { panels: [DEFAULT_LAYOUT.panels[1], ...DEFAULT_LAYOUT.panels], settings: DEFAULT_LAYOUT.settings };
    expect(ids(parseLayout(JSON.stringify(stored)))).toEqual([ids()[1], ...ids().filter((_, i) => i !== 1)]);
  });
});

describe('movePanel', () => {
  it('swaps a panel with its neighbour; at either end it stays', () => {
    const [first, second] = ids();
    expect(ids(movePanel(DEFAULT_LAYOUT, second!, -1)).slice(0, 2)).toEqual([second, first]);
    expect(movePanel(DEFAULT_LAYOUT, first!, -1)).toEqual(DEFAULT_LAYOUT);
    expect(movePanel(DEFAULT_LAYOUT, ids().at(-1)!, 1)).toEqual(DEFAULT_LAYOUT);
  });
});

// Issue #86: the overview can be rearranged as seen fit — a panel dropped on another takes its place.
describe('placePanel', () => {
  it('a panel dropped on one before it goes in front of it; on one after it, behind it', () => {
    expect(ids(placePanel(DEFAULT_LAYOUT, 'live', 'kpis'))).toEqual(['live', ...ids().filter((id) => id !== 'live')]);
    expect(ids(placePanel(DEFAULT_LAYOUT, 'kpis', 'lanes'))).toEqual(['timeline', 'attention', 'lanes', 'kpis', 'waiting', 'ended', 'throughput', 'usage', 'usageHistory', 'live']);
  });

  it('keeps every panel once, with its visibility and width', () => {
    const hidden = setPanel(DEFAULT_LAYOUT, 'ended', { shown: false, width: 3 });
    const l = placePanel(hidden, 'usage', 'attention');
    expect([...ids(l)].sort()).toEqual([...PANEL_IDS].sort());
    expect(l.panels.find((p) => p.id === 'ended')).toEqual({ id: 'ended', shown: false, width: 3 });
  });

  it('dropped on itself, or on a panel the layout lacks: unchanged', () => {
    expect(placePanel(DEFAULT_LAYOUT, 'lanes', 'lanes')).toBe(DEFAULT_LAYOUT);
    expect(placePanel(DEFAULT_LAYOUT, 'lanes', 'gone' as never)).toBe(DEFAULT_LAYOUT);
  });
});
