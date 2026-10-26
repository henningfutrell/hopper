// @vitest-environment happy-dom
// Report a bug (issue #694), the form rendered against a fake of the daemon's HTTP: it fills in the context the daemon
// answers, for the person to read and edit; Send stays off until there is a title and what happened; a similar open
// report is offered first, and the person adds theirs to it, or files a new one; after filing it shows the link. When
// GitHub cannot take it now, it says the hopper keeps it and sends it later, and where to see it.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type El = ReturnType<typeof createElement>;
let root: Root | undefined;
let posts: { path: string; body: Record<string, unknown> }[] = [];
let answers: unknown[] = [];

async function render(props: { jobId?: string } = {}) {
  posts = [];
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    posts.push({ path: String(path), body });
    if (path === '/ui/api/bug-reports/context') return json({ context: '- System: linux 6.18.2 (x64), Node v24.3.0', repo: 'henningfutrell/hopper' });
    return json(answers.shift());
  }));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const view = '../../ui/src/app/bug-report.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { BugReportDialog } = (await import(view)) as { BugReportDialog: (p: { jobId?: string; onClose: () => void }) => El };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(BugReportDialog, { ...props, onClose: () => undefined })); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const field = (label: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
const button = (text: RegExp) => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''));
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const click = async (b: HTMLButtonElement | undefined) => {
  expect(b).toBeDefined();
  await act(async () => { b!.click(); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Report a bug', () => {
  it('fills in the context for the job, editable, and sends nothing without a title and what happened', async () => {
    await render({ jobId: 'job-1' });
    expect(posts[0]).toEqual({ path: '/ui/api/bug-reports/context', body: {} });
    expect(field('Context').value).toBe('- System: linux 6.18.2 (x64), Node v24.3.0');
    expect(button(/Send report/)?.disabled).toBe(true);
    await type(field('Title'), 'Board hangs');
    expect(button(/Send report/)?.disabled).toBe(true);
    await type(field('What happened'), 'It stopped.');
    expect(button(/Send report/)?.disabled).toBe(false);
  });

  it('sends the report with the edited context, and shows the link', async () => {
    answers = [{ kind: 'filed', number: 12, url: 'https://github.com/henningfutrell/hopper/issues/12' }];
    await render({ jobId: 'job-1' });
    await type(field('Title'), 'Board hangs');
    await type(field('What happened'), 'It stopped.');
    await type(field('Context'), '- System: linux');
    await click(button(/Send report/));
    expect(posts.at(-1)).toEqual({ path: '/ui/api/bug-reports', body: { title: 'Board hangs', happened: 'It stopped.', expected: '', context: '- System: linux', jobId: 'job-1', key: expect.stringMatching(/^ui-[0-9a-f]{32}$/) } });
    const sent = document.querySelector('[data-slot="bug-report-sent"]')!;
    expect(sent.textContent).toContain('Report filed as issue #12.');
    expect(sent.querySelector('a')?.getAttribute('href')).toBe('https://github.com/henningfutrell/hopper/issues/12');
  });

  it('offers a similar open report first: add yours to it, or file a new one', async () => {
    answers = [
      { kind: 'similar', similar: [{ number: 5, title: 'Board hangs after a failure', url: 'https://github.com/henningfutrell/hopper/issues/5' }] },
      { kind: 'commented', number: 5, url: 'https://github.com/henningfutrell/hopper/issues/5#issuecomment-1' },
    ];
    await render();
    await type(field('Title'), 'Board hangs');
    await type(field('What happened'), 'It stopped.');
    await click(button(/Send report/));
    expect(document.querySelector('[data-slot="bug-report-similar"]')?.textContent).toContain('#5 Board hangs after a failure');
    expect(button(/File a new report/)).toBeDefined();
    await click(button(/Add to #5/));
    expect(posts.at(-1)?.body).toMatchObject({ commentOn: 5 });
    expect(document.querySelector('[data-slot="bug-report-sent"]')?.textContent).toContain('Your report was added to issue #5.');
  });

  it('says the report is kept and sent later when GitHub cannot take it now', async () => {
    answers = [{ kind: 'kept', id: 'r1', problem: 'your GitHub is not connected: connect it in Sources → Connect GitHub' }];
    await render();
    await type(field('Title'), 'Board hangs');
    await type(field('What happened'), 'It stopped.');
    await click(button(/Send report/));
    const kept = document.querySelector('[data-slot="bug-report-kept"]')!;
    expect(kept.textContent).toContain('your GitHub is not connected');
    expect(kept.textContent).toContain('The hopper keeps your report and sends it later.');
    expect(kept.querySelector('a')?.getAttribute('href')).toBe('#reports');
    expect(button(/Done/)).toBeDefined();
  });
});
