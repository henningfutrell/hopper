// Issue #602: the Machines view says whether a sandbox box takes jobs: its template, approved or waiting for approval.
import { describe, expect, it } from 'vitest';
import { templateText } from '../../ui/src/model/machines.ts';

describe('a box\'s template on Machines', () => {
  const base = { id: 'hopper-sandbox-kube', label: 'hopper-sandbox-kube', maxLanes: 1, online: true, executors: [], client: {} };

  it('waiting for approval: it takes no job, and says why', () => {
    expect(templateText({ ...base, template: { name: 'kube', waiting: 'waiting for template approval: kube is not approved' } }))
      .toBe('kube: takes no job, waiting for template approval: kube is not approved');
  });

  it('approved: it takes jobs', () => {
    expect(templateText({ ...base, template: { name: 'kube' } })).toBe('kube, approved: takes jobs');
  });

  it('a machine of no template: nothing', () => {
    expect(templateText(base)).toBeNull();
  });
});
