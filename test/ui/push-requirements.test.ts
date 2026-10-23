// The default push requirements in the UI (issue #2555), pure: what the panel says is set, and the check of the JSON a
// person edits before it is sent.
import { describe, expect, it } from 'vitest';
import { pushRequirementMetricsLine, pushRequirementsSummary, requirementsDraft, requirementsText } from '../../ui/src/model/push-requirements.ts';

const WORKFLOWS = { id: 'workflows', when: { workflows: true as const }, checks: [{ name: 'actionlint', run: 'actionlint' }] };

describe('the Push requirements panel', () => {
  it('says which default requirements are set', () => {
    expect(pushRequirementsSummary([])).toBe('No default requirements. Only a repository\'s own requirements apply.');
    expect(pushRequirementsSummary([WORKFLOWS])).toBe('1 default requirement: workflows.');
    expect(pushRequirementsSummary([WORKFLOWS, { ...WORKFLOWS, id: 'deps' }])).toBe('2 default requirements: workflows, deps.');
  });

  it('sends the edited JSON, none for an empty editor, and refuses text that is not a requirements list', () => {
    expect(requirementsDraft(requirementsText([WORKFLOWS]))).toEqual({ ok: true, body: { requirements: [WORKFLOWS] } });
    expect(requirementsDraft('  ')).toEqual({ ok: true, body: { requirements: [] } });
    expect(requirementsDraft('requirements: []')).toEqual({ ok: false, error: 'This is not JSON' });
    expect(requirementsDraft('[]')).toEqual({ ok: false, error: 'Write { "requirements": [ ... ] }' });
    expect(requirementsDraft('null')).toEqual({ ok: false, error: 'Write { "requirements": [ ... ] }' });
  });

  it('says what the requirements caught and missed (part 5)', () => {
    const none = { days: 30, caught: 0, minutesSaved: 0, unpriced: 0, missed: 0, minutesMissed: 0, repos: [] };
    expect(pushRequirementMetricsLine(none)).toBe('Last 30 days: No CI run caught; no CI run missed.');
    expect(pushRequirementMetricsLine({ ...none, caught: 3, minutesSaved: 94, unpriced: 1, missed: 1, minutesMissed: 47 }))
      .toBe('Last 30 days: 3 CI runs caught before the push, 94 billed minutes saved (1 with no minutes set); 1 CI run failed on a check a requirement should have caught (47 billed minutes).');
  });
});
