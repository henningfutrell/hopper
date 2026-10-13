// Issue #935: the job page's model — the parts list filtered by group, status and text; what waits on the person; the
// job's own graph laid out from the job through each group to its parts; the edges of the Jobs graph read as sentences.
import { describe, expect, it } from 'vitest';
import { jobBom } from '../../src/domain/job-bom.ts';
import type { Job, Question } from '../../src/domain/types.ts';
import { bomRows, BOM_GROUP_TEXT, layoutBom, NO_BOM_FILTER, waitingParts } from '../../ui/src/model/job-bom.ts';
import { EDGE_TEXT } from '../../ui/src/model/jobs-view.ts';

const ISSUE = 'https://github.com/acme/app/issues/7';
const PR = 'https://github.com/acme/app/pull/12';
const job = {
  id: 'j1', spec: { executor: 'test', payload: {}, goal: 'Make the cache faster' }, priority: 50, status: 'waiting_answer', approved: true, attempts: 1,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T01:00:00.000Z', questionId: 'q1', laneId: 'm1/lane-1',
  source: { source: 'github', kind: 'issue', key: ISSUE, url: ISSUE, repo: 'acme/app', number: 7, title: 'Make the cache faster' },
  sourceState: { source: { pullRequest: PR, follow: 'open', seen: { checks: 'failing' } } },
} as unknown as Job;
const question = { id: 'q1', jobId: 'j1', text: 'Which store?', status: 'open', tier: 'human', attempts: [], createdAt: '2026-10-01T00:30:00.000Z' } as unknown as Question;
const bom = jobBom({ job, events: [], questions: [question], artifacts: [], related: [], now: '2026-10-01T02:00:00.000Z' });

describe('bomRows', () => {
  it('lists every part with no filter, what waits on the person first', () => {
    expect(bomRows(bom, NO_BOM_FILTER)).toEqual(bom.parts);
    expect(bomRows(bom, NO_BOM_FILTER)[0]!.id).toBe('question:q1');
  });

  it('filters by group, by status and by text in its label or detail', () => {
    expect(bomRows(bom, { ...NO_BOM_FILTER, group: 'code' }).every((p) => p.group === 'code')).toBe(true);
    expect(bomRows(bom, { ...NO_BOM_FILTER, status: 'waiting_on_you' }).map((p) => p.id)).toEqual(['question:q1']);
    expect(bomRows(bom, { ...NO_BOM_FILTER, text: 'FAILING' }).map((p) => p.id)).toEqual(['checks']);
  });
});

describe('waitingParts', () => {
  it('pins the parts that wait on the person', () => {
    expect(waitingParts(bom).map((p) => p.id)).toEqual(['question:q1']);
  });
});

describe('layoutBom', () => {
  it('places the job, a node per group it has, and every part', () => {
    const layout = layoutBom(bom);
    const ids = layout.placed.map((p) => p.id);
    expect(ids).toContain('job');
    for (const g of new Set(bom.parts.map((p) => p.group))) expect(ids).toContain(`group:${g}`);
    for (const p of bom.parts) expect(ids).toContain(`part:${p.id}`);
    expect(layout.placed.find((p) => p.id === 'job')!.x).toBe(0);
    expect(layout.links.length).toBe(layout.placed.length - 1);
  });

  it('names each group in plain words', () => {
    expect(BOM_GROUP_TEXT.asked).toBe('What was asked');
    expect(BOM_GROUP_TEXT.machines).toBe('Machines and sandboxes');
  });
});

describe('EDGE_TEXT', () => {
  it('reads each edge as a sentence, and says blocks only where something blocks', () => {
    expect(EDGE_TEXT.works).toBe('is being worked on by');
    expect(EDGE_TEXT.opened).toBe('produced');
    expect(EDGE_TEXT.blocked_by).toBe('needs this first:');
    expect(EDGE_TEXT.asks).toBe('is waiting on your answer to');
    expect(Object.entries(EDGE_TEXT).filter(([, t]) => t.includes('block')).map(([k]) => k)).toEqual([]);
  });
});
