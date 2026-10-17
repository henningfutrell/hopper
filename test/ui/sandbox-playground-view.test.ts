// @vitest-environment happy-dom
// The sandbox playground on Machines (issue #1410), the panel rendered against a fake of GET /api/sandbox-playground: it
// lists the hopper's sandboxes, and an answer that is no playground view (a fake daemon that answers {} for a route it
// does not know, as the Machines view tests do) hides the panel, never throws (issue #1435).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaygroundView } from '../../src/domain/types.ts';
import { PLAYGROUND_LIMITS } from '../../src/sandbox/playground.ts';

const VIEW: PlaygroundView = {
  agents: ['claude', 'codex'], limits: PLAYGROUND_LIMITS, running: { all: 1, yours: 1 },
  sandboxes: [{ id: '1', name: 'hopper-playground-1', agent: 'claude', size: { cpus: 1, memoryMb: 2048, ttlMinutes: 60 }, state: 'starting', createdAt: '2026-10-15T12:00:00Z', expiresAt: '2026-10-15T13:00:00Z' }],
};

let root: Root | undefined;

async function boot(answer: unknown) {
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: string) => json(String(input).split('?')[0] === '/api/sandbox-playground' ? answer : {})));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  // Imported by a path in a variable: the UI's modules are typed by the UI's own tsconfig, not this one.
  const store = '../../ui/src/store/index.ts';
  const view = '../../ui/src/views/sandbox-playground.tsx';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: unknown): void } };
  useHopper.setState({ authed: true, user: { role: 'admin', realm: 'local', name: 'someone' } });
  const { SandboxPlaygroundPanel } = (await import(view)) as { SandboxPlaygroundPanel: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(SandboxPlaygroundPanel)); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the sandbox playground panel', () => {
  it('lists the hopper\'s playground sandboxes', async () => {
    await boot(VIEW);
    expect(document.querySelector('[data-slot="playground-sandboxes"]')?.textContent).toContain('hopper-playground-1');
  });

  it('offers each harness\'s box to start', async () => {
    await boot(VIEW);
    const agents = [...document.querySelectorAll<HTMLOptionElement>('[data-slot="playground-agent"] option')].map((o) => o.value);
    expect(agents).toEqual(['claude', 'codex']);
  });

  it('hides itself when the answer is no playground view, and does not throw', async () => {
    await boot({});
    expect(document.getElementById('root')!.textContent).toBe('');
  });
});
