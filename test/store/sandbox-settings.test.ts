// Issue #1001: the sandbox approvals keep the auto-approve policy; a value saved before it reads as the default.
import { describe, expect, it } from 'vitest';
import { autoApproveOf, DEFAULT_AUTO_APPROVE, editedApprovals, NO_SKIPS } from '../../src/domain/sandbox-approvals.ts';
import { sandboxSettings } from '../../src/store/sandbox-settings.ts';

function settings(start?: string) {
  const kept = new Map<string, string>(start ? [['sandboxApprovals', start]] : []);
  return { s: sandboxSettings((k) => kept.get(k), (k, v) => { kept.set(k, v); }), kept };
}

describe('sandbox approvals in the settings (issue #1001)', () => {
  it('a value saved before the policy reads as the default: low is auto, medium and high ask', () => {
    const { s } = settings('{"skipTemplateApproval":true,"skipSandboxApproval":false}');
    const a = s.getSandboxApprovals()!;
    expect(a).toMatchObject({ skipTemplateApproval: true, skipSandboxApproval: false });
    expect(autoApproveOf(a)).toEqual(DEFAULT_AUTO_APPROVE);
    expect(DEFAULT_AUTO_APPROVE).toEqual({ low: true, medium: false, high: false });
  });

  it('keeps the policy it is given', () => {
    const { s } = settings();
    s.setSandboxApprovals({ ...NO_SKIPS, autoApprove: { low: false, medium: true, high: false } });
    expect(autoApproveOf(s.getSandboxApprovals())).toEqual({ low: false, medium: true, high: false });
  });

  it('an edit names only the levels it changes', () => {
    const a = editedApprovals(NO_SKIPS, { autoApprove: { medium: true } });
    expect(autoApproveOf(a)).toEqual({ low: true, medium: true, high: false });
    expect(autoApproveOf(editedApprovals(a, { autoApprove: { low: false } }))).toEqual({ low: false, medium: true, high: false });
    expect(editedApprovals(a, { yolo: true })).toMatchObject({ skipTemplateApproval: true, skipSandboxApproval: true, autoApprove: { medium: true } });
  });
});
