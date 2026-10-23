// Direct jobs in the UI (issue #901, part 2), pure: the submit form's draft, why it cannot be sent yet, the request it
// sends, and how a direct job reads back — its state, its result, who submitted it.
import { describe, expect, it } from 'vitest';
import { directDraftProblem, directJobRequest, directJobState, emptyDirectDraft, resultText, submittedLine } from '../../ui/src/model/direct-jobs.ts';
import type { DirectJobView } from '../../src/domain/direct-jobs.ts';

const draft = (more: Partial<ReturnType<typeof emptyDirectDraft>> = {}) => ({ ...emptyDirectDraft(), title: 'Unlock a sign-in', brief: 'Look up the lockout and clear it.', ...more });

const view = (job?: DirectJobView['job']): DirectJobView => ({
  id: 'd1', title: 'Unlock a sign-in', brief: 'Clear it.', labels: ['sme:identity'], authorizations: ['keycloak:otp-reset'],
  submittedBy: { person: 'ada', via: 'ui' }, submittedAt: '2026-10-12T10:00:00.000Z', artifacts: [], ...(job ? { job } : {}),
});

describe('the direct job form', () => {
  it('starts empty, with no repository and the default priority', () => {
    expect(emptyDirectDraft()).toEqual({ title: '', brief: '', labels: '', authorizations: '', repo: '', priority: '', promoteWhenDone: false, pushRequirements: '' });
  });

  it('says what is missing or wrong before it can be sent', () => {
    expect(directDraftProblem(emptyDirectDraft())).toBe('Give it a title');
    expect(directDraftProblem(draft({ brief: '  ' }))).toBe('Say what to do');
    expect(directDraftProblem(draft({ repo: 'just-a-name' }))).toBe('Give the repository as owner/name');
    expect(directDraftProblem(draft({ priority: '101' }))).toBe('Give the priority as a whole number from 0 to 100');
    expect(directDraftProblem(draft({ priority: '2.5' }))).toBe('Give the priority as a whole number from 0 to 100');
    expect(directDraftProblem(draft({ repo: 'acme/identity', priority: '75' }))).toBeUndefined();
    expect(directDraftProblem(draft())).toBeUndefined();
  });

  it('sends labels split at commas and lines, authorizations one per line, and only the fields given', () => {
    expect(directJobRequest(draft({ labels: 'sme:identity, urgent\nsme:identity', authorizations: 'keycloak:otp-reset\n\n read the audit log ' }))).toEqual({
      title: 'Unlock a sign-in', brief: 'Look up the lockout and clear it.', labels: ['sme:identity', 'urgent'], authorizations: ['keycloak:otp-reset', 'read the audit log'],
    });
    expect(directJobRequest(draft({ repo: ' acme/identity ', priority: '75' }))).toMatchObject({ repo: 'acme/identity', priority: 75 });
  });

  it('sends its own push requirements as JSON, a list or a requirements file\'s value, and says when it is no JSON (issue #2555 part 3)', () => {
    const lint = { id: 'lint', checks: [{ name: 'lint', run: 'npm run lint' }] };
    expect(directDraftProblem(draft({ pushRequirements: '[{ id: lint' }))).toBe('Give the push requirements as JSON: [{ "id", "when", "checks" }]');
    expect(directDraftProblem(draft({ pushRequirements: '{"id":"lint"}' }))).toBe('Give the push requirements as JSON: [{ "id", "when", "checks" }]');
    expect(directJobRequest(draft({ pushRequirements: JSON.stringify([lint]) }))).toMatchObject({ pushRequirements: [lint] });
    expect(directJobRequest(draft({ pushRequirements: JSON.stringify({ requirements: [lint] }) }))).toMatchObject({ pushRequirements: [lint] });
    expect(directJobRequest(draft({ pushRequirements: '  ' }))).not.toHaveProperty('pushRequirements');
  });
});

describe('a direct job as it reads back', () => {
  it('has a state from its job, and says when a question of it waits', () => {
    expect(directJobState(view())).toEqual({ status: 'queued', label: 'not queued yet' });
    expect(directJobState(view({ id: 'j1', status: 'running', questions: [] }))).toEqual({ status: 'running', label: 'running' });
    expect(directJobState(view({ id: 'j1', status: 'waiting_answer', questions: [{ id: 'q1', text: 'Which account?', tier: 'human', askedAt: '2026-10-12T10:05:00.000Z' }] })))
      .toEqual({ status: 'waiting_answer', label: '1 question waits' });
    expect(directJobState(view({ id: 'j1', status: 'finished', result: 'cleared', questions: [] }))).toEqual({ status: 'finished', label: 'finished' });
  });

  it('shows a text result as it is, and any other result as JSON', () => {
    expect(resultText('cleared')).toBe('cleared');
    expect(resultText({ unlocked: true })).toBe('{\n  "unlocked": true\n}');
    expect(resultText(undefined)).toBeUndefined();
  });

  it('says who submitted it and the way', () => {
    expect(submittedLine(view())).toBe('Submitted by ada in the UI');
    expect(submittedLine({ ...view(), submittedBy: { person: 'ada', via: 'api' } })).toBe('Submitted by ada with an API token');
    expect(submittedLine({ ...view(), submittedBy: { person: 'ada', via: 'cli' } })).toBe('Submitted by ada with the operator CLI');
  });
});
