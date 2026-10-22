// @vitest-environment happy-dom
// Issue #2354: a list that is the page scrolls with the page. Its panel is no list box (issue #84: a body of one height
// bound that scrolls past it), so the page has one scrollbar. The bounded box stays on the Dashboard and the Queue,
// where a list shares the screen with others.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { T0, at, boot, handoff, unmount, view } from './failures-view-harness.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(T0);
});

afterEach(async () => {
  await unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const kept = { jobId: 'j7', paths: ['/w/.worktrees/@scratch/j7/repo'], at: at(-10), status: 'failed', machineId: 'desk', actions: { push: { ok: true }, discard: { ok: true } } };
const stuck = [{ cause: 'own_wait', ids: ['j4'], what: 'Jobs stuck on their own wait, past its deadline', todo: 'End its wait or cancel it, on the job.' }];

describe('a page whose panels are its lists', () => {
  // The Failures page's own lists (Needs a person, Ended, Recent failures) leave their list boxes with issue #2353.
  it('the Failures page: Stuck and Work not pushed are no list box, so the page scrolls them', async () => {
    await boot('#failures', { failures: view({ handoffs: [handoff()], keptWork: [kept], stuck }) });
    const body = (title: string) => [...document.querySelectorAll<HTMLElement>('[data-slot="panel-body"]')].find((b) => b.previousElementSibling?.textContent?.startsWith(title));
    for (const title of ['Stuck', 'Work not pushed']) {
      expect(body(title), title).toBeDefined();
      expect(body(title)!.dataset.listBox, title).toBeUndefined();
    }
  });

  // These pages read views a fake daemon here does not serve; their panels are checked in their source.
  const panelTags = (file: string) => [...readFileSync(resolve('ui/src/views', file), 'utf8').matchAll(/<Panel\b[^>]*>/g)].map((m) => m[0]);
  const isListBox = (tag: string) => /\slist(\s|>|$)/.test(tag);

  it.each(['parked.tsx', 'artifacts.tsx', 'minor-decisions.tsx', 'infra.tsx', 'stuck.tsx', 'kept-work.tsx'])('%s: no panel is a list box', (file) => {
    const tags = panelTags(file);
    expect(tags.length, file).toBeGreaterThan(0);
    expect(tags.filter(isListBox), file).toEqual([]);
  });

  it.each(['queue.tsx', 'dashboard/queue.tsx'])('%s keeps its bounded list boxes', (file) => {
    expect(panelTags(file).filter(isListBox).length, file).toBeGreaterThan(0);
  });
});
