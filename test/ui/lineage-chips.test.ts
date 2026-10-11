// @vitest-environment happy-dom
// Issue lineage on the job card (issue #729), rendered: a job's title shows the parent its issue is a child of, and its
// children with how many are required; on hover, each child and the count of all descendants. No lineage, no chip.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { lineageLinks, type LineageLink } from '../../ui/src/model/lineage.ts';

// Browser code, type-checked by ui/tsconfig.json: imported by path.
const card = '../../ui/src/components/job.tsx';
const store = '../../ui/src/store/lineage.ts';
const { JobTitle } = (await import(card)) as { JobTitle: (p: { job: Job }) => ReturnType<typeof createElement> };
const { useLineage } = (await import(store)) as { useLineage: { setState(s: { links: LineageLink[] }): void } };

const job = (number: number): Job => ({
  id: `j${number}`, spec: { executor: 'test', payload: {}, goal: `goal ${number}` }, priority: 50, status: 'queued', approved: false, attempts: 0,
  createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z',
  source: { source: 'github', kind: 'issue', key: `https://github.com/o/r/issues/${number}`, url: `https://github.com/o/r/issues/${number}`, repo: 'o/r', number },
} as Job);

let seq = 0;
const filed = (parent: number, child: number, required: boolean) => ({
  seq: ++seq, id: `e${seq}`, schemaVersion: 1, type: 'job.child_issue_filed' as const, at: '2026-10-11T00:00:00.000Z',
  data: { requestId: 'r', parent: { repo: 'o/r', number: parent }, child: { repo: 'o/r', number: child, url: `https://github.com/o/r/issues/${child}` }, required },
});

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; useLineage.setState({ links: [] }); });

function render(j: Job): HTMLElement {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const el = document.getElementById('root')!;
  root = createRoot(el);
  act(() => root!.render(createElement(JobTitle, { job: j })));
  return el;
}

describe('the job card\'s issue lineage', () => {
  it('a parent: its children, how many are required, and each child and the descendants on hover', () => {
    useLineage.setState({ links: lineageLinks([filed(7, 8, true), filed(7, 9, false), filed(8, 10, false)]) });
    const chip = render(job(7)).querySelector('[data-lineage-children]')!;
    expect(chip.textContent).toBe('children 2, 1 required');
    expect(chip.getAttribute('title')).toBe('Children of its issue:\n#8 (required)\n#9 (follow-up)\nDescendants in all: 3');
  });

  it('a child: its parent, linked, as a required child or a follow-up', () => {
    useLineage.setState({ links: lineageLinks([filed(7, 8, true), filed(7, 9, false)]) });
    const required = render(job(8)).querySelector('[data-lineage-parent]')!;
    expect(required.textContent).toBe('required by #7');
    expect(required.closest('a')!.getAttribute('href')).toBe('https://github.com/o/r/issues/7');
    act(() => root!.render(createElement(JobTitle, { job: job(9) })));
    expect(document.querySelector('[data-lineage-parent]')!.textContent).toBe('child of #7');
  });

  it('no recorded lineage: no chip', () => {
    const el = render(job(1));
    expect(el.querySelector('[data-lineage-parent], [data-lineage-children]')).toBeNull();
  });
});
