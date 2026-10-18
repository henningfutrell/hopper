// Direct push (issue #1806), with yolo mode: the repositories where a job may push straight to the target branch. Off
// unless a person names the repository; any repository, a job repository or not; case does not matter. Pure.
import { describe, expect, it } from 'vitest';
import { DEFAULT_YOLO_MODE, directPushFor, patchYoloMode } from '../../src/domain/types.ts';

describe('direct push (issue #1806)', () => {
  it('is off unless a person names the repository, whatever yolo mode says', () => {
    expect(directPushFor(DEFAULT_YOLO_MODE, 'acme/api')).toBe(false);
    expect(directPushFor({ on: true, repos: { 'acme/api': true } }, 'acme/api')).toBe(false);
    expect(directPushFor({ on: false, repos: {}, push: ['acme/api'] }, 'Acme/API')).toBe(true);
    expect(directPushFor({ on: false, repos: {}, push: ['acme/api'] }, 'acme/web')).toBe(false);
  });

  it('a change replaces the list, lowercased, sorted and once each; an empty list removes it; other changes keep it', () => {
    const s = patchYoloMode(DEFAULT_YOLO_MODE, { push: ['Zed/Tool', 'acme/api', 'ACME/api'] });
    expect(s).toEqual({ on: false, repos: {}, push: ['acme/api', 'zed/tool'] });
    expect(patchYoloMode(s, { on: true })).toEqual({ on: true, repos: {}, push: ['acme/api', 'zed/tool'] });
    expect(patchYoloMode(s, { push: [] })).toEqual({ on: false, repos: {} });
  });
});
