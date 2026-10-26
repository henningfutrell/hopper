// @vitest-environment happy-dom
// Report a bug (issue #694), the form rendered against a fake of the daemon's HTTP: it shows the public warning first
// (issue #2818), and the context the daemon answers, read-only; Review stays off until there is a title and a description,
// and while public bug reports are off; Review shows the report as it would be posted, and only Send posts it; a similar
// open report is offered first, and the person adds theirs to it, or files a new one; after filing it shows the link.
// When GitHub cannot take it now, it says the hopper keeps it and sends it later, and where to see it.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type El = ReturnType<typeof createElement>;
let root: Root | undefined;
let posts: { path: string; body: Record<string, unknown> }[] = [];
let answers: unknown[] = [];

const WARNING = 'This report will be posted publicly on GitHub. Do not include names, emails, customer or company details, repository or host names, links, ids or file paths.';
const PREVIEW = { title: 'Board hangs', body: '### Description\n\nIt stopped.\n\n### System\n\n- OS: linux 6.18.2 (x64)\n- Hopper version: 0.42.1\n\n---\nFiled with Report a bug in a hopper.', removed: ['email address'] };

async function render(props: { jobId?: string } = {}, on = true) {
  posts = [];
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    posts.push({ path: String(path), body });
    if (path === '/ui/api/bug-reports/context') return json({ context: '- OS: linux 6.18.2 (x64)\n- Hopper version: 0.42.1', repo: 'henningfutrell/hopper', warning: WARNING, on });
    if (path === '/ui/api/bug-reports/preview') return json(PREVIEW);
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

/** A title and a description typed, then Review. */
async function fillAndReview() {
  await type(field('Title'), 'Board hangs');
  await type(field('Description'), 'It stopped.');
  await click(button(/Review report/));
}

describe('Report a bug', () => {
  it('shows the public warning and the context, read-only, and reviews nothing without a title and a description', async () => {
    await render({ jobId: 'job-1' });
    expect(posts[0]).toEqual({ path: '/ui/api/bug-reports/context', body: {} });
    expect(document.querySelector('[data-slot="bug-report-warning"]')?.textContent).toBe(WARNING);
    expect(document.querySelector('[data-slot="bug-report-context"]')?.textContent).toBe('- OS: linux 6.18.2 (x64)\n- Hopper version: 0.42.1');
    expect(document.querySelector('[aria-label="Context"]')).toBeNull();
    expect(button(/Review report/)?.disabled).toBe(true);
    await type(field('Title'), 'Board hangs');
    expect(button(/Review report/)?.disabled).toBe(true);
    await type(field('Description'), 'It stopped.');
    expect(button(/Review report/)?.disabled).toBe(false);
  });

  it('reviews nothing while public bug reports are off, and says so (issue #2818)', async () => {
    await render({}, false);
    expect(document.querySelector('[data-slot="bug-report-off"]')?.textContent).toContain('Public bug reports are off');
    await type(field('Title'), 'Board hangs');
    await type(field('Description'), 'It stopped.');
    expect(button(/Review report/)?.disabled).toBe(true);
  });

  it('shows the report as it would be posted, and posts it only on Send, then shows the link', async () => {
    answers = [{ kind: 'filed', number: 12, url: 'https://github.com/henningfutrell/hopper/issues/12' }];
    await render({ jobId: 'job-1' });
    await fillAndReview();
    expect(posts.at(-1)).toEqual({ path: '/ui/api/bug-reports/preview', body: { title: 'Board hangs', description: 'It stopped.' } });
    const review = document.querySelector('[data-slot="bug-report-review"]')!;
    expect(review.querySelector('[data-slot="bug-report-review-body"]')?.textContent).toBe(PREVIEW.body);
    expect(review.textContent).toContain('Removed before sending: email address');
    expect(posts.some((p) => p.path === '/ui/api/bug-reports')).toBe(false);
    await click(button(/Send report/));
    expect(posts.at(-1)).toEqual({ path: '/ui/api/bug-reports', body: { title: 'Board hangs', description: 'It stopped.', jobId: 'job-1', key: expect.stringMatching(/^ui-[0-9a-f]{32}$/) } });
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
    await fillAndReview();
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
    await fillAndReview();
    await click(button(/Send report/));
    const kept = document.querySelector('[data-slot="bug-report-kept"]')!;
    expect(kept.textContent).toContain('your GitHub is not connected');
    expect(kept.textContent).toContain('The hopper keeps your report and sends it later.');
    expect(kept.querySelector('a')?.getAttribute('href')).toBe('#reports');
    expect(button(/Done/)).toBeDefined();
  });

  it('shows the daemon\'s warning word for word', async () => {
    const { PUBLIC_REPORT_WARNING } = await import('../../src/bug-reports/context.ts');
    const ui = '../../ui/src/model/bug-report.ts';
    expect(((await import(ui)) as { PUBLIC_REPORT_WARNING: string }).PUBLIC_REPORT_WARNING).toBe(PUBLIC_REPORT_WARNING);
    expect(WARNING).toBe(PUBLIC_REPORT_WARNING);
  });
});
