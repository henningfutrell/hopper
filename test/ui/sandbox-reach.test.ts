// @vitest-environment happy-dom
// Issue #708, on Machines: a sandbox box whose start check fails from inside it is shown with its address and what the
// check wrote; a box that reaches the hopper is not shown, and with none, the panel is not there.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxBox, SandboxesView } from '../../src/domain/machines.ts';

const box = (name: string, over: Partial<SandboxBox> = {}): SandboxBox => ({
  id: name, name, agent: 'claude', image: 'img', params: { secrets: [], cpus: 1, memoryMb: 1024 }, runtime: 'podman', machine: 'local',
  containerId: 'c1', volume: `${name}-home`, keepHome: true, state: 'ready', createdAt: '2026-10-11T10:00:00.000Z', address: 'http://hopper:4790',
  check: { passed: true, at: '2026-10-11T10:00:01.000Z' }, ...over,
});
const view = (boxes: SandboxBox[]): SandboxesView => ({ launch: { available: true, runtime: 'podman' }, line: '', boxes, problems: [] });

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; });

async function render(v: SandboxesView | null): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  // Imported by a path in a variable: the UI's modules are typed by the UI's own tsconfig, not this one.
  const path = '../../ui/src/views/sandbox-reach.tsx';
  const { UnreachableBoxes } = (await import(path)) as { UnreachableBoxes: (p: { view: SandboxesView | null }) => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(UnreachableBoxes, { view: v })); });
}

describe('sandbox boxes that cannot reach the hopper, on Machines', () => {
  it('shows each unreachable box with its address and what its start check wrote', async () => {
    await render(view([
      box('hopper-sandbox-claude'),
      box('hopper-sandbox-kube', { state: 'unreachable', check: { passed: false, at: '2026-10-11T10:05:00.000Z', output: 'curl: (6) Could not resolve host: hopper' } }),
    ]));
    const rows = [...document.querySelectorAll('[data-unreachable-box]')].map((r) => r.textContent ?? '');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('hopper-sandbox-kube at http://hopper:4790: curl: (6) Could not resolve host: hopper');
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('with no unreachable box, or no view, nothing is shown', async () => {
    await render(view([box('hopper-sandbox-claude')]));
    expect(document.getElementById('root')!.innerHTML).toBe('');
    await render(null);
    expect(document.getElementById('root')!.innerHTML).toBe('');
  });
});
