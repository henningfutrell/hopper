// @vitest-environment happy-dom
// Issue #521: the update notice of a container install is one line until asked, and its commands are one
// container tool's — the one this browser chose last, Podman until Docker is chosen. Rendered in happy-dom
// against the store.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type El = ReturnType<typeof createElement>;
const store = '../../ui/src/store/index.ts';
const toolHook = '../../ui/src/hooks/use-container-tool.ts'; // browser code, type-checked by ui/tsconfig.json: imported by path
interface Store { useHopper: { setState(s: Record<string, unknown>): void } }
const image = {
  state: 'available', channel: 'dev', autoUpdate: false, whatsNew: [], installedWhatsNew: [], restartBlockers: 2,
  target: { commit: 'beef'.padEnd(40, '0'), ref: 'dev' },
  installed: { kind: 'image', repo: 'https://github.com/o/r', branch: 'stable', commit: 'c0ffee1'.padEnd(40, '0'), installedAt: '2026-10-06T10:00:00Z' },
};
let root: Root | undefined;

async function render(mod: string, name: string, update: unknown = image) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  const { useHopper } = (await import(store)) as Store;
  useHopper.setState({ authed: true, update, health: { ok: true, version: '0.1.0', uptimeS: 1 } });
  const view = (await import(mod)) as Record<string, () => El>;
  const tooltip = '../../ui/src/components/ui/tooltip.tsx';
  const { TooltipProvider } = (await import(tooltip)) as { TooltipProvider: (p: { children?: unknown }) => El };
  await act(async () => {
    root = createRoot(document.getElementById('root')!);
    root.render(createElement(TooltipProvider, null, createElement(view[name]!)));
  });
}

const reloadTool = async () => ((await import(toolHook)) as { reloadContainerTool(): void }).reloadContainerTool();
const button = (scope: ParentNode, name: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === name);
const pick = (tool: string) => document.querySelector<HTMLButtonElement>(`[data-slot="container-tool"] button[data-tool="${tool}"]`);

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  localStorage.clear();
  await reloadTool();
  window.location.hash = '';
  vi.unstubAllGlobals();
});

describe('the container update notice, slim (issue #521)', () => {
  // Issue #521: one container tool's commands at a time, the one this browser chose last (Podman until one is chosen).
  it('Version shows one container tool\'s commands, and switching shows the other\'s', async () => {
    window.location.hash = '#settings/version';
    await render('../../ui/src/views/settings.tsx', 'Settings', image);
    const block = () => document.querySelector('[data-slot="image-update"]')!;
    expect(block().textContent).not.toContain('docker compose');
    expect(pick('Podman')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => pick('Docker')!.click());
    expect(block().textContent).toContain('docker compose pull hopper && docker compose up -d --force-recreate --no-deps hopper');
    expect(block().textContent).toContain('docker image prune -f --filter label=org.opencontainers.image.title=hopper');
    expect(block().textContent).not.toContain('podman compose');
    expect(localStorage.getItem('jh_container_tool')).toBe('Docker');
  });

  // Issue #521: the notice is one line until asked; the commands and the restart-blocker count wait behind How to update.
  it('the update notice is one line: no commands, no restart-blocker note, until How to update', async () => {
    await render('../../ui/src/app/update.tsx', 'UpdateNotice', image);
    const notice = document.querySelector('[data-update-notice]')!;
    expect(notice.querySelector('[data-slot="image-update"]')).toBeNull();
    expect(notice.textContent).not.toContain('compose pull');
    expect(notice.textContent).not.toContain('running jobs would be lost');
    expect([...notice.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Update now');
    await act(async () => button(notice, 'How to update')!.click());
    expect(notice.textContent).toContain('podman compose pull hopper && podman compose up -d --force-recreate --no-deps hopper');
    expect(notice.textContent).not.toContain('docker compose');
    expect(notice.textContent).toContain('HOPPER_IMAGE=ghcr.io/henningfutrell/hopper:dev');
    expect(notice.textContent).toContain('2 running jobs would be lost');
  });

  it('the notice remembers the container tool chosen in this browser', async () => {
    localStorage.setItem('jh_container_tool', 'Docker');
    await reloadTool();
    await render('../../ui/src/app/update.tsx', 'UpdateNotice', image);
    const notice = document.querySelector('[data-update-notice]')!;
    await act(async () => button(notice, 'How to update')!.click());
    expect(notice.textContent).toContain('docker compose pull hopper');
    expect(notice.textContent).not.toContain('podman compose');
  });

  it('What\'s new and How to update open one at a time', async () => {
    await render('../../ui/src/app/update.tsx', 'UpdateNotice', { ...image, whatsNew: ['You can now do a new thing.'] });
    const notice = document.querySelector('[data-update-notice]')!;
    expect(notice.textContent).not.toContain('You can now do a new thing.');
    await act(async () => button(notice, 'How to update')!.click());
    expect(notice.querySelector('[data-slot="image-update"]')).not.toBeNull();
    await act(async () => button(notice, "What's new")!.click());
    expect(notice.textContent).toContain('You can now do a new thing.');
    expect(notice.querySelector('[data-slot="image-update"]')).toBeNull();
  });
});
