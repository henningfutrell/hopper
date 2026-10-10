// @vitest-environment happy-dom
// Issue #659: the banner about the master key. A key the hopper made, or read from the old token key, is shown once to
// the hopper's admin, and the banner stays until they say they saved it; then it says to give the key at launch. A
// limited hopper says which key is missing and how to give it. A key given at launch shows nothing.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MasterKeyView } from '../../src/domain/types.ts';

type Props = { view: MasterKeyView; admin: boolean; revealed?: string; onReveal(): void; onSaved(): void };

let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; });

async function render(p: Partial<Props> & { view: MasterKeyView }): Promise<{ el: Element; props: Props }> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const path = '../../ui/src/app/master-key.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { MasterKeyBanner } = (await import(path)) as { MasterKeyBanner: (p: Props) => ReturnType<typeof createElement> };
  const props: Props = { admin: true, onReveal: vi.fn(), onSaved: vi.fn(), ...p };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(MasterKeyBanner, props)); });
  return { el: document.getElementById('root')!, props };
}

const KEY = 'ab'.repeat(32);
const button = (el: Element, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

describe('the master key banner (#659)', () => {
  it('a key given at launch: nothing', async () => {
    const { el } = await render({ view: { source: 'given', fingerprint: '0123456789abcdef', saved: true, revealable: false } });
    expect(el.querySelector('[data-master-key]')).toBeNull();
  });

  it('a key made at the first start: save it now; the admin may show it once and say it is saved', async () => {
    const { el, props } = await render({ view: { source: 'generated', fingerprint: '0123456789abcdef', saved: false, revealable: true } });
    const banner = el.querySelector('[data-master-key]')!;
    expect(banner.textContent).toContain('Save the master key now');
    expect(banner.textContent).toContain('HOPPER_MASTER_KEY');
    expect(banner.textContent).toContain('password manager');
    await act(async () => button(el, 'Show the key')!.click());
    expect(props.onReveal).toHaveBeenCalledOnce();
    await act(async () => button(el, 'I saved it')!.click());
    expect(props.onSaved).toHaveBeenCalledOnce();
  });

  it('the key shown once: in the banner, with no second Show', async () => {
    const { el } = await render({ view: { source: 'generated', fingerprint: '0123456789abcdef', saved: false, revealable: false }, revealed: KEY });
    expect(el.querySelector('[data-master-key-value]')?.textContent).toBe(KEY);
    expect(button(el, 'Show the key')).toBeUndefined();
  });

  it('not the admin: no Show and no I saved it, and who can', async () => {
    const { el } = await render({ admin: false, view: { source: 'generated', fingerprint: '0123456789abcdef', saved: false, revealable: true } });
    expect(button(el, 'Show the key')).toBeUndefined();
    expect(button(el, 'I saved it')).toBeUndefined();
    expect(el.textContent).toContain('the hopper\'s admin');
  });

  it('saved, but not given at launch yet: says to give it, by its fingerprint', async () => {
    const { el } = await render({ view: { source: 'old-token-key', fingerprint: '0123456789abcdef', saved: true, revealable: false } });
    const banner = el.querySelector('[data-master-key]')!;
    expect(banner.textContent).toContain('HOPPER_MASTER_KEY');
    expect(banner.textContent).toContain('0123456789abcdef');
    expect(banner.textContent).toContain('old token key');
    expect(button(el, 'I saved it')).toBeUndefined();
  });

  it('limited: which key is missing and how to give it; nothing deleted', async () => {
    const problem = 'the master key is missing: this database was set up with the key of fingerprint 0123456789abcdef; give it as HOPPER_MASTER_KEY at launch and restart';
    const { el } = await render({ view: { source: 'missing', fingerprint: '0123456789abcdef', saved: false, revealable: false, problem } });
    const banner = el.querySelector('[data-master-key]')!;
    expect(banner.textContent).toContain('Limited');
    expect(banner.textContent).toContain(problem);
    expect(banner.textContent).toContain('Nothing is deleted');
  });
});
