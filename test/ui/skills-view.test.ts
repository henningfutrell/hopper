// @vitest-environment happy-dom
// The Skills page (issue #1911, design.md "The Skills page"), rendered in happy-dom inside the whole app against a fake of
// the daemon's HTTP surface: a top-level view that lists the library skills with their source and version; a person
// chooses the skill of each kind of work, for every repository and per repository; creates a skill, edits one of their
// own (a new version), duplicates a built-in one to change it, and removes one no setting names.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const A = 'a'.repeat(16);
const B = 'b'.repeat(16);
const builtIn = (name: string, text: string) => ({ name, builtIn: true, description: text, latest: { name, version: A, seq: 0, source: { kind: 'built-in' }, by: 'the hopper' }, versions: 1 });
const LIBRARY = {
  skills: [
    builtIn('work', 'Do the work end to end.'), builtIn('research', 'Research, then report.'), builtIn('proposal', 'Propose paths.'),
    { name: 'orchestrate', builtIn: false, description: 'Task lists.', latest: { name: 'orchestrate', version: B, seq: 1, source: { kind: 'imported', repo: 'octo/workflows', path: 'skills/orchestrate', ref: 'HEAD', commit: 'c'.repeat(40) }, by: 'an admin', at: '2026-10-18T10:00:00.000Z' }, versions: 1 },
    { name: 'deep-research', builtIn: false, description: 'Dig deep.', latest: { name: 'deep-research', version: B, seq: 2, source: { kind: 'created' }, by: 'an admin', at: '2026-10-18T10:00:00.000Z' }, versions: 2 },
  ],
  workSkills: { kinds: {}, repos: { 'octo/site': { research: 'deep-research' } } },
  defaults: { code: 'work', research: 'research', proposal: 'proposal' },
  kinds: ['code', 'research', 'proposal'],
};
const FILES: Record<string, Record<string, string>> = {
  work: { 'SKILL.md': '---\nname: work\ndescription: Do the work end to end.\n---\n# Work\n' },
  'deep-research': { 'SKILL.md': '---\nname: deep-research\ndescription: Dig deep.\n---\n# Deep\n', 'notes/sources.md': 'Read the docs first.' },
};

interface Call { path: string; method: string; body?: Record<string, unknown> }

function fakeDaemon() {
  const calls: Call[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/questions': { questions: [] },
    '/api/sources': { sources: [] }, '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/skill-library': LIBRARY,
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method: init.method ?? 'GET', ...(body ? { body } : {}) });
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    const one = /^\/api\/skill-library\/([^/]+)$/.exec(path);
    if (one) {
      const s = LIBRARY.skills.find((x) => x.name === decodeURIComponent(one[1]!))!;
      return json(200, { skill: { ...s.latest, files: FILES[s.name] ?? { 'SKILL.md': `# ${s.name}` } }, versions: [s.latest] });
    }
    if (path === '/ui/api/skill-library' || path === '/ui/api/work-skills') return json(200, LIBRARY);
    if (path in routes) return json(200, routes[path]);
    return json(404, { error: 'not found' });
  });
  return { fetch, calls };
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;
const page = () => document.querySelector('[data-slot="skills"]');
const skill = (name: string) => page()!.querySelector(`[data-slot="library-skill"][data-name="${name}"]`)!;
const buttonIn = (el: Element, label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const click = (b: Element | undefined) => act(async () => { (b as HTMLElement).click(); });
const type = (el: HTMLInputElement | HTMLTextAreaElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const pick = (el: HTMLSelectElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
const editor = () => page()!.querySelector('[data-slot="skill-editor"]');

async function boot() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#skills';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon();
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(page()?.querySelector('[data-slot="library-skill"]')).not.toBeNull());
  return daemon;
}

afterEach(() => { act(() => root?.unmount()); root = undefined; vi.unstubAllGlobals(); });

const posted = (d: ReturnType<typeof fakeDaemon>, path: string) => d.calls.filter((c) => c.path === path && c.method === 'POST').map((c) => c.body);

describe('the Skills page (issue #1911)', () => {
  it('is a top-level view in the navigation, and lists each skill with its source and version', async () => {
    await boot();
    expect(document.querySelector('a[href="#skills"]')?.textContent).toContain('Skills');
    expect(skill('work').textContent).toContain('built-in');
    expect(skill('work').textContent).toContain('Do the work end to end.');
    expect(skill('deep-research').textContent).toContain('written by an admin');
    expect(skill('deep-research').textContent).toContain(B.slice(0, 8));
    expect(skill('deep-research').textContent).toContain('2 versions');
    expect(buttonIn(skill('work'), 'Edit')).toBeUndefined();
    expect(buttonIn(skill('work'), 'Remove')).toBeUndefined();
  });

  it('chooses the skill of a kind of work for every repository, and back to the default', async () => {
    const daemon = await boot();
    const research = page()!.querySelector<HTMLSelectElement>('select[name="work-skill-research"]')!;
    expect(research.value).toBe('');
    await pick(research, 'deep-research');
    await vi.waitFor(() => expect(posted(daemon, '/ui/api/work-skills')).toEqual([{ kinds: { research: 'deep-research' } }]));
    await pick(research, '');
    await vi.waitFor(() => expect(posted(daemon, '/ui/api/work-skills')[1]).toEqual({ kinds: { research: null } }));
  });

  it('chooses a skill for one repository', async () => {
    const daemon = await boot();
    const row = page()!.querySelector('[data-slot="repo-work-skills"][data-repo="octo/site"]')!;
    expect(row.querySelector<HTMLSelectElement>('select[name="work-skill-research"]')!.value).toBe('deep-research');
    await pick(row.querySelector<HTMLSelectElement>('select[name="work-skill-code"]')!, 'deep-research');
    await vi.waitFor(() => expect(posted(daemon, '/ui/api/work-skills')).toEqual([{ repos: { 'octo/site': { code: 'deep-research' } } }]));
    await click(buttonIn(page()!, 'Add a repository'));
    await type(page()!.querySelector<HTMLInputElement>('input[name="new-repo"]')!, 'Octo/API');
    const added = page()!.querySelector('[data-slot="new-repo-work-skills"]')!;
    await pick(added.querySelector<HTMLSelectElement>('select[name="work-skill-proposal"]')!, 'deep-research');
    await vi.waitFor(() => expect(posted(daemon, '/ui/api/work-skills')[1]).toEqual({ repos: { 'octo/api': { proposal: 'deep-research' } } }));
  });

  it('creates a skill with its SKILL.md and a second file', async () => {
    const daemon = await boot();
    await click(buttonIn(page()!, 'New skill'));
    await type(editor()!.querySelector<HTMLInputElement>('input[name="skill-name"]')!, 'triage');
    await click(buttonIn(editor()!, 'Add a file'));
    const paths = editor()!.querySelectorAll<HTMLInputElement>('input[name="skill-file-path"]');
    await type(paths[1]!, 'checklist.md');
    await type(editor()!.querySelectorAll<HTMLTextAreaElement>('textarea[name="skill-file-text"]')[1]!, '- read the issue');
    await click(buttonIn(editor()!, 'Save skill'));
    await vi.waitFor(() => expect(posted(daemon, '/ui/api/skill-library')).toHaveLength(1));
    const body = posted(daemon, '/ui/api/skill-library')[0]!;
    expect(body.action).toBe('create');
    expect(body.name).toBe('triage');
    expect(Object.keys(body.files as object)).toEqual(['SKILL.md', 'checklist.md']);
    expect((body.files as Record<string, string>)['checklist.md']).toBe('- read the issue');
  });

  it('edits a skill of the user\'s own: its files are loaded, the name stays, the save is an edit', async () => {
    const daemon = await boot();
    await click(buttonIn(skill('deep-research'), 'Edit'));
    await vi.waitFor(() => expect(editor()?.querySelectorAll('input[name="skill-file-path"]')).toHaveLength(2));
    expect(editor()!.querySelector<HTMLInputElement>('input[name="skill-name"]')!.disabled).toBe(true);
    const text = editor()!.querySelectorAll<HTMLTextAreaElement>('textarea[name="skill-file-text"]')[1]!;
    await type(text, 'Read the docs and the code.');
    await click(buttonIn(editor()!, 'Save skill'));
    await vi.waitFor(() => expect(posted(daemon, '/ui/api/skill-library')).toEqual([{
      action: 'edit', name: 'deep-research', files: { ...FILES['deep-research'], 'notes/sources.md': 'Read the docs and the code.' },
    }]));
  });

  it('duplicates a built-in skill to change it, at the version shown', async () => {
    const daemon = await boot();
    await click(buttonIn(skill('work'), 'Duplicate'));
    await type(skill('work').querySelector<HTMLInputElement>('input[name="duplicate-name"]')!, 'my-work');
    await click(buttonIn(skill('work'), 'Make the copy'));
    await vi.waitFor(() => expect(posted(daemon, '/ui/api/skill-library')).toEqual([{ action: 'duplicate', from: 'work', version: A, name: 'my-work' }]));
  });

  it('imports a skill from a folder of a repository, and refreshes an imported one', async () => {
    const daemon = await boot();
    expect(skill('orchestrate').textContent).toContain('imported from octo/workflows/skills/orchestrate at HEAD');
    expect(buttonIn(skill('deep-research'), 'Refresh')).toBeUndefined();
    await click(buttonIn(skill('orchestrate'), 'Refresh'));
    await vi.waitFor(() => expect(posted(daemon, '/ui/api/skill-library')).toEqual([{ action: 'refresh', name: 'orchestrate' }]));
    await click(buttonIn(page()!, 'Import'));
    const form = page()!.querySelector('[data-slot="skill-import"]')!;
    await type(form.querySelector<HTMLInputElement>('input[name="import-repo"]')!, 'octo/workflows');
    await type(form.querySelector<HTMLInputElement>('input[name="import-path"]')!, 'skills/research');
    await type(form.querySelector<HTMLInputElement>('input[name="import-ref"]')!, 'main');
    await click(buttonIn(form, 'Import skill'));
    await vi.waitFor(() => expect(posted(daemon, '/ui/api/skill-library')[1]).toEqual({ action: 'import', repo: 'octo/workflows', path: 'skills/research', ref: 'main' }));
  });

  it('shows a skill\'s files; and a skill a setting names cannot be removed, and says why', async () => {
    await boot();
    await click(buttonIn(skill('deep-research'), 'Show files'));
    await vi.waitFor(() => expect(skill('deep-research').textContent).toContain('notes/sources.md'));
    const remove = buttonIn(skill('deep-research'), 'Remove')!;
    expect(remove.disabled).toBe(true);
    expect(skill('deep-research').textContent).toContain('octo/site: Research');
  });
});
