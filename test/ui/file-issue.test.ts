// @vitest-environment happy-dom
// File an issue (issue #471), the button and the dialog rendered against a fake of the daemon's HTTP: the button is hidden
// from a viewer and off, with the reason, while no provider can draft; a draft can be cancelled mid-run, and a timeout
// says so plainly — both keep the person's text; the draft is editable; nothing is filed before the confirm step's
// Confirm, which a refusal of the edited text keeps off; the confirm step shows no labels and no assignee.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type El = ReturnType<typeof createElement>;
let root: Root | undefined;
let posts: { path: string; body: Record<string, unknown> }[] = [];

const REPO = 'octo-org/ops';
const USABLE = { provider: 'claude', available: true, usable: true, repos: [REPO] };
const DRAFT = { repo: REPO, title: 'Queue stalls', body: '## Summary\nThe queue stalls.', notes: 'Rephrased the text.', findings: [], provider: 'claude', model: 'claude-sonnet-5-5', skill: 'file-issue@3f2a9c1e7b4d5a60' };
const CHECK = { repo: REPO, visibility: 'private', title: 'Queue stalls', body: '## Summary\nThe queue stalls.\n\n---\nnote', labels: [], assignees: [], findings: [] };

type Reply = Response | ((signal: AbortSignal | undefined) => Promise<Response>);
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

async function render(o: { role?: string; status?: unknown; replies?: Record<string, Reply[]>; dialog?: boolean } = {}) {
  posts = [];
  const replies = o.replies ?? {};
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    if ((init.method ?? 'GET') === 'GET') return json(o.status ?? USABLE);
    posts.push({ path: String(path), body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    const r = replies[String(path)]?.shift();
    if (!r) return json({ error: `no reply for ${path}` }, 500);
    return typeof r === 'function' ? r(init.signal ?? undefined) : r;
  }));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const store = '../../ui/src/store/index.ts';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: Record<string, unknown>): void } };
  useHopper.setState({ authed: true, user: { id: 'u1', name: 'ada', role: o.role ?? 'operator', realm: 'local', identity: 'ada' } });
  const view = '../../ui/src/app/file-issue.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { FileIssueButton } = (await import(view)) as { FileIssueButton: (p: { jobId?: string }) => El };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(FileIssueButton, {})); });
  await settle();
}

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const field = (label: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
const button = (text: RegExp) => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '') || text.test(b.getAttribute('aria-label') ?? ''));
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
  await settle();
};
/** Open the dialog and describe the issue. */
async function describeIt(text = 'The queue stalls after a restart.') {
  await click(document.querySelector<HTMLButtonElement>('[data-slot="file-issue-button"]')!);
  await type(field('What is the issue'), text);
}
const filedPosts = () => posts.filter((p) => p.path === '/ui/api/issue-drafts');

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('File an issue', () => {
  it('is hidden from a viewer', async () => {
    await render({ role: 'viewer' });
    expect(document.querySelector('[data-slot="file-issue-button"]')).toBeNull();
  });

  it('is off, with the reason, while no provider can draft', async () => {
    await render({ status: { provider: 'claude', available: false, usable: false, reason: 'Claude is not installed', repos: [REPO] } });
    const b = document.querySelector<HTMLButtonElement>('[data-slot="file-issue-button"]')!;
    expect(b.disabled).toBe(true);
    expect(b.title).toContain('Claude is not installed');
  });

  it('shows what is sent, exactly, before the draft', async () => {
    await render({ replies: { '/ui/api/issue-drafts/prompt': [json({ prompt: 'You draft one GitHub issue…\nThe queue stalls after a restart.' })] } });
    await describeIt();
    await click(button(/Show what is sent/));
    expect(posts.at(-1)).toEqual({ path: '/ui/api/issue-drafts/prompt', body: { repo: REPO, text: 'The queue stalls after a restart.' } });
    expect(document.querySelector('[data-slot="file-issue-prompt"]')?.textContent).toContain('The queue stalls after a restart.');
  });

  it('cancels a draft mid-run: the request is aborted, the text kept, nothing filed', async () => {
    let aborted = false;
    const hangs = (signal: AbortSignal | undefined) => new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
    });
    await render({ replies: { '/ui/api/issue-drafts/draft': [hangs] } });
    await describeIt();
    await click(button(/Draft with Claude/));
    expect(document.querySelector('[data-slot="file-issue-drafting"]')).not.toBeNull();
    await click(button(/^Cancel$/));
    expect(aborted).toBe(true);
    expect(field('What is the issue').value).toBe('The queue stalls after a restart.');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(filedPosts()).toEqual([]);
  });

  it('a provider timeout says so plainly, and keeps the text', async () => {
    await render({ replies: { '/ui/api/issue-drafts/draft': [json({ error: 'claude gave no draft in 180 s. Your text is kept: try again' }, 504)] } });
    await describeIt();
    await click(button(/Draft with Claude/));
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/gave no draft in 180 s/);
    expect(field('What is the issue').value).toBe('The queue stalls after a restart.');
    expect(filedPosts()).toEqual([]);
  });

  it('files the edited draft only after the confirm step, with no labels and no assignee', async () => {
    await render({
      replies: {
        '/ui/api/issue-drafts/draft': [json(DRAFT)],
        '/ui/api/issue-drafts/check': [json(CHECK)],
        '/ui/api/issue-drafts': [json({ repo: REPO, number: 13, url: 'https://github.com/octo-org/ops/issues/13' })],
      },
    });
    await describeIt();
    await click(button(/Draft with Claude/));
    expect(field('Title').value).toBe('Queue stalls');
    expect(document.querySelector('[data-slot="file-issue-notes"]')?.textContent).toContain('Rephrased the text.');
    await type(field('Title'), 'Queue stalls after a restart');
    await click(button(/Review and file/));
    expect(posts.at(-1)).toEqual({ path: '/ui/api/issue-drafts/check', body: { repo: REPO, title: 'Queue stalls after a restart', body: DRAFT.body } });
    expect(filedPosts()).toEqual([]);
    const confirm = document.querySelector('[data-slot="file-issue-confirm"]')!.textContent ?? '';
    expect(confirm).toContain('Labelsnone');
    expect(confirm).toContain('none: it starts no job');
    await click(button(/Confirm and file/));
    expect(filedPosts()).toEqual([{ path: '/ui/api/issue-drafts', body: { repo: REPO, title: 'Queue stalls after a restart', body: DRAFT.body, confirmed: true, key: expect.stringMatching(/^ui-[0-9a-f]{32}$/) } }]);
    expect(document.querySelector('[data-slot="file-issue-filed"] a')?.getAttribute('href')).toBe('https://github.com/octo-org/ops/issues/13');
  });

  it('keeps Confirm off when the edited text holds a blocked value', async () => {
    await render({
      replies: {
        '/ui/api/issue-drafts/draft': [json(DRAFT)],
        '/ui/api/issue-drafts/check': [json({ ...CHECK, findings: [{ constraint: 'no-secret', what: 'it holds a secret: a token or a key' }], refusal: 'the text cannot be filed: it holds a secret: a token or a key. Change it' })],
      },
    });
    await describeIt();
    await click(button(/Draft with Claude/));
    await type(field('Body'), `${DRAFT.body}\nghp_${'a'.repeat(36)}`);
    await click(button(/Review and file/));
    expect(document.querySelector('[data-slot="file-issue-refusal"]')?.textContent).toMatch(/secret/);
    expect(button(/Confirm and file/)?.disabled).toBe(true);
    expect(filedPosts()).toEqual([]);
  });
});
