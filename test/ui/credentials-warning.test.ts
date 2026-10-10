// @vitest-environment happy-dom
// Issue #647: a running job whose credential files on its machine could not be rewritten with its connection's new
// token says so on its card, with why; a job without the warning shows nothing.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';

const job = (o: Partial<Job> = {}): Job => ({
  id: 'j1', spec: { executor: 'test', payload: {} }, priority: 50, status: 'running', approved: false, attempts: 1,
  createdAt: '2026-10-09T18:00:00.000Z', updatedAt: '2026-10-09T18:00:00.000Z', ...o,
} as Job);

let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; });

async function render(j: Job): Promise<Element> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const path = '../../ui/src/components/job.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { CredentialsFlag } = (await import(path)) as { CredentialsFlag: (p: { job: Job }) => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(CredentialsFlag, { job: j })); });
  return document.getElementById('root')!;
}

describe('the job card\'s credentials warning (#647)', () => {
  it('says the job\'s GitHub token could not be renewed on its machine, and why', async () => {
    const el = await render(job({ credentialsWarning: 'the machine refused the write' }));
    const flag = el.querySelector('[data-credentials-warning]');
    expect(flag?.textContent).toBe('Its GitHub token could not be renewed on its machine: the machine refused the write');
  });

  it('shows nothing without the warning', async () => {
    const el = await render(job());
    expect(el.querySelector('[data-credentials-warning]')).toBeNull();
  });
});
