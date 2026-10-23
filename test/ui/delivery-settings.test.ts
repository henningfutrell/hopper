// Delivery settings in Settings (issue #2554 part 3): the repositories' settings edited as JSON, and the change a save
// sends — each repository whole, `null` for one taken away, nothing when the text says what is saved.
import { describe, expect, it } from 'vitest';
import { deliveryPatch } from '../../ui/src/model/delivery-settings.ts';

const repo = { gates: { test_gate: { owner: 'release-owner' } } };

describe('deliveryPatch', () => {
  it('no change: no patch', () => {
    expect(deliveryPatch({ repos: { 'octo/shed': repo } }, JSON.stringify({ 'octo/shed': repo }, null, 2))).toEqual({ patch: undefined });
  });
  it('a changed or new repository goes whole, one taken away goes as null', () => {
    const text = JSON.stringify({ 'octo/new': { gates: {} }, 'octo/shed': { gates: {} } });
    expect(deliveryPatch({ repos: { 'octo/shed': repo, 'octo/old': repo } }, text))
      .toEqual({ patch: { repos: { 'octo/new': { gates: {} }, 'octo/shed': { gates: {} }, 'octo/old': null } } });
  });
  it('text that is no JSON object of repositories: a problem, no patch', () => {
    for (const text of ['{', '[]', '"x"', '{"octo/shed": 3}']) expect(deliveryPatch({ repos: {} }, text)).toMatchObject({ problem: expect.any(String) });
  });
});
