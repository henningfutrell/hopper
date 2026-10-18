// The origin acts on a job's view (issue #655, part 14): who wrote, labelled and assigned its item, through which app,
// and whether a trusted actor did each, in plain words. The daemon reads them at intake; the UI only says them.
import { describe, expect, it } from 'vitest';
import { originActLines } from '../../ui/src/model/trust.ts';

describe('originActLines', () => {
  it('says each act, by whom, through which app, and whether it counts', () => {
    expect(originActLines({ source: { source: 'github', kind: 'github-account', key: 'k', originActs: [
      { role: 'author', login: 'stranger', trusted: false },
      { role: 'labelled', login: 'ada', app: 'cursor', trusted: false },
      { role: 'assigned', login: 'ada', id: 7, trusted: true },
      { role: 'edited', trusted: false },
    ] } })).toEqual([
      { text: 'written by stranger', trusted: false },
      { text: 'labelled by ada through cursor', trusted: false },
      { text: 'assigned by ada', trusted: true },
      { text: 'who edited it is not known', trusted: false },
    ]);
  });

  it('a job with no origin acts: none', () => {
    expect(originActLines({ source: { source: 'manual', kind: 'manual', key: 'k' } })).toEqual([]);
    expect(originActLines({})).toEqual([]);
  });
});
