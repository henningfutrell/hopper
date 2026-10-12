// Out-of-band changes in the UI (ui/src/model/out-of-band.ts, issue #871), pure: each change in one line — where it was
// found, what changed, who did it — and its state: open until a person marks it, then the mark and why.
import { describe, expect, it } from 'vitest';
import { changeHeadline, changeState, controllersFrom } from '../../ui/src/model/out-of-band.ts';
import type { OutOfBandView } from '../../src/domain/types.ts';

const change: OutOfBandView = {
  id: '11111111-2222-4333-8444-555555555555', source: 'cloudtrail', key: 'evt-1', target: 'sg-0abc', what: 'ec2:AuthorizeSecurityGroupIngress',
  who: 'arn:aws:sts::123456789012:assumed-role/Admin/console', at: '2026-10-12T10:00:00Z', job: 'j1', recordedAt: '2026-10-12T10:05:00.000Z',
};

describe('the out-of-band changes model', () => {
  it('says where a change was found, what changed and who did it', () => {
    expect(changeHeadline(change)).toBe('CloudTrail: ec2:AuthorizeSecurityGroupIngress on sg-0abc, by arn:aws:sts::123456789012:assumed-role/Admin/console');
    const { who: _who, ...drift } = change;
    expect(changeHeadline({ ...drift, source: 'gitops', what: 'OutOfSync', target: 'argocd app web' })).toBe('GitOps drift: OutOfSync on argocd app web');
  });

  it('a change is open until a person marks it; then the mark, who, and why', () => {
    expect(changeState(change).kind).toBe('open');
    expect(changeState({ ...change, marked: { change: change.id, mark: 'accepted', reason: 'break-glass fix', by: 'Ada', at: '2026-10-12T11:00:00Z' } }))
      .toEqual({ kind: 'marked', words: 'Accepted by Ada: break-glass fix' });
    expect(changeState({ ...change, marked: { change: change.id, mark: 'adopted', by: 'Ada', at: '2026-10-12T11:00:00Z' } }).words).toBe('Adopted into git by Ada');
  });

  it('reads controller identities one per line', () => {
    expect(controllersFrom(' system:serviceaccount:argocd:*\n\n arn:aws:sts::123456789012:assumed-role/atlantis/* \n')).toEqual(['system:serviceaccount:argocd:*', 'arn:aws:sts::123456789012:assumed-role/atlantis/*']);
  });
});
