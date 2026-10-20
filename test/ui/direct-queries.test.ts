// Direct queries in the UI (issue #2184, part 2), pure: the ask form's draft, why it cannot be sent yet, the request it
// sends with a new request id, and how a query reads back — where it stands, whether it can be cancelled.
import { describe, expect, it } from 'vitest';
import { canCancelQuery, directQueryRequest, emptyQueryDraft, newRequestId, onlyDirectJobs, queryDraftProblem, queryStateOf } from '../../ui/src/model/direct-queries.ts';
import type { DirectJobView, DirectQueryView } from '../../src/domain/direct-jobs.ts';

const draft = (more: Partial<ReturnType<typeof emptyQueryDraft>> = {}) => ({ ...emptyQueryDraft(), question: 'Where does the otel collector run?', ...more });
const job: DirectJobView = { id: 'd1', title: 'Unlock', brief: 'Clear it.', labels: [], authorizations: [], submittedBy: { person: 'ada', via: 'ui' }, submittedAt: '2026-10-12T10:00:00.000Z', artifacts: [] };
const query = (state: DirectQueryView['state']): DirectQueryView => ({ ...job, id: 'query-1', labels: ['direct:query'], query: { requestId: 'r-1' }, state });

describe('the direct query form', () => {
  it('starts empty', () => {
    expect(emptyQueryDraft()).toEqual({ question: '', callback: '', repos: '', clusters: '' });
  });

  it('says what is missing or wrong before it can be sent', () => {
    expect(queryDraftProblem(emptyQueryDraft())).toBe('Ask a question');
    expect(queryDraftProblem(draft({ repos: 'octo-org/infra, just-a-name' }))).toBe('Give each repository as owner/name');
    expect(queryDraftProblem(draft({ repos: 'octo-org/infra', clusters: 'prod' }))).toBeUndefined();
  });

  it('sends the question with the request id, hints split at commas and lines, and only the fields given', () => {
    expect(directQueryRequest(draft(), 'ui-1')).toEqual({ requestId: 'ui-1', question: 'Where does the otel collector run?', mode: 'look', repos: [], clusters: [] });
    expect(directQueryRequest(draft({ callback: ' grok-bot ', repos: 'octo-org/infra\nocto-org/infra', clusters: 'prod, staging' }), 'ui-2')).toEqual({
      requestId: 'ui-2', question: 'Where does the otel collector run?', mode: 'look', callback: 'grok-bot', repos: ['octo-org/infra'], clusters: ['prod', 'staging'],
    });
  });

  it('makes a new request id each time, without a secure context', () => {
    const a = newRequestId(), b = newRequestId();
    expect(a).toMatch(/^ui-[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('a direct query read back', () => {
  it('names where it stands, with a tone', () => {
    expect(queryStateOf(query('accepted'))).toEqual({ label: 'accepted', tone: 'muted' });
    expect(queryStateOf(query('running'))).toEqual({ label: 'running', tone: 'busy' });
    expect(queryStateOf(query('waiting'))).toEqual({ label: 'waits on a question', tone: 'question' });
    expect(queryStateOf(query('answered'))).toEqual({ label: 'answered', tone: 'ok' });
    expect(queryStateOf(query('failed'))).toEqual({ label: 'failed', tone: 'bad' });
    expect(queryStateOf(query('cancelled'))).toEqual({ label: 'cancelled', tone: 'muted' });
  });

  it('can be cancelled only while its job is not at an end', () => {
    const withJob = (state: DirectQueryView['state']): DirectQueryView => ({ ...query(state), job: { id: 'j1', status: 'running', questions: [] } });
    expect(canCancelQuery(withJob('running'))).toBe(true);
    expect(canCancelQuery(withJob('waiting'))).toBe(true);
    expect(canCancelQuery(withJob('answered'))).toBe(false);
    expect(canCancelQuery(query('accepted'))).toBe(false);
  });

  it('keeps the direct queries out of the direct jobs list: they have a view of their own', () => {
    expect(onlyDirectJobs([job, query('answered')]).map((d) => d.id)).toEqual(['d1']);
  });
});
