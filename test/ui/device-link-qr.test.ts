// @vitest-environment happy-dom
// Issue #95: a logged-in browser shows the device link as a QR code, so a phone takes it with its
// camera. The QR follows the login code: while the dialog is open it asks the daemon to keep the
// code it shows, and when that code is used or expired the daemon answers a fresh one and the QR
// changes with it. Closing the dialog stops asking. Rendered against a fake of the daemon's HTTP.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const link = (code: string, host = 'server') => `http://${host}:4790/#login=${code}`;

let bodies: unknown[] = [];
/** The daemon's current code; the test changes it to play a phone using the shown one. */
let current = A;

function fakeDaemon() {
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    if (String(input) !== '/ui/api/device-link') return new Response('{"error":"not found"}', { status: 404 });
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ links: [link(current), link(current, 'server.lan')] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

let root: Root | undefined;

async function render() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  bodies = [];
  current = A;
  vi.stubGlobal('fetch', fakeDaemon());
  const mod = '../../ui/src/app/device-link.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { DeviceLink } = (await import(mod)) as { DeviceLink: (p: { pollMs?: number }) => ReturnType<typeof createElement> };
  const { TooltipProvider } = await import('../../ui/src/components/ui/tooltip.tsx');
  await act(async () => {
    root = createRoot(document.getElementById('root')!);
    root.render(createElement(TooltipProvider, null, createElement(DeviceLink, { pollMs: 20 })));
  });
}

const open = async () => {
  const b = document.querySelector<HTMLElement>('button[aria-label="Log in another device"]');
  expect(b).toBeTruthy();
  await act(async () => { b!.click(); });
};
const qrs = () => [...document.querySelectorAll<HTMLElement>('[data-device-link]')];
const shown = () => qrs().map((e) => e.dataset.deviceLink);
const drawing = (e: HTMLElement) => e.querySelector('svg')?.innerHTML ?? '';

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Device link QR', () => {
  it('shows a QR code per link, drawn from that link', async () => {
    await render();
    await open();
    await vi.waitFor(() => expect(shown()).toEqual([link(A), link(A, 'server.lan')]));
    for (const e of qrs()) expect(e.querySelector('svg')).not.toBeNull();
    expect(drawing(qrs()[0]!)).not.toBe(drawing(qrs()[1]!));
    expect(bodies[0]).toEqual({});
  });

  it('asks the daemon to keep the shown code, and when it is used the QR changes to the fresh one', async () => {
    await render();
    await open();
    await vi.waitFor(() => expect(shown()[0]).toBe(link(A)));
    const before = drawing(qrs()[0]!);
    await vi.waitFor(() => expect(bodies).toContainEqual({ keep: A }));

    current = B;
    await vi.waitFor(() => expect(shown()).toEqual([link(B), link(B, 'server.lan')]));
    expect(drawing(qrs()[0]!)).not.toBe(before);
    await vi.waitFor(() => expect(bodies).toContainEqual({ keep: B }));
  });

  it('closing the dialog stops asking', async () => {
    await render();
    await open();
    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(1));
    const done = [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === 'Done');
    await act(async () => { done!.click(); });
    const n = bodies.length;
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(qrs()).toEqual([]);
    expect(bodies.length).toBeLessThanOrEqual(n + 1);
  });
});
