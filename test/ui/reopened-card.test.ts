// @vitest-environment happy-dom
// Issue #1126: a reopened card says why it is a request, links the item's earlier jobs and its pull request, and offers
// Approve. It names no acts: a person approves it whatever its origin.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { IntakeRequest } from '../../src/domain/intake-origin.ts';

const KEY = 'https://github.com/o/r/issues/1';
const PR = 'https://github.com/o/r/pull/9';

let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; });

async function render(request: IntakeRequest): Promise<Element> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const path = '../../ui/src/components/request-card.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { RequestCard } = (await import(path)) as { RequestCard: (p: { request: IntakeRequest; source: string; itemKey: string; canOperate: boolean }) => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(RequestCard, { request, source: 'github', itemKey: KEY, canOperate: true })); });
  return document.getElementById('root')!;
}

describe('a reopened card (issue #1126)', () => {
  it('links the earlier jobs and the pull request, names no acts, and offers Approve', async () => {
    const card = await render({
      hash: 'a'.repeat(64), title: 'Fix it', body: 'Still broken.', author: 'owner', actors: [], why: ['reopened after its job was done'],
      reopened: { jobs: [{ id: 'job-2-abcdefgh', status: 'finished' }, { id: 'job-1-abcdefgh', status: 'failed' }], pullRequest: PR },
    });
    expect(card.querySelector('[data-slot="request-why"]')!.textContent).toBe('reopened after its job was done');
    const history = card.querySelector('[data-slot="request-history"]')!;
    expect([...history.querySelectorAll('[data-job]')].map((a) => [a.getAttribute('href'), a.textContent])).toEqual([
      ['#job/job-2-abcdefgh', 'job-2-ab (finished)'], ['#job/job-1-abcdefgh', 'job-1-ab (failed)'],
    ]);
    expect(history.querySelector('[data-slot="request-pull-request"]')!.getAttribute('href')).toBe(PR);
    expect(card.querySelector('[data-slot="request-actors"]')).toBeNull();
    expect(card.querySelector('[data-slot="request-approve"]')!.textContent).toBe('Approve');
  });
});
