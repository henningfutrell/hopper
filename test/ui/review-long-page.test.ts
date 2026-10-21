// @vitest-environment happy-dom
// Questions, Proposals and Research as long pages (issue #2353, part 2): Cards or Rows; 6 cards or 30 one-line rows to a
// page, with the pager; a row opens its card in place; the mode is kept over a reload.
import { afterEach, describe, expect, it } from 'vitest';
import { all, boot, click, unmount } from './long-page-harness.ts';

afterEach(unmount);

const T0 = '2026-10-09T12:00:00.000Z';
const question = (i: number) => ({
  id: `q${i}`, jobId: `j${i}`, text: `Which branch for part ${i}?`, recentOutput: 'line', detectedBy: 'marker', status: 'open',
  tier: 'human', attempts: [], notifyCount: 1, createdAt: T0, updatedAt: T0,
});
const QUESTIONS = { '/api/questions': { questions: Array.from({ length: 40 }, (_, i) => question(i)) } };

const item = (kind: 'proposal' | 'research', i: number) => ({
  id: `${kind[0]}-${i}`, kind, jobId: `j${i}`, status: 'open', stage: 'human', levelRevisions: 0, priority: 50, high: false, createdAt: T0, updatedAt: T0,
  versions: [{ number: 1, text: `TL;DR: paint shed ${i}`, recentOutput: '', at: T0, missing: [], sections: { tldr: `paint shed ${i}` }, ...(kind === 'proposal' ? { paths: { paths: [] } } : {}) }],
  reviews: [],
});
const review = (kind: 'proposal' | 'research') => ({
  items: Array.from({ length: 10 }, (_, i) => item(kind, i)),
  settings: { reviewers: [], signOff: 'owner', levelRevisions: 1, levels: ['opus'] },
  type: { parts: [['tldr', 'TL;DR']], decisions: [{ id: 'accept', route: 'accept', label: 'Accept', effect: 'accept', notes: 'optional' }] },
});

const range = () => document.querySelector('[data-slot="pager-range"]')?.textContent;

describe('Questions as a long page (issue #2353)', () => {
  it('pages 40 open questions 6 cards to a page', async () => {
    await boot('#questions', QUESTIONS);
    expect(all('[data-question]')).toHaveLength(6);
    expect(range()).toBe('1–6 of 40');
    await click(document.querySelector('[data-slot="pager-more"]'));
    expect(range()).toBe('7–12 of 40');
  });

  it('in Rows shows 30 one-line rows, and a row opens its card in place', async () => {
    await boot('#questions', QUESTIONS);
    await click(document.querySelector('[data-slot="questions-mode-rows"]'));
    const rows = all('[data-slot="question-row"]');
    expect(rows).toHaveLength(30);
    expect(range()).toBe('1–30 of 40');
    expect(rows[0]!.textContent).toContain('Which branch for part 0?');
    expect(all('[data-question] [data-slot="question-text"]')).toHaveLength(0);
    await click(rows[1]);
    expect(rows[1]!.getAttribute('aria-expanded')).toBe('true');
    const opened = all('[data-question] [data-slot="question-text"]');
    expect(opened).toHaveLength(1);
    expect(opened[0]!.textContent).toContain('part 1');
  });

  it('keeps Rows over a reload', async () => {
    await boot('#questions', QUESTIONS);
    await click(document.querySelector('[data-slot="questions-mode-rows"]'));
    await unmount();
    await boot('#questions', QUESTIONS, true);
    expect(document.querySelector('[data-slot="questions-mode-rows"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(all('[data-slot="question-row"]')).toHaveLength(30);
  });
});

describe.each(['proposal', 'research'] as const)('%s as a long page (issue #2353)', (kind) => {
  const hash = kind === 'proposal' ? '#proposals' : '#research';
  const routes = { [kind === 'proposal' ? '/api/proposals' : '/api/research']: review(kind) };
  const mode = `${kind === 'proposal' ? 'proposals' : 'research'}-mode-rows`;

  it('pages 10 items 6 cards to a page', async () => {
    await boot(hash, routes);
    expect(all('[data-item]')).toHaveLength(6);
    expect(range()).toBe('1–6 of 10');
  });

  it('in Rows shows one line each, a row opens its card, and the mode is kept over a reload', async () => {
    await boot(hash, routes);
    await click(document.querySelector(`[data-slot="${mode}"]`));
    const rows = all('[data-slot="review-row"]');
    expect(rows).toHaveLength(10);
    expect(rows[2]!.textContent).toContain(`paint shed 2`);
    expect(document.querySelector('[data-item] [data-slot="card"]')).toBeNull();
    await click(rows[2]);
    expect(all('[data-item] [data-slot="card"]')).toHaveLength(1);
    await unmount();
    await boot(hash, routes, true);
    expect(all('[data-slot="review-row"]')).toHaveLength(10);
  });
});
