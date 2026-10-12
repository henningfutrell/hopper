// Issue #897: Needs you, the one inbox of every decision that waits on a person. One row per kind, in a fixed order, each
// with its count and the page that is its one home; one total, and a high-priority mark (#535). Access requests counts
// what jobs on boxes wait on a person for: credential requests, vault grant asks, and templates that wait for approval.
import { describe, expect, it } from 'vitest';
import { NEEDS_YOU_KINDS, needsYouRows, needsYouTotal, type NeedsYouCounts } from '../../ui/src/model/needs-you.ts';
import { plansWaiting } from '../../ui/src/model/infra-plans.ts';
import { conflictedPullRequests } from '../../ui/src/model/pull-requests.ts';
import { accessRequestsWaiting, templateWaits } from '../../ui/src/model/vault.ts';
import { yoloIndicator } from '../../ui/src/model/yolo-mode.ts';
import type { PlanView, PullRequestCard, PullRequestsView, TemplateView, VaultView, YoloModeView } from '../../ui/src/model/wire.ts';

const none = { n: 0, high: 0 };
const counts = (o: Partial<NeedsYouCounts> = {}): NeedsYouCounts => ({
  intake: 0, access: 0, plans: 0, conflicts: 0, sorting: 0,
  sections: { questions: none, proposals: none, research: none, logins: none, failures: none, parked: none },
  ...o,
});

describe('Needs you rows (issue #897)', () => {
  it('one row per kind, in order, each linked to its one home, with what it counts', () => {
    const rows = needsYouRows(counts());
    expect(rows.map((r) => r.kind)).toEqual(NEEDS_YOU_KINDS);
    expect(rows.map((r) => r.href)).toEqual(['#intake', '#access-requests', '#infra', '#questions', '#proposals', '#research', '#logins', '#failures', '#pull-requests', '#queue']);
    expect(rows.every((r) => r.n === 0 && r.what.length > 0)).toBe(true);
  });

  it('counts each kind, and the total adds them with the high-priority ones', () => {
    const rows = needsYouRows(counts({ intake: 2, access: 1, plans: 2, conflicts: 1, sorting: 3, sections: { questions: { n: 1, high: 1 }, proposals: none, research: none, logins: none, failures: { n: 4, high: 2 }, parked: none } }));
    const n = Object.fromEntries(rows.map((r) => [r.kind, r.n]));
    expect(n).toEqual({ intake: 2, access: 1, plans: 2, questions: 1, proposals: 0, research: 0, logins: 0, failures: 4, 'pull-requests': 1, sorting: 3 });
    expect(needsYouTotal(rows)).toEqual({ n: 14, high: 3 });
  });

  it('a parked job waits to be picked up, not on a decision: it has no row', () => {
    const rows = needsYouRows(counts({ sections: { questions: none, proposals: none, research: none, logins: none, failures: none, parked: { n: 2, high: 1 } } }));
    expect(rows.some((r) => (r.kind as string) === 'parked')).toBe(false);
    expect(needsYouTotal(rows)).toEqual({ n: 0, high: 0 });
  });
});

const template = (o: Partial<TemplateView> = {}): TemplateView => ({
  name: 't', image: 'img', secrets: [], profiles: [], gives: [], pending: { image: false, secrets: [], profiles: [] },
  approval: { by: 'admin', at: '2026-10-01T00:00:00.000Z', image: 'img', secrets: [] },
  ...o,
} as unknown as TemplateView);

describe('Access requests: what waits on a person (issue #897)', () => {
  it('a template waits when it was never approved, or a new image, secret or profile waits', () => {
    expect(templateWaits(template())).toBe(false);
    expect(templateWaits(template({ approval: undefined }))).toBe(true);
    expect(templateWaits(template({ pending: { image: true, secrets: [], profiles: [] } }))).toBe(true);
    expect(templateWaits(template({ pending: { image: false, secrets: ['K'], profiles: [] } }))).toBe(true);
    expect(templateWaits(template({ pending: { image: false, secrets: [], profiles: [{ operation: 'apply', asset: { kind: 'cluster', name: 'lab' } }] } }))).toBe(true);
  });

  it('counts credential requests, vault grant asks and templates that wait; none for no view', () => {
    const view = {
      secrets: [], backends: [], templates: [template(), template({ name: 'u', approval: undefined })],
      requests: [{ id: 'r1' }], grantAsks: [{ job: 'j1' }, { job: 'j2' }], grants: [{ key: 'k' }],
    } as unknown as VaultView;
    expect(accessRequestsWaiting(view)).toBe(4);
    expect(accessRequestsWaiting(null)).toBe(0);
  });
});

const plan = (o: Partial<PlanView> = {}): PlanView => ({
  id: 'p', expiresAt: '2026-10-12T13:00:00.000Z', ...o,
} as unknown as PlanView);

describe('Infra plans that wait for an admin (issue #897)', () => {
  const now = Date.parse('2026-10-12T12:00:00.000Z');
  it('counts the plans not approved, not stale and not failed; none for no answer', () => {
    const plans = [
      plan(),
      plan({ id: 'a', approval: { by: 'admin', at: '2026-10-12T11:00:00.000Z' } } as Partial<PlanView>),
      plan({ id: 's', expiresAt: '2026-10-12T11:00:00.000Z' }),
      plan({ id: 'f', summary: { failed: true } } as unknown as Partial<PlanView>),
    ];
    expect(plansWaiting({ plans }, now)).toBe(1);
    expect(plansWaiting(undefined, now)).toBe(0);
    expect(plansWaiting({} as never, now)).toBe(0);
  });
});

const card = (o: Partial<PullRequestCard> = {}): PullRequestCard => ({ jobId: 'j', state: 'open', mergeable: 'mergeable', ...o } as PullRequestCard);

describe('Pull requests with merge conflicts (issue #897)', () => {
  it('counts the open ones that conflict with their base; a closed one is no decision; none for no answer', () => {
    const view = { yolo: { on: 0, total: 1 }, waiting: [], repos: [
      { repo: 'o/a', yolo: false, pullRequests: [card({ mergeable: 'conflicts' }), card(), card({ state: 'closed', mergeable: 'conflicts' })] },
      { repo: 'o/b', yolo: false, pullRequests: [card({ mergeable: 'conflicts' })] },
    ] } as PullRequestsView;
    expect(conflictedPullRequests(view)).toBe(2);
    expect(conflictedPullRequests(undefined)).toBe(0);
    expect(conflictedPullRequests({} as never)).toBe(0);
  });
});

const yolo = (o: Partial<YoloModeView> = {}): YoloModeView => ({ on: false, repos: {}, choices: { repos: ['o/a', 'o/b'] }, ...o });

describe('the header\'s yolo mode (issue #897)', () => {
  it('says off, on everywhere, or on for some repositories, with the summary as its title', () => {
    expect(yoloIndicator(yolo())).toMatchObject({ on: false, words: 'yolo off' });
    expect(yoloIndicator(yolo({ on: true }))).toMatchObject({ on: true, words: 'yolo on' });
    expect(yoloIndicator(yolo({ repos: { 'o/b': true } }))).toMatchObject({ on: true, words: 'yolo on: 1 of 2 repos' });
    expect(yoloIndicator(yolo({ on: true, repos: { 'o/a': false } }))).toMatchObject({ on: true, words: 'yolo on: 1 of 2 repos' });
    expect(yoloIndicator(yolo())!.title).toContain('Off');
  });

  it('shows nothing for an answer without the settings, never off', () => {
    expect(yoloIndicator(undefined)).toBeUndefined();
    expect(yoloIndicator({} as never)).toBeUndefined();
  });
});
