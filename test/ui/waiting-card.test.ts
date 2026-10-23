// @vitest-environment happy-dom
// Issue #883: a Waiting card a person can read without opening it. It leads with the issue's title and its link, repo and
// number; the hold reads in plain words, whole, and names the machine and what letting it through does; how long it waits
// and its priority read without router words; the buttons come after all of it, so they cover none of it.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gateHeldOn, gateHoldText } from '../../ui/src/model/blast-radius.ts';
import { adviceText } from '../../ui/src/model/job.ts';

const HOLD = 'held at the blast-radius gate: fleet-l1 is an actor machine (applies fleet changes, then checks them), desk is rated high; only a job let through the gate runs there';
const machines = [{ id: 'fleet-l1', label: 'Fleet runner' }, { id: 'desk', label: 'desk' }];

describe('a gate hold in plain words', () => {
  it('names each machine and why it is gated, a purpose with commas kept whole', () => {
    expect(gateHeldOn(HOLD)).toEqual([
      { machineId: 'fleet-l1', why: 'an actor machine (applies fleet changes, then checks them)' },
      { machineId: 'desk', why: 'rated high' },
    ]);
    expect(gateHeldOn('no machine runs its executor')).toEqual([]);
  });

  it('says why it is held and what letting it through does', () => {
    expect(gateHoldText(HOLD, machines)).toBe(
      'Held by the safety gate. The only machines that can run it take only jobs a person lets through: '
      + 'Fleet runner (fleet-l1) is an actor machine (applies fleet changes, then checks them); desk is rated high blast radius. '
      + 'Let it through and it may run on Fleet runner (fleet-l1) or desk, with everything that machine can reach.');
  });

  it('the router\'s advice reads without its code words; the plain default says nothing', () => {
    expect(adviceText('proceed_full')).toBeUndefined();
    expect(adviceText('ask_human')).toBe('the router asks a person to look first');
    expect(adviceText('chat_only')).toBe('the router says: answer only, change no code');
  });
});

const T = '2026-10-12T10:00:00.000Z';
const heldJob = {
  id: 'g1', spec: { executor: 'test', payload: {}, goal: 'Roll the fleet config to the new image' }, priority: 75, status: 'held', holdReason: HOLD,
  approved: false, accepted: true, attempts: 0, createdAt: T, updatedAt: T,
  advice: { action: 'proceed_full', reason: 'default', details: {}, source: 'gate-router', at: T },
  source: { source: 'github', kind: 'github-account', key: 'k', title: 'Roll the fleet config to the new image', repo: 'org/infra-workflows', number: 1219, url: 'https://github.com/org/infra-workflows/issues/1219' },
};

function fakeDaemon() {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [heldJob], running: [], operatorLed: [], parked: [], waitingAnswer: [], waitingOn: [], ended: [], locked: [], highPriority: 75 },
    '/api/machines': { machines: machines.map((m) => ({ ...m, maxLanes: 1, online: true, executors: ['test'], lanes: [], usage: [] })) },
    '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
  };
  return vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path in routes) return json(200, routes[path]);
    return json(404, { error: 'not found' });
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function boot() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#dashboard';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx';
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

const row = () => document.querySelector('[data-job-group="waiting"][data-job-id="g1"]');

describe('a Waiting card', () => {
  it('leads with the title and its issue, says the hold in full, and keeps its buttons below', async () => {
    await boot();
    await vi.waitFor(() => expect(row()?.querySelector('[data-slot="hold-reason"]')?.textContent).toContain('Fleet runner (fleet-l1)'));
    const card = row()!;
    expect(card.firstElementChild!.textContent).toContain('Roll the fleet config to the new image');
    const link = card.querySelector<HTMLAnchorElement>('a[href="https://github.com/org/infra-workflows/issues/1219"]')!;
    expect(link.textContent).toContain('infra-workflows#1219');

    const hold = card.querySelector('[data-slot="hold-reason"]')!;
    expect(hold.className).not.toContain('truncate');
    expect(hold.textContent).toContain('Let it through and it may run on');

    expect(card.textContent).toContain('priority 75');
    expect(card.textContent).toMatch(/waiting \d/);
    expect(card.textContent).not.toContain('proceed_full');
    expect(card.textContent).not.toContain('prio ');

    // The buttons come last: every one sits in the actions row, after the hold.
    const actions = card.querySelector('[data-slot="waiting-actions"]')!;
    expect(actions.querySelector('[data-slot="gate-pass"]')).not.toBeNull();
    expect(card.lastElementChild).toBe(actions);
    expect([...card.querySelectorAll('button')].every((b) => actions.contains(b))).toBe(true);
  });
});
