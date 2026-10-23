// @vitest-environment happy-dom
// The command palette (issue #2661): one search over pages, commands, jobs, settings and more, opened by Cmd-K or Ctrl-K
// on every screen or by the header's button. Its commands come from the scope registry (GET /api/scopes), so a new route
// is a new command, and the person's role filters them. The vault is found by names only.
//
// Feature: The command palette
//   Scenario: every route that changes something is a command; reads and a body's actions are not
//   Scenario: a role sees only the commands its role allows; a new permission shows up with no edit
//   Scenario: a command on one job is a job action; any other opens the page where it is done
//   Scenario: the vault's entries carry names only, never a value or its last characters
//   Scenario: recent picks come first, each once, and storage that holds junk gives none
//   Scenario: Ctrl-K opens it with every page; the index's suggestions show; a picked job shows its actions; Cancel asks Enter once more
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandEntries, commandHref, jobActions, parseRecent, RECENT_MAX, vaultEntries, withRecent, type PaletteEntry } from '../../ui/src/model/command-palette.ts';
import type { ScopePermission, ScopeRegistry, VaultView } from '../../ui/src/model/wire.ts';

const perm = (scope: string, role: ScopePermission['role'], routes: string[], description = scope, parent?: string): ScopePermission =>
  ({ scope, description, routes, role, box: false, ...(parent ? { parent } : {}) });

const REGISTRY: ScopeRegistry = {
  presets: [],
  sections: [
    { id: 'jobs', title: 'Jobs', description: '', permissions: [
      perm('jobs:read', 'viewer', ['GET /api/jobs/:id']),
      perm('jobs:cancel', 'operator', ['POST /ui/api/jobs/:id/cancel'], 'Cancel a job'),
      perm('jobs:rerun', 'operator', ['POST /ui/api/jobs/:id/rerun'], 'Run a failed, finished, rejected or cancelled job again'),
      perm('jobs:gate-pass', 'admin', ['POST /ui/api/jobs/:id/gate-pass'], 'Let a job held at the blast-radius gate through'),
      perm('jobs:dismiss', 'operator', ['POST /ui/api/jobs/:id/dismiss', 'POST /ui/api/jobs/dismiss'], 'Dismiss a locked entry; Dismiss many locked entries'),
      perm('queue:order', 'operator', ['POST /ui/api/queue/order'], 'Order the queue'),
    ] },
    { id: 'pull-requests', title: 'Pull requests', description: '', permissions: [
      perm('yolo-mode:edit', 'admin', ['POST /ui/api/yolo-mode'], 'Set yolo mode'),
    ] },
    { id: 'intake', title: 'Intake', description: '', permissions: [
      perm('sources:intake', 'operator', ['POST /ui/api/sources/:name/intake'], 'Act on intake'),
      perm('sources:intake.approve', 'operator', ['POST /ui/api/sources/:name/intake (kind: approve)'], 'Approve (Act on intake)', 'sources:intake'),
    ] },
  ],
};
const SETTINGS = ['version', 'yolo-mode', 'decider'];
const scopesOf = (es: PaletteEntry[]) => es.map((e) => e.hint).sort();

describe('commands from the scope registry', () => {
  it('makes every route that changes something a command; a read and a body\'s action are not', () => {
    const scopes = scopesOf(commandEntries(REGISTRY, 'admin', SETTINGS));
    expect(scopes).toEqual(['jobs:dismiss', 'queue:order', 'sources:intake', 'yolo-mode:edit']);
    expect(jobActions(REGISTRY, 'admin').map((a) => a.act).sort()).toEqual(['cancel', 'dismiss', 'gate-pass', 'rerun']);
  });

  it('shows a role only what its role allows, and a new permission with no edit', () => {
    expect(commandEntries(REGISTRY, 'viewer', SETTINGS)).toEqual([]);
    expect(jobActions(REGISTRY, 'viewer')).toEqual([]);
    expect(scopesOf(commandEntries(REGISTRY, 'operator', SETTINGS))).toEqual(['jobs:dismiss', 'queue:order', 'sources:intake']);
    expect(jobActions(REGISTRY, 'operator').map((a) => a.act)).not.toContain('gate-pass');
    const grown: ScopeRegistry = { ...REGISTRY, sections: [...REGISTRY.sections, { id: 'other', title: 'Other', description: '', permissions: [perm('brand-new:edit', 'operator', ['POST /ui/api/brand-new'], 'Do the new thing')] }] };
    const added = commandEntries(grown, 'operator', SETTINGS).find((e) => e.hint === 'brand-new:edit');
    expect(added).toMatchObject({ group: 'Commands', label: 'Do the new thing', href: '#dashboard' });
  });

  it('opens the page where a command is done: its area\'s, a settings section of its name, else its section\'s', () => {
    const href = Object.fromEntries(commandEntries(REGISTRY, 'admin', SETTINGS).map((e) => [e.hint, e.href]));
    expect(href).toEqual({ 'queue:order': '#jobs/queue', 'yolo-mode:edit': '#settings/yolo-mode', 'sources:intake': '#sources', 'jobs:dismiss': '#jobs' });
    expect(commandHref('rules:edit', 'decider', SETTINGS)).toBe('#settings/decider');
    expect(commandHref('vault:edit', 'vault', SETTINGS)).toBe('#vault');
    expect(jobActions(REGISTRY, 'operator').find((a) => a.act === 'dismiss')?.label).toBe('Dismiss a locked entry');
  });
});

describe('the vault in the palette', () => {
  it('finds secrets, shared secrets, system secrets and templates by name only', () => {
    const view = {
      secrets: [{ id: 's1', name: 'prod-db', scope: 'cluster a', setBy: 'ada', createdAt: '', changedBy: 'ada', changedAt: '', value: 'hunter2-secret' }],
      shared: [{ name: 'shared/registry', setBy: 'ada', createdAt: '', changedBy: 'ada', changedAt: '' }],
      system: { secrets: [{ name: 'system/github-webhook', kind: 'webhook', scope: 'user', last4: 'zq9X', setBy: 'ada', setAt: '' }], audit: [] },
      templates: [{ name: 'observe-prod', image: 'img', secrets: ['prod-db'] }],
      backends: [],
    } as unknown as VaultView;
    const entries = vaultEntries(view);
    expect(entries.map((e) => e.label)).toEqual(['prod-db', 'shared/registry', 'system/github-webhook', 'observe-prod']);
    const text = JSON.stringify(entries);
    for (const kept of ['hunter2-secret', 'zq9X', 'cluster a']) expect(text).not.toContain(kept);
    expect(vaultEntries(null)).toEqual([]);
  });
});

describe('recent picks', () => {
  it('keeps the newest first, each once, at most RECENT_MAX; junk in storage gives none', () => {
    const e = (n: number): PaletteEntry => ({ id: `page:#${n}`, group: 'Pages', label: `P${n}`, href: `#${n}` });
    let list: PaletteEntry[] = [];
    for (let n = 0; n < RECENT_MAX + 3; n++) list = withRecent(list, e(n));
    list = withRecent(list, e(5));
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0]).toMatchObject({ id: 'page:#5', group: 'Recent' });
    expect(list.filter((r) => r.id === 'page:#5')).toHaveLength(1);
    expect(parseRecent(JSON.stringify(list))).toEqual(list);
    expect(parseRecent('{nope')).toEqual([]);
    expect(parseRecent(JSON.stringify([{ id: 1 }, null, 'x']))).toEqual([]);
  });
});

type El = ReturnType<typeof createElement>;
let root: Root | undefined;
let posts: { path: string; body: unknown }[] = [];

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  window.location.hash = '';
  document.body.innerHTML = '';
});

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const items = (slot = 'palette-item') => [...document.querySelectorAll(`[data-slot="${slot}"]`)] as HTMLElement[];
const type = async (text: string) => {
  const input = document.querySelector('[data-slot="palette-input"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
};

describe('the palette on the page', () => {
  it('opens with Ctrl-K, lists every page, finds a job and acts on it; Cancel asks Enter once more', async () => {
    posts = [];
    localStorage.setItem('jh_session', 'a'.repeat(64));
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) }); return json({}); }
      if (path === '/api/scopes') return json(REGISTRY);
      if (path.startsWith('/api/search/suggest')) return json({ state: 'ok', suggestions: [{ type: 'issue', ref: 'https://github.com/o/r/issues/7', title: 'Build cache misses on CI', url: '' }, { type: 'job', ref: 'j1', title: 'Clear the build cache', url: '' }] });
      if (path === '/api/vault') return json({ secrets: [], templates: [], backends: [] });
      return json({});
    }));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '<div id="root"></div>';
    const store = '../../ui/src/store/index.ts';
    const { useHopper } = (await import(store)) as { useHopper: { setState(s: Record<string, unknown>): void } };
    const job = { id: 'j1', status: 'running', spec: { executor: 'herdr-claude', payload: {}, goal: 'Clear the build cache' }, createdAt: '', updatedAt: '' };
    useHopper.setState({ authed: true, user: { id: 'u1', name: 'ada', role: 'operator', realm: 'local', identity: 'ada' }, jobs: { j1: job }, questions: [], machines: [] });
    const palette = '../../ui/src/app/command-palette.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
    const { CommandPaletteButton } = (await import(palette)) as { CommandPaletteButton: () => El };
    const routes = '../../ui/src/app/routes.ts';
    const { VIEWS } = (await import(routes)) as { VIEWS: readonly string[] };
    const nav = '../../ui/src/app/nav.tsx';
    const { viewLabel } = (await import(nav)) as { viewLabel: (v: string) => string };
    await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(CommandPaletteButton)); });
    expect(document.querySelector('[data-slot="palette-input"]')).toBeNull();

    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); });
    await settle();
    const pages = items().filter((e) => e.dataset.group === 'Pages').map((e) => e.textContent);
    for (const v of VIEWS) expect(pages).toContain(viewLabel(v));
    expect(pages).toContain('Jobs: Queue order');
    const commands = items().filter((e) => e.dataset.group === 'Commands').map((e) => e.textContent ?? '');
    expect(commands.some((c) => c.startsWith('Order the queue'))).toBe(true);
    expect(commands.some((c) => c.startsWith('Set yolo mode'))).toBe(false); // admin's, and this is an operator

    await type('build cache');
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); }); // the suggestions are asked after a pause
    await settle();
    // The index's suggestions show in their group; a job the page holds is listed once.
    expect(items().filter((e) => e.dataset.group === 'Issues').map((e) => e.textContent)).toEqual(['Build cache misses on CI']);
    expect(items().filter((e) => e.dataset.group === 'Jobs')).toHaveLength(1);
    const found = items().find((e) => e.dataset.group === 'Jobs');
    expect(found?.textContent).toContain('Clear the build cache');
    await act(async () => { found!.click(); });
    await settle();
    const acts = items('palette-action').map((e) => e.dataset.act);
    expect(acts).toEqual(expect.arrayContaining(['open', 'cancel', 'rerun', 'dismiss']));
    expect(acts).not.toContain('gate-pass');
    const cancel = () => items('palette-action').find((e) => e.dataset.act === 'cancel')!;
    await act(async () => { cancel().click(); });
    expect(posts).toEqual([]);
    expect(cancel().textContent).toContain('Press Enter again');
    await act(async () => { cancel().click(); });
    await settle();
    expect(posts).toEqual([{ path: '/ui/api/jobs/j1/cancel', body: {} }]);
    expect(document.querySelector('[data-slot="palette-input"]')).toBeNull();
  });
});
