// @vitest-environment happy-dom
// Issue #2123: the Access requests badge counted the templates with an unknown asset (issue #2067), but the page showed
// no row for them. Each one counted now renders on Access requests, with its reason and what fixes it: a cluster
// override, an edit on Settings → Vault, or Remove.
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { unknownAssetLines, unknownAssetTemplates } from '../../ui/src/model/vault.ts';
import type { TemplateView, VaultView } from '../../ui/src/model/wire.ts';

const unknown = { asset: { kind: 'cluster' as const, name: 'staging' }, cluster: 'staging', known: ['staging-eks', 'control-plane-eks'] };
const template = (name: string, o: Partial<TemplateView> = {}) => ({
  name, image: 'img', secrets: [], profiles: [{ operation: 'read', asset: unknown.asset }], savedBy: 'job j0', savedAt: '',
  approval: { image: 'img', secrets: [], by: 'the read policy', at: '' }, pending: { secrets: [], image: false, egress: [], profiles: [] }, gives: [],
  radius: { level: 'low', reasons: [] }, unknownAssets: [unknown], ...o,
}) as unknown as TemplateView;
const view = { templates: [template('asked-1'), template('asked-2'), template('kube', { unknownAssets: undefined })] } as unknown as VaultView;

const panel = '../../ui/src/views/unknown-assets.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
type Props = { templates: TemplateView[]; can: boolean };
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; });
async function render(templates: TemplateView[], can: boolean): Promise<HTMLElement> {
  const { UnknownAssets } = (await import(panel)) as { UnknownAssets: (p: Props) => ReactNode };
  const el = document.body.appendChild(document.createElement('div'));
  root = createRoot(el);
  act(() => root!.render(createElement(UnknownAssets, { templates, can })));
  return el;
}

describe('unknown assets on Access requests (issue #2123)', () => {
  it('the templates counted are the templates listed', () => {
    expect(unknownAssetTemplates(view).map((t) => t.name)).toEqual(['asked-1', 'asked-2']);
    expect(unknownAssetLines(view)).toHaveLength(unknownAssetTemplates(view).length);
    expect(unknownAssetTemplates(null)).toEqual([]);
  });

  it('renders one row per counted template, with its reason and the fixes', async () => {
    const el = await render(unknownAssetTemplates(view), true);
    const rows = el.querySelectorAll('[data-unknown-asset]');
    expect([...rows].map((r) => r.getAttribute('data-unknown-asset'))).toEqual(['asked-1', 'asked-2']);
    const first = rows[0]!;
    expect(first.textContent).toContain('no cluster staging; known: staging-eks, control-plane-eks');
    expect(first.querySelector('a[href="#settings/clusters"]')).not.toBeNull();
    expect(first.querySelector('a[href="#settings/vault"]')).not.toBeNull();
    expect([...first.querySelectorAll('button')].some((b) => b.textContent?.includes('Remove'))).toBe(true);
  });

  it('a person who is not an admin gets no Remove', async () => {
    const el = await render(unknownAssetTemplates(view), false);
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Remove'))).toBe(false);
  });

  it('says so when no template has an unknown asset', async () => {
    const el = await render([], true);
    expect(el.querySelectorAll('[data-unknown-asset]')).toHaveLength(0);
    expect(el.textContent).toContain('No template names a cluster the vault cannot find');
  });
});
