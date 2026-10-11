// @vitest-environment happy-dom
// Lane tuning on Machines (issue #688), the panel rendered against a fake of GET /api/lanes/plan: each machine's
// recommended lanes next to its configured lanes, the reason and the confidence. An admin changes a machine's bounds and
// Save posts only what changed; bounds that cross are refused in place. An admin applies a recommendation, dismisses it,
// and undoes the last one applied. The history lists each change with its reason. A viewer reads only.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LaneTuningPlan } from '../../src/domain/types.ts';

const SHADOW: LaneTuningPlan = {
  at: '2026-10-10T12:00:00.000Z', windowDays: 7, changes: [],
  machines: [{
    machineId: 'desk', label: 'Desk', online: true, configured: 2, lanes: 4, headroom: 4, confidence: 0.5, usedFrac: 0.2, usage: 'free',
    tuning: { autoTune: true, minLanes: 1, maxLanes: 8 }, reason: 'no resource pressure up to 2 lanes in use; room for 2 more', apply: { to: 4 },
  }],
};
const { apply: _apply, ...asConfigured } = SHADOW.machines[0]!;
const APPLIED: LaneTuningPlan = {
  ...SHADOW,
  machines: [{ ...asConfigured, configured: 4, undo: { to: 2 } }],
  changes: [{ at: '2026-10-10T11:59:00.000Z', machineId: 'desk', kind: 'applied', from: 2, to: 4, reason: 'room for 2 more', by: 'someone' }],
};
const DISMISSED: LaneTuningPlan = { ...SHADOW, machines: [{ ...asConfigured, dismissed: { at: '2026-10-10T11:59:00.000Z', by: 'someone' } }] };
let PLAN = SHADOW;

let root: Root | undefined;
const posts: { path: string; body: unknown }[] = [];

async function boot(role: 'admin' | 'viewer', plan = SHADOW) {
  posts.length = 0;
  PLAN = plan;
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    if (path.startsWith('/ui/api/lanes/')) { posts.push({ path, body: JSON.parse(String(init.body)) }); return json(PLAN); }
    return json(path === '/api/lanes/plan' ? PLAN : {});
  }));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  // Imported by a path in a variable: the UI's modules are typed by the UI's own tsconfig, not this one.
  const store = '../../ui/src/store/index.ts';
  const view = '../../ui/src/views/lane-tuning.tsx';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: unknown): void } };
  useHopper.setState({ authed: true, user: { role, realm: 'local', name: 'someone' } });
  const { LaneTuningPanel } = (await import(view)) as { LaneTuningPanel: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(LaneTuningPanel)); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const field = (label: string) => document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text);
const saveButton = () => button('Save');
function type(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('lane tuning on Machines', () => {
  it('shows the recommended lanes next to the configured lanes, the reason and the confidence', async () => {
    await boot('admin');
    expect(document.querySelector('[data-slot="lane-recommendation-line"]')?.textContent).toBe('Recommends 4 lanes; configured 2: 2 more');
    expect(document.querySelector('[data-slot="lane-recommendation"]')?.textContent).toContain('room for 2 more (confidence 50%)');
  });

  it('an admin saves only what changed; bounds that cross are refused in place', async () => {
    await boot('admin');
    expect(saveButton()!.disabled).toBe(true);
    await act(async () => { type(field('Least lanes for Desk'), '9'); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('The least lanes must not be more than the most lanes');
    expect(saveButton()!.disabled).toBe(true);
    await act(async () => { type(field('Least lanes for Desk'), '1'); type(field('Most lanes for Desk'), '3'); });
    await act(async () => { saveButton()!.click(); });
    expect(posts).toEqual([{ path: '/ui/api/lanes/tuning', body: { machineId: 'desk', maxLanes: 3 } }]);
  });

  it('an admin applies the recommendation or dismisses it', async () => {
    await boot('admin');
    await act(async () => { button('Apply: 4 lanes')!.click(); });
    await act(async () => { button('Dismiss')!.click(); });
    expect(posts).toEqual([
      { path: '/ui/api/lanes/apply', body: { machineId: 'desk', lanes: 4 } },
      { path: '/ui/api/lanes/dismiss', body: { machineId: 'desk' } },
    ]);
  });

  it('a dismissed recommendation offers no Apply and says who dismissed it', async () => {
    await boot('admin', DISMISSED);
    expect(button('Apply: 4 lanes')).toBeUndefined();
    expect(document.querySelector('[data-slot="lane-dismissed"]')?.textContent).toBe('Dismissed by someone; shown again when the recommendation moves');
  });

  it('after an Apply: the history with each change\'s reason, and an admin\'s undo', async () => {
    await boot('admin', APPLIED);
    expect(document.querySelector('[data-slot="lane-recommendation-line"]')?.textContent).toBe('Recommends the configured 4 lanes');
    expect(document.querySelector('[data-slot="lane-change"]')?.textContent).toContain('2 → 4 lanes: applied by someone: room for 2 more');
    await act(async () => { button('Undo: back to 2')!.click(); });
    expect(posts).toEqual([{ path: '/ui/api/lanes/undo', body: { machineId: 'desk' } }]);
  });

  it('a viewer reads only', async () => {
    await boot('viewer');
    expect(document.querySelector('[data-slot="lane-recommendation-line"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="lane-tuning-form"]')).toBeNull();
    expect(button('Apply: 4 lanes')).toBeUndefined();
    expect(button('Dismiss')).toBeUndefined();
  });

  it('a viewer sees no undo', async () => {
    await boot('viewer', APPLIED);
    expect(document.querySelector('[data-slot="lane-change"]')).not.toBeNull();
    expect(button('Undo: back to 2')).toBeUndefined();
  });
});
