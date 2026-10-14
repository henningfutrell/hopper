// @vitest-environment happy-dom
// Issue #697: a container hopper whose stack has drifted from the compose file of its version shows one banner over every
// view: each gap, what it turns off, and the fix — the update script made from the image it runs. The OpenFGA banner
// (#696) gives way to it when OpenFGA is one of its gaps, so one cause is said once. No gap: nothing.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { StackDrift } from '../../src/domain/types.ts';
import { asDrift, driftFix, driftNamesOpenFga } from '../../ui/src/model/drift.ts';

let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; });

async function render(drift: StackDrift | null): Promise<Element> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const path = '../../ui/src/app/drift.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { DriftBanner } = (await import(path)) as { DriftBanner: (p: { drift: StackDrift | null }) => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(DriftBanner, { drift })); });
  return document.getElementById('root')!;
}

const IMAGE = 'ghcr.io/henningfutrell/hopper:beta';
const DRIFTED: StackDrift = {
  state: 'checked',
  image: IMAGE,
  gaps: [
    { kind: 'service', name: 'openfga', what: 'the service openfga is not running in this stack', off: 'Access checks: the TypeSafe API key cannot be saved' },
    { kind: 'setting', name: 'HOPPER_OPENFGA_URL', what: 'the hopper lacks settings of this version: its compose.yaml is older' },
  ],
};

describe('a stack drifted from the compose file of this version (#697)', () => {
  it('driftFix: the update command with the image the hopper runs, for each container tool (issues #970, #1104)', () => {
    expect(driftFix(IMAGE, 'Podman')).toBe(`podman run --rm --pull=always ${IMAGE} hopper update script | bash -s -- ${IMAGE}`);
    expect(driftFix(IMAGE, 'Docker')).toBe(`docker run --rm --pull=always ${IMAGE} hopper update script | bash -s -- ${IMAGE}`);
  });

  it('driftNamesOpenFga: only when OpenFGA is a missing service', () => {
    expect(driftNamesOpenFga(DRIFTED)).toBe(true);
    expect(driftNamesOpenFga({ ...DRIFTED, gaps: DRIFTED.gaps.slice(1) })).toBe(false);
    expect(driftNamesOpenFga(null)).toBe(false);
  });

  it('asDrift: only a body with gaps is a drift (a daemon from before answers no such route)', () => {
    expect(asDrift(DRIFTED)).toBe(DRIFTED);
    expect(asDrift({})).toBeNull();
    expect(asDrift(null)).toBeNull();
  });

  it('no gap, not checked, or not read: no banner', async () => {
    expect((await render(null)).querySelector('[data-stack-drift]')).toBeNull();
    expect((await render({ state: 'checked', gaps: [] })).querySelector('[data-stack-drift]')).toBeNull();
    expect((await render({ state: 'unchecked', reason: 'not a container install', gaps: [] })).querySelector('[data-stack-drift]')).toBeNull();
  });

  it('names each gap, what it turns off, and the fix', async () => {
    const banner = (await render(DRIFTED)).querySelector('[data-stack-drift]')!;
    const text = banner.textContent!;
    expect(text).toContain('the service openfga is not running in this stack');
    expect(text).toContain('the TypeSafe API key cannot be saved');
    expect(text).toContain('HOPPER_OPENFGA_URL');
    expect(text).toContain(`podman run --rm --pull=always ${IMAGE} hopper update script | bash -s -- ${IMAGE}`);
    expect(text).toMatch(/[Nn]ever recreate the hopper.s container alone/);
  });
});
