// @vitest-environment happy-dom
// Lane tuning on Machines (issue #688), the panel rendered against a fake of GET /api/lanes/plan: each machine's
// recommended lanes next to its configured lanes, the reason and the confidence. An admin changes a machine's bounds and
// Save posts only what changed; bounds that cross are refused in place. A viewer reads only.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LaneTuningPlan } from '../../src/domain/types.ts';

const PLAN: LaneTuningPlan = {
  at: '2026-10-10T12:00:00.000Z', mode: 'shadow', windowDays: 7,
  machines: [{
    machineId: 'desk', label: 'Desk', online: true, configured: 2, lanes: 4, headroom: 4, confidence: 0.5, usedFrac: 0.2, usage: 'free',
    tuning: { autoTune: true, minLanes: 1, maxLanes: 8 }, reason: 'no resource pressure up to 2 lanes in use; room for 2 more',
  }],
};

let root: Root | undefined;
const posts: { path: string; body: unknown }[] = [];

async function boot(role: 'admin' | 'viewer') {
  posts.length = 0;
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/lanes/tuning') { posts.push({ path, body: JSON.parse(String(init.body)) }); return json(PLAN); }
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
const saveButton = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save');
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

  it('a viewer reads only', async () => {
    await boot('viewer');
    expect(document.querySelector('[data-slot="lane-recommendation-line"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="lane-tuning-form"]')).toBeNull();
  });
});
