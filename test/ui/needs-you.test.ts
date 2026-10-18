// Issue #897: Needs you, the one inbox of every decision that waits on a person. One row per kind, in a fixed order, each
// with its count and the page that is its one home; one total, and a high-priority mark (#535). Access requests counts
// what jobs on boxes wait on a person for: credential requests, vault grant asks, and templates that wait for approval.
import { describe, expect, it } from 'vitest';
import { NEEDS_YOU_KINDS, needsYouRows, needsYouTotal, type NeedsYouCounts } from '../../ui/src/model/needs-you.ts';
import { plansWaiting } from '../../ui/src/model/infra-plans.ts';
import { checksProblemLines, conflictedPullRequests, gaveUpLines } from '../../ui/src/model/pull-requests.ts';
import { accessRequestsWaiting, templateWaits } from '../../ui/src/model/vault.ts';
import { stuckLandingLines } from '../../ui/src/model/landing-batches.ts';
import { yoloIndicator } from '../../ui/src/model/yolo-mode.ts';
import type { LandingBatchesView, PlanView, PullRequestCard, PullRequestsView, TemplateView, VaultView, YoloModeView } from '../../ui/src/model/wire.ts';

const none = { n: 0, high: 0 };
const counts = (o: Partial<NeedsYouCounts> = {}): NeedsYouCounts => ({
  intake: 0, access: 0, plans: 0, signedOut: [], notReady: [], gaveUp: [], checksUnread: [], stuckLanding: [], tagged: 0, sorting: 0,
  sections: { questions: none, proposals: none, research: none, logins: none, failures: none, parked: none },
  ...o,
});

describe('Needs you rows (issue #897)', () => {
  it('one row per kind, in order, each linked to its one home, with what it counts', () => {
    const rows = needsYouRows(counts());
    expect(rows.map((r) => r.kind)).toEqual(NEEDS_YOU_KINDS);
    expect(rows.map((r) => r.href)).toEqual(['#intake', '#access-requests', '#infra', '#questions', '#proposals', '#research', '#logins', '#accounts', '#machines', '#failures', '#pull-requests', '#pull-requests', '#settings/landing-batches', '#tagged', '#queue']);
    expect(rows.every((r) => r.n === 0 && r.what.length > 0)).toBe(true);
  });

  it('counts each kind, and the total adds them with the high-priority ones', () => {
    const rows = needsYouRows(counts({ intake: 2, access: 1, plans: 2, signedOut: ['Claude on Server: signed in as nobody — sign it in from Accounts'], notReady: ['WSL: not ready — its job user holds .kube'], gaveUp: ['o/a#7: why'], checksUnread: ['o/b: why'], stuckLanding: ['o/c: why'], tagged: 2, sorting: 3, sections: { questions: { n: 1, high: 1 }, proposals: none, research: none, logins: none, failures: { n: 4, high: 2 }, parked: none } }));
    const n = Object.fromEntries(rows.map((r) => [r.kind, r.n]));
    expect(n).toEqual({ intake: 2, access: 1, plans: 2, questions: 1, proposals: 0, research: 0, logins: 0, accounts: 1, machines: 1, failures: 4, 'pull-requests': 1, checks: 1, landing: 1, tagged: 2, sorting: 3 });
    expect(needsYouTotal(rows)).toEqual({ n: 20, high: 3 });
  });

  it('a landing pass stuck on the same failure waits on a person (issue #1333): the Landing row names each repository with its error', () => {
    const view = { repos: [
      { repo: 'o/a', config: { tested: 'dev', everyMerges: 5, everyMinutes: 60 }, state: { repo: 'o/a' }, stuck: { error: 'the start of a batch run: GitHub answered 422', since: '2026-10-15T13:44:00.000Z', passes: 3 } },
      { repo: 'o/b', config: { tested: 'dev', everyMerges: 5, everyMinutes: 60 }, state: { repo: 'o/b' } },
    ] } as unknown as LandingBatchesView;
    const lines = stuckLandingLines(view);
    expect(lines).toEqual(['o/a: the start of a batch run: GitHub answered 422 — Restart batch in Settings → Landing batches']);
    const row = needsYouRows(counts({ stuckLanding: lines })).find((r) => r.kind === 'landing')!;
    expect(row).toMatchObject({ n: 1, href: '#settings/landing-batches', details: lines });
    expect(stuckLandingLines(undefined)).toEqual([]);
    expect(needsYouRows(counts()).find((r) => r.kind === 'landing')!.details).toBeUndefined();
  });

  it('a machine whose tool is signed in as nobody waits on a sign-in (issue #1128): the Accounts row names each', () => {
    const row = needsYouRows(counts({ signedOut: ['Claude on Server: signed in as nobody — sign it in from Accounts'] })).find((r) => r.kind === 'accounts')!;
    expect(row).toMatchObject({ n: 1, href: '#accounts', details: ['Claude on Server: signed in as nobody — sign it in from Accounts'] });
    expect(needsYouRows(counts()).find((r) => r.kind === 'accounts')!.details).toBeUndefined();
  });

  it('a machine not ready waits on a person (issue #1248): the Machines row names each', () => {
    const row = needsYouRows(counts({ notReady: ['WSL: not ready — its job user holds .kube'] })).find((r) => r.kind === 'machines')!;
    expect(row).toMatchObject({ n: 1, href: '#machines', details: ['WSL: not ready — its job user holds .kube'] });
    expect(needsYouRows(counts()).find((r) => r.kind === 'machines')!.details).toBeUndefined();
  });

  it('a repository whose checks no read gets (issue #1244): one Checks row line per repository, with the fix', () => {
    const why = 'the GitHub App lacks Checks: read: add them to the GitHub App and accept them on its installation';
    const view = { yolo: { on: 1, total: 1 }, waiting: [], repos: [], checksProblems: [{ repo: 'o/a', why, pullRequests: [7, 8] }] } as PullRequestsView;
    const lines = checksProblemLines(view);
    expect(lines).toEqual([`o/a: the hopper cannot read the checks of #7 and #8, so it does not merge them: ${why}`]);
    const row = needsYouRows(counts({ checksUnread: lines })).find((r) => r.kind === 'checks')!;
    expect(row).toMatchObject({ n: 1, href: '#pull-requests', details: lines });
    expect(checksProblemLines({ yolo: { on: 0, total: 0 }, waiting: [], repos: [] })).toEqual([]);
    expect(checksProblemLines(undefined)).toEqual([]);
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
  id: 'p', expiresAt: '2026-10-12T13:00:00.000Z', approver: { who: 'operator', why: 'low risk, in uat only' }, ...o,
} as unknown as PlanView);

describe('Infra plans that wait for a person (issue #897)', () => {
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

describe('Pull requests the hopper gave up on (issue #927)', () => {
  it('one line each, with its repository, number and why; a card the hopper still tends is none', () => {
    const view = { yolo: { on: 1, total: 1 }, waiting: [], repos: [
      { repo: 'o/a', yolo: true, pullRequests: [
        card({ mergeable: 'conflicts', pullRequest: { number: 7, url: 'https://github.com/o/a/pull/7' }, gaveUp: 'checks still fail after 3 fixes: a person must look at them' }),
        card({ mergeable: 'conflicts', pullRequest: { number: 8, url: 'https://github.com/o/a/pull/8' }, queue: { next: true } }),
        card({ state: 'closed', pullRequest: { number: 9, url: 'https://github.com/o/a/pull/9' }, gaveUp: 'old' }),
      ] },
    ] } as PullRequestsView;
    expect(gaveUpLines(view)).toEqual(['o/a#7: checks still fail after 3 fixes: a person must look at them']);
    expect(gaveUpLines(undefined)).toEqual([]);
  });

  it('the Pull requests row counts them, and says why for each', () => {
    const row = needsYouRows(counts({ gaveUp: ['o/a#7: checks still fail'] })).find((r) => r.kind === 'pull-requests')!;
    expect(row.n).toBe(1);
    expect(row.details).toEqual(['o/a#7: checks still fail']);
    expect(row.what).toContain('gave up');
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
