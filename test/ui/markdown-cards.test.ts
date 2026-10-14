// @vitest-environment happy-dom
// Cards render agent text as Markdown (issue #569), inside the whole app against a fake of the daemon's HTTP surface. A
// long question shows its summary — its first paragraph — and the rest behind Show all; opened, its list and code
// render, and the HTML and script in it show as text, never as elements. A long proposal shows its summary part (the
// Goal) and the other parts behind Show all; a short one shows whole. A reviewer's notes render as Markdown.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const T0 = '2026-10-10T12:00:00.000Z';
const QUESTION_TEXT = [
  '## Branch', '',
  'Which branch do I rebase the fix onto?', '',
  'The fix touches the release script. Both branches carry it.', '',
  '1. **`dev`**: the default branch.',
  '2. *`main`*: the release branch.', '',
  '<script>window.pwned = 1</script>', '',
  'Context <img src=x onerror="window.pwned = 2"> line.', '',
  '```sh', 'git rebase origin/dev', '```',
].join('\n');

const question = {
  id: 'q1', jobId: 'j1', text: QUESTION_TEXT, recentOutput: 'line', detectedBy: 'marker', status: 'open', tier: 'human',
  attempts: [], notifyCount: 1, createdAt: T0, updatedAt: T0,
};
const job = (id: string, extra: Record<string, unknown> = {}) => ({
  id, status: 'waiting_answer', priority: 50, attempts: 1, createdAt: T0, updatedAt: T0,
  spec: { executor: 'herdr-claude', payload: { prompt: 'Fix it' }, goal: `fix ${id}` }, ...extra,
});
const LONG_APPROACH = ['Two steps:', '', ...Array.from({ length: 10 }, (_, i) => `- step ${i + 1}: change \`file${i}.ts\``)].join('\n');
// A proposal is a set of paths (issue #651): its TL;DR and problem, and each path's full text, render as Markdown.
const proposal = (id: string, sections: Record<string, string>, pathText = 'Summary: one') => ({
  id: `p-${id}`, jobId: id, status: 'open', stage: 'human', levelRevisions: 0, priority: 50, high: false, createdAt: T0, updatedAt: T0,
  versions: [{
    number: 1, text: Object.entries(sections).map(([k, v]) => `${k}: ${v}`).join('\n'), recentOutput: '', at: T0, missing: [], sections,
    paths: { paths: [{ id: '1', title: 'Brush', summary: 'one', tradeoffs: {}, text: pathText, recommended: true }] },
  }],
  reviews: [{ version: 1, stage: 'opus', role: 'level', verdict: 'approve', notes: 'Sound. **One** risk:\n\n- rain', startedAt: T0, finishedAt: T0 }],
});
// A research report (issue #543): its parts, each rendered as Markdown.
const report = (id: string, sections: Record<string, string>) => ({
  id: `r-${id}`, kind: 'research', jobId: id, status: 'open', stage: 'human', levelRevisions: 0, priority: 50, high: false, createdAt: T0, updatedAt: T0,
  versions: [{ number: 1, text: Object.entries(sections).map(([k, v]) => `${k}: ${v}`).join('\n'), recentOutput: '', at: T0, missing: [], sections }],
  reviews: [],
});
const RESEARCH_TYPE = {
  parts: [['question', 'Question'], ['findings', 'Findings'], ['sources', 'Sources and evidence'], ['confidence', 'Confidence'], ['openThreads', 'Open threads'], ['nextStep', 'Next step']],
  decisions: [{ id: 'accept', route: 'accept', label: 'Accept', effect: 'accept', notes: 'optional' }],
};
const TYPE = {
  parts: [['tldr', 'TL;DR'], ['problem', 'Problem'], ['paths', 'Paths'], ['recommended', 'Recommended'], ['context', 'Context']],
  decisions: [{ id: 'accept', route: 'accept', label: 'Continue with selected', effect: 'accept', notes: 'optional' }],
};

function fakeDaemon(d: { questions: unknown[]; proposals: unknown[]; jobs: unknown[]; research?: unknown[] }) {
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: d.jobs, ended: [], locked: [] },
    '/api/machines': { machines: [] },
    '/api/decisions': { decisions: [] },
    '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] },
    '/api/webhooks/deliveries': { deliveries: [] },
    '/api/sources': { sources: [] },
    '/api/questions': { questions: d.questions },
    '/api/proposals': { items: d.proposals, settings: { reviewers: [], signOff: 'owner', levelRevisions: 1, levels: [] }, type: TYPE },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] },
    '/api/accounts': { accounts: [] },
    '/api/tldr': { enabled: true },
    '/api/research': { items: d.research ?? [], settings: { reviewers: [], signOff: 'owner', levelRevisions: 1, levels: [] }, type: RESEARCH_TYPE },
  };
  return vi.fn(async (input: string) => {
    const [path] = String(input).split('?') as [string];
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'operator', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path.startsWith('/ui/api/')) return json(200, {});
    return json(200, routes[path] ?? {});
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function boot(hash: string, d: { questions?: unknown[]; proposals?: unknown[]; jobs?: unknown[]; research?: unknown[] }) {
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon({ questions: d.questions ?? [], proposals: d.proposals ?? [], jobs: d.jobs ?? [], research: d.research ?? [] }));
  vi.stubGlobal('EventSource', FakeEventSource);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const mod = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(mod.App)); });
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const fold = (within: Element) => within.querySelector('[data-slot="fold"]') as HTMLButtonElement | null;
const click = (b: HTMLElement) => act(async () => { b.click(); });

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('a question card renders the question as Markdown', () => {
  it('a long question shows its summary first, the rest behind Show all', async () => {
    await boot('#questions', { questions: [question], jobs: [job('j1', { questionId: 'q1' })] });
    const text = document.querySelector('[data-slot="question-text"]')!;
    expect(text.textContent).toContain('Which branch do I rebase the fix onto?');
    expect(text.textContent).not.toContain('the release branch');
    expect(fold(text)!.textContent).toContain('Show all');

    await click(fold(text)!);
    expect(text.querySelectorAll('ol > li')).toHaveLength(2);
    expect(text.querySelector('li code')!.textContent).toBe('dev');
    expect(text.querySelector('pre code')!.textContent).toContain('git rebase origin/dev');
    expect(fold(text)!.textContent).toContain('Show less');
  });

  it('HTML and script in the text show as text, escaped, and run nothing', async () => {
    await boot('#questions', { questions: [question], jobs: [job('j1', { questionId: 'q1' })] });
    const text = document.querySelector('[data-slot="question-text"]')!;
    await click(fold(text)!);
    expect(text.querySelector('script, img, [onerror]')).toBeNull();
    expect(text.textContent).toContain('<script>window.pwned = 1</script>');
    expect(text.textContent).toContain('<img src=x onerror="window.pwned = 2">');
    expect((window as { pwned?: number }).pwned).toBeUndefined();
  });

  it('a short question shows whole, with no fold', async () => {
    await boot('#questions', { questions: [{ ...question, text: 'Rebase onto **dev**?' }], jobs: [job('j1', { questionId: 'q1' })] });
    const text = document.querySelector('[data-slot="question-text"]')!;
    expect(text.querySelector('strong')!.textContent).toBe('dev');
    expect(fold(text)).toBeNull();
  });
});

describe('a proposal card renders its parts as Markdown', () => {
  it('its TL;DR and problem render as Markdown; a path\'s Details open its full text as Markdown', async () => {
    await boot('#proposals', { proposals: [proposal('j1', { tldr: 'Fix the **release** script.', problem: 'It breaks on `tags`.' }, LONG_APPROACH)], jobs: [job('j1', { proposalId: 'p-j1' })] });
    const card = document.querySelector('[data-item="p-j1"]')!;
    expect(card.querySelector('[data-slot="tldr"] strong')!.textContent).toBe('release');
    expect(card.querySelector('[data-slot="problem"] code')!.textContent).toBe('tags');
    expect(card.querySelector('[data-slot="path-text"]')).toBeNull();
    await click([...card.querySelectorAll('button')].find((b) => b.textContent?.includes('Details'))!);
    expect(card.querySelectorAll('[data-slot="path-text"] li')).toHaveLength(10);
    expect(card.querySelector('[data-slot="path-text"] code')!.textContent).toBe('file0.ts');
  });

  it('the reviewer\'s notes render as Markdown', async () => {
    await boot('#proposals', { proposals: [proposal('j1', { tldr: 'Fix it.' })], jobs: [job('j1', { proposalId: 'p-j1' })] });
    const card = document.querySelector('[data-item="p-j1"]')!;
    expect([...card.querySelectorAll('strong')].map((s) => s.textContent)).toContain('One');
  });
});

// The TL;DR (issue #569): one or two plain sentences a cheap model wrote, on top of a long card; the agent's Markdown
// sits behind Show all. It is plain text: HTML in it shows as text.
const TLDR = { text: 'Pick a branch: <b>dev</b> or main.', of: 'h', model: 'claude-haiku', at: T0 };

describe('a long card leads with its TL;DR', () => {
  it('a question: the TL;DR as plain text, the whole question behind Show all', async () => {
    await boot('#questions', { questions: [{ ...question, tldr: TLDR }], jobs: [job('j1', { questionId: 'q1' })] });
    const text = document.querySelector('[data-slot="question-text"]')!;
    const tldr = text.querySelector('[data-slot="tldr"]')!;
    expect(tldr.textContent).toContain('Pick a branch: <b>dev</b> or main.');
    expect(tldr.querySelector('b')).toBeNull();
    expect(text.textContent).not.toContain('Which branch do I rebase the fix onto?');

    await click(fold(text)!);
    expect(text.querySelector('[data-slot="tldr"]')).not.toBeNull();
    expect(text.textContent).toContain('Which branch do I rebase the fix onto?');
    expect(text.querySelectorAll('ol > li')).toHaveLength(2);
  });

  it('a short question shows whole, with no TL;DR', async () => {
    await boot('#questions', { questions: [{ ...question, text: 'Rebase onto **dev**?', tldr: TLDR }], jobs: [job('j1', { questionId: 'q1' })] });
    const text = document.querySelector('[data-slot="question-text"]')!;
    expect(text.querySelector('[data-slot="tldr"]')).toBeNull();
    expect(text.querySelector('strong')!.textContent).toBe('dev');
  });

  it('a research report: the TL;DR, and every part behind Show all', async () => {
    const r = { ...report('j1', { question: 'What does the **probe** learn?', findings: LONG_APPROACH, confidence: 'high' }), tldr: TLDR };
    await boot('#research', { research: [r], jobs: [job('j1', { researchId: 'r-j1' })] });
    const card = document.querySelector('[data-item="r-j1"]')!;
    expect(card.querySelector('[data-slot="tldr"]')!.textContent).toContain('Pick a branch');
    expect(card.querySelector('[data-section="question"]')).toBeNull();

    await click(fold(card)!);
    expect(card.querySelector('[data-section="question"] strong')!.textContent).toBe('probe');
    expect(card.querySelectorAll('[data-section="findings"] li')).toHaveLength(10);
  });
});

describe('the TL;DR setting', () => {
  it('Settings → TL;DR shows it on, and turning it off posts the change', async () => {
    await boot('#settings/tldr', {});
    const view = document.querySelector('[data-slot="tldr-settings"]')!;
    const toggle = view.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await click(toggle);
    const posted = (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls.filter(([u]) => String(u) === '/ui/api/tldr');
    expect(posted).toHaveLength(1);
    expect(JSON.parse(String(posted[0]![1]!.body))).toEqual({ enabled: false });
  });
});
