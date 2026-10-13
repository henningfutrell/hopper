// @vitest-environment happy-dom
// Issue #696: OpenFGA is a required service. When it is not set up or not reached, every page shows a banner with the
// compose fix, the TypeSafe API key's Save is off with that reason, and a save refused for it says the other settings
// are unchanged. A connected OpenFGA shows nothing.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_DOCS_URL, ACCESS_SAVE_FAILED, accessDown, saveError } from '../../ui/src/model/access-status.ts';

type Status = { state: 'connected' | 'not-configured' | 'unreachable'; why?: string };

let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; vi.unstubAllGlobals(); });

async function render(status: Status | null): Promise<Element> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const path = '../../ui/src/app/access.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { AccessBanner } = (await import(path)) as { AccessBanner: (p: { status: Status | null }) => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(AccessBanner, { status })); });
  return document.getElementById('root')!;
}

describe('access checks unavailable (#696)', () => {
  it('accessDown: the reason while OpenFGA is not set up or not reached; nothing while connected or unknown', () => {
    expect(accessDown(null)).toBeUndefined();
    expect(accessDown({ state: 'connected' })).toBeUndefined();
    expect(accessDown({ state: 'not-configured', why: 'OpenFGA is not set up: set HOPPER_OPENFGA_URL' })).toBe('OpenFGA is not set up: set HOPPER_OPENFGA_URL');
    expect(accessDown({ state: 'unreachable', why: 'connect ECONNREFUSED' })).toBe('connect ECONNREFUSED');
    expect(accessDown({ state: 'unreachable' })).toBe('OpenFGA is not reachable');
  });

  it('saveError: an Access outage says the other settings are unchanged; any other error as it is', () => {
    expect(saveError('access checks are unavailable: OpenFGA is not reachable: OpenFGA cannot be asked: connect ECONNREFUSED')).toBe(ACCESS_SAVE_FAILED);
    expect(ACCESS_SAVE_FAILED).toBe('Couldn\'t save: hopper\'s access service (OpenFGA) isn\'t running. Your other settings are unchanged.');
    expect(saveError('the key was not saved: the check against TypeSafe failed: 401')).toBe('the key was not saved: the check against TypeSafe failed: 401');
  });

  it('connected or unknown: no banner', async () => {
    expect((await render({ state: 'connected' })).querySelector('[data-access-notice]')).toBeNull();
    expect((await render(null)).querySelector('[data-access-notice]')).toBeNull();
  });

  it('not set up: the banner names why, the compose fix and links to the docs', async () => {
    const el = await render({ state: 'not-configured', why: 'OpenFGA is not set up: set HOPPER_OPENFGA_URL' });
    const banner = el.querySelector('[data-access-notice]')!;
    expect(banner.textContent).toContain('OpenFGA is not set up: set HOPPER_OPENFGA_URL');
    expect(banner.textContent).toContain('openfga');
    expect(banner.textContent).toContain('compose.yaml');
    // The fix is the update, which puts in the compose file the image ships with (issues #697, #970): never a hand edit.
    expect(banner.textContent).toContain('hopper update carry');
    expect(banner.textContent).toContain('How to update');
    expect(banner.textContent).not.toMatch(/copy the/i);
    expect(banner.querySelector('a')?.getAttribute('href')).toBe(ACCESS_DOCS_URL);
  });
});

describe('the TypeSafe API key while OpenFGA is down (#696)', () => {
  type Field = (p: { k: { set: boolean }; onSaved(): void; accessDown?: string }) => ReturnType<typeof createElement>;
  async function field(accessDown?: string): Promise<Element> {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '<div id="root"></div>';
    const store = '../../ui/src/store/index.ts';
    const { useHopper } = (await import(store)) as { useHopper: { setState(s: Record<string, unknown>): void } };
    useHopper.setState({ authed: true, user: { id: 'u1', name: 'ada', role: 'operator', realm: 'local', identity: 'ada' } });
    const mod = '../../ui/src/views/minor-decisions.tsx';
    const { TypesafeKeyField } = (await import(mod)) as { TypesafeKeyField: Field };
    const props = { k: { set: false }, onSaved: () => {}, ...(accessDown !== undefined ? { accessDown } : {}) };
    await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(TypesafeKeyField, props)); });
    return document.getElementById('root')!;
  }
  const save = (el: Element) => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Save')!;

  it('Save is off, with the reason and the fix, before a save is tried', async () => {
    const el = await field('OpenFGA is not set up: set HOPPER_OPENFGA_URL');
    expect(el.querySelector('input')!.disabled).toBe(true);
    expect(save(el).disabled).toBe(true);
    expect(el.querySelector('[data-key-access]')!.textContent).toContain('OpenFGA is not set up');
    expect(el.querySelector('[data-key-access] a')?.getAttribute('href')).toBe(ACCESS_DOCS_URL);
  });

  it('a save refused because OpenFGA is down says the other settings are unchanged, with the fix', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'access checks are unavailable: OpenFGA is not reachable: OpenFGA cannot be asked: connect ECONNREFUSED' }), { status: 503 })));
    const el = await field();
    const input = el.querySelector('input')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'ts-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => save(el).click());
    await vi.waitFor(() => expect(el.querySelector('[data-key-failed]')).not.toBeNull());
    expect(el.querySelector('[data-key-failed]')!.textContent).toContain(ACCESS_SAVE_FAILED);
    expect(el.querySelector('[data-key-failed] a')?.getAttribute('href')).toBe(ACCESS_DOCS_URL);
  });
});
