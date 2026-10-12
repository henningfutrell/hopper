// @vitest-environment happy-dom
// Issue #909: the grant form's scopes are never typed. The presets come first, each with what it does; then every scope
// of the registry is a box, in its section, always open, with its description, scope, routes and marks. A preset ticks
// its boxes; a box ticks or clears one scope; a ticked box action says the grant is a box grant.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scopeRegistry } from '../../src/domain/scope-registry.ts';
import { registryRoutes } from '../../src/http/scopes.ts';
import { isBoxAction } from '../../src/http/ui/box-actions.ts';

const registry = scopeRegistry(registryRoutes(), isBoxAction);

let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; });

async function render(scopes: string[], onChange: (s: string[]) => void, role = 'operator'): Promise<Element> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const path = '../../ui/src/views/scope-checklist.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { ScopeChecklist } = (await import(path)) as { ScopeChecklist: (p: object) => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(ScopeChecklist, { registry, scopes, onChange, role, disabled: false })); });
  return document.getElementById('root')!;
}

const box = (el: Element, scope: string) => el.querySelector<HTMLInputElement>(`input[name="scope-${scope}"]`)!;

describe('the scope checklist (#909)', () => {
  it('lays out every section and every scope as a box, with no text field', async () => {
    const el = await render(['*:read'], () => {});
    expect([...el.querySelectorAll('legend')].map((l) => l.textContent)).toEqual(registry.sections.map((s) => s.title));
    expect(el.querySelectorAll('input[type="checkbox"]')).toHaveLength(registry.sections.flatMap((s) => s.permissions).length);
    expect(el.querySelector('input:not([type="checkbox"]), textarea')).toBeNull();
    expect(box(el, 'jobs:read').checked).toBe(true);
    expect(box(el, 'sources:intake').checked).toBe(false);
    expect(el.textContent).toContain('POST /ui/api/sources/:name/intake');
    expect(el.textContent).not.toContain('A box grant: ');
  });

  it('a preset ticks its scopes; a box ticks one more', async () => {
    const onChange = vi.fn();
    const el = await render(['*:read'], onChange);
    const preset = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Agent: read everything and approve intake')!;
    await act(async () => preset.click());
    expect(onChange).toHaveBeenLastCalledWith(['*:read', 'sources:intake']);
    await act(async () => box(el, 'jobs:approve').click());
    expect(onChange).toHaveBeenLastCalledWith(['*:read', 'jobs:approve']);
  });

  it('a ticked box action says it is a box grant; a scope above the grant\'s role is marked', async () => {
    const el = await render(['*:read', 'sources:intake'], () => {}, 'viewer');
    expect(el.textContent).toContain('A box grant: 1 ticked scope is a box action — sources:intake');
    expect(box(el, 'sources:intake').closest('label')!.textContent).toContain('needs operator');
  });
});
