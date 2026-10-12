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
    expect(block().textContent).not.toContain('docker run');
    expect(pick('Podman')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => pick('Docker')!.click());
    expect(block().textContent).toContain('docker run --rm --pull=always ghcr.io/henningfutrell/hopper:dev hopper update docker > hopper-update.sh');
    expect(block().textContent).toContain('docker image prune -f --filter label=org.opencontainers.image.title=hopper');
    expect(block().textContent).not.toContain('podman run');
    expect(localStorage.getItem('jh_container_tool')).toBe('Docker');
  });

  // Issue #521: the notice is one line until asked; the commands and the restart-blocker count wait behind How to update.
  it('the update notice is one line: no commands, no restart-blocker note, until How to update', async () => {
    await render('../../ui/src/app/update.tsx', 'UpdateNotice', image);
    const notice = document.querySelector('[data-update-notice]')!;
    expect(notice.querySelector('[data-slot="image-update"]')).toBeNull();
    expect(notice.textContent).not.toContain('hopper update');
    expect(notice.textContent).not.toContain('running jobs would be lost');
    expect([...notice.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Update now');
    await act(async () => button(notice, 'How to update')!.click());
    expect(notice.textContent).toContain('podman run --rm --pull=always ghcr.io/henningfutrell/hopper:dev hopper update podman > hopper-update.sh');
    expect(notice.textContent).toContain('sh hopper-update.sh');
    expect(notice.textContent).not.toContain('docker run');
    expect(notice.textContent).toContain('2 running jobs would be lost');
  });

  it('the notice remembers the container tool chosen in this browser', async () => {
    localStorage.setItem('jh_container_tool', 'Docker');
    await reloadTool();
    await render('../../ui/src/app/update.tsx', 'UpdateNotice', image);
    const notice = document.querySelector('[data-update-notice]')!;
    await act(async () => button(notice, 'How to update')!.click());
    expect(notice.textContent).toContain('docker run --rm --pull=always');
    expect(notice.textContent).not.toContain('podman run');
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

describe('the update notice names the commit (issue #652)', () => {
  it('an available update: the commit, and the pull request whose checks passed, linked', async () => {
    const pullRequest = { number: 9, url: 'https://github.com/o/r/pull/9' };
    await render('../../ui/src/app/update.tsx', 'UpdateNotice', { ...image, target: { ...image.target, pullRequest } });
    const line = document.querySelector('[data-update-notice] [data-slot="update-target"]')!;
    expect(line.textContent).toBe('dev beef000 · pull request #9, checks passed');
    expect(line.querySelector('a')?.getAttribute('href')).toBe('https://github.com/o/r/pull/9');
  });

  it('a held update: why, the commit, and nothing to apply or run', async () => {
    await render('../../ui/src/app/update.tsx', 'UpdateNotice', { ...image, state: 'held', reason: 'beef000 is not the merge of a pull request' });
    const notice = document.querySelector('[data-update-notice]')!;
    expect(notice.textContent).toContain('Update held: beef000 is not the merge of a pull request');
    expect(notice.querySelector('[data-slot="update-target"]')?.textContent).toBe('dev beef000');
    expect(button(notice, 'How to update')).toBeUndefined();
    expect(button(notice, 'Update now')).toBeUndefined();
  });
});
