// Issue #897: Needs you, the one inbox of every decision that waits on a person. One row per kind, in a fixed order, each
// with its count and the page that is its one home; one total, and a high-priority mark (#535). Access requests counts
// what jobs on boxes wait on a person for: credential requests, vault grant asks, and templates that wait for approval.
import { describe, expect, it } from 'vitest';
import { NEEDS_YOU_KINDS, needsYouRows, needsYouTotal, type NeedsYouCounts } from '../../ui/src/model/needs-you.ts';
import { plansWaiting } from '../../ui/src/model/infra-plans.ts';
import { checksProblemLines, conflictedPullRequests, gaveUpLines } from '../../ui/src/model/pull-requests.ts';
import { accessRequestsHigh, accessRequestsWaiting, ownTemplatesWaiting, rereadsVault, runCardsOf, templateWaits } from '../../ui/src/model/vault.ts';
import { stuckLandingLines } from '../../ui/src/model/landing-batches.ts';
import { budgetPausedLines } from '../../ui/src/model/token-ledger.ts';
import { yoloIndicator } from '../../ui/src/model/yolo-mode.ts';
import type { Job, LandingBatchesView, PlanView, PullRequestCard, PullRequestsView, TemplateView, VaultView, YoloModeView } from '../../ui/src/model/wire.ts';

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
    expect(rows.map((r) => r.href)).toEqual(['#intake', '#approvals/access-requests', '#approvals/access-requests', '#infra', '#questions', '#proposals', '#research', '#machines/logins', '#machines/accounts', '#machines', '#failures', '#parked', '#pull-requests', '#pull-requests', '#settings/landing-batches', '#tagged', '#vault', '#reports', '#jobs/queue']);
    expect(rows.every((r) => r.n === 0 && r.what.length > 0)).toBe(true);
  });

  it('counts each kind, and the total adds them with the high-priority ones', () => {
    const rows = needsYouRows(counts({ intake: 2, access: 1, plans: 2, signedOut: ['Claude on Server: signed in as nobody — sign it in from Accounts'], notReady: ['WSL: not ready — its job user holds .kube'], gaveUp: ['o/a#7: why'], checksUnread: ['o/b: why'], stuckLanding: ['o/c: why'], budgetPaused: ['Shed: why'], tagged: 2, failedSchedules: ['nightly-backup: failed'], recommended: ['The hopper queued one job again and again'], sorting: 3, sections: { questions: { n: 1, high: 1 }, proposals: none, research: none, logins: none, failures: { n: 4, high: 2 }, parked: none } }));
    const n = Object.fromEntries(rows.map((r) => [r.kind, r.n]));
    expect(n).toEqual({ intake: 2, access: 1, 'unknown-assets': 0, plans: 2, questions: 1, proposals: 0, research: 0, logins: 0, accounts: 1, machines: 1, failures: 4, budgets: 1, 'pull-requests': 1, checks: 1, landing: 1, tagged: 2, schedules: 1, 'bug-reports': 1, sorting: 3 });
    expect(needsYouTotal(rows)).toEqual({ n: 23, high: 3 });
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
    expect(row).toMatchObject({ n: 1, href: '#machines/accounts', details: ['Claude on Server: signed in as nobody — sign it in from Accounts'] });
    expect(needsYouRows(counts()).find((r) => r.kind === 'accounts')!.details).toBeUndefined();
  });

  it('a job its token budget paused waits on a person (issue #2302): the Budgets row names each, with why', () => {
    const job = (o: Partial<Job>): Job => ({ id: 'j', status: 'parked', spec: { executor: 'herdr-claude', goal: 'Paint the shed' }, ...o }) as unknown as Job;
    const why = 'Paused: the job used 1,610 tokens, its token budget is 1,000 tokens.';
    const lines = budgetPausedLines([
      job({ id: 'a', budgetPaused: { at: '2026-10-21T08:00:00.000Z', tokens: 1610, costUsd: 0.1, why } }),
      // Picked up already, or parked by a person: not the budget's.
      job({ id: 'b', status: 'queued', budgetPaused: { at: '2026-10-21T08:00:00.000Z', tokens: 1610, costUsd: 0.1, why } }),
      job({ id: 'c' }),
    ]);
    expect(lines).toEqual([`Paint the shed: ${why} Pick it up to let it go on.`]);
    const row = needsYouRows(counts({ budgetPaused: lines })).find((r) => r.kind === 'budgets')!;
    expect(row).toMatchObject({ n: 1, href: '#parked', details: lines });
    expect(needsYouRows(counts()).find((r) => r.kind === 'budgets')).toMatchObject({ n: 0 });
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
  name: 't', image: 'img', secrets: [], profiles: [], gives: [], pending: { image: false, secrets: [], egress: [], profiles: [] },
  approval: { by: 'admin', at: '2026-10-01T00:00:00.000Z', image: 'img', secrets: [] },
  ...o,
} as unknown as TemplateView);

describe('Access requests: what waits on a person (issue #897)', () => {
  it('a template waits when it was never approved, or a new image, secret or profile waits', () => {
    expect(templateWaits(template())).toBe(false);
    expect(templateWaits(template({ approval: undefined }))).toBe(true);
    expect(templateWaits(template({ pending: { image: true, secrets: [], egress: [], profiles: [] } }))).toBe(true);
    expect(templateWaits(template({ pending: { image: false, secrets: ['K'], egress: [], profiles: [] } }))).toBe(true);
    expect(templateWaits(template({ pending: { image: false, secrets: [], egress: [], profiles: [{ operation: 'apply', asset: { kind: 'cluster', name: 'lab' } }] } }))).toBe(true);
  });

  it('counts credential requests, vault grant asks and templates that wait; none for no view', () => {
    const view = {
      secrets: [], backends: [], templates: [template(), template({ name: 'u', approval: undefined })],
      requests: [{ id: 'r1' }], grantAsks: [{ job: 'j1' }, { job: 'j2' }], grants: [{ key: 'k' }],
    } as unknown as VaultView;
    expect(accessRequestsWaiting(view)).toBe(4);
    expect(accessRequestsWaiting(null)).toBe(0);
  });

  it('issue #2197: a run card counts once, its template with it; a template a job asked for counts only on its run card', () => {
    const run = { jobId: 'j1', template: 'asked-1', askedAt: '2026-10-19T02:00:00.000Z', waits: { template: true, run: true }, request: 'q1' };
    const view = {
      secrets: [], backends: [], templates: [template({ name: 'asked-1', approval: undefined, askedBy: 'j1' }), template({ name: 'asked-2', approval: undefined, askedBy: 'gone' }), template({ name: 'own', approval: undefined })],
      sandboxRequests: [{ id: 'q1', jobId: 'j1', template: 'asked-1', state: 'waiting', askedAt: run.askedAt }], runs: [run, { ...run, jobId: 'j2', template: 'asked-9', request: undefined }],
    } as unknown as VaultView;
    expect(ownTemplatesWaiting(view).map((t) => t.name)).toEqual(['own']);
    expect(accessRequestsWaiting(view)).toBe(3);
    // A high-priority job's card comes first and marks the badge.
    expect(runCardsOf(view, (id) => id === 'j2').map((c) => c.jobId)).toEqual(['j2', 'j1']);
    expect(accessRequestsHigh(view, { j2: { priority: 100 } }, 75)).toBe(1);
    expect(needsYouRows(counts({ access: 3, accessHigh: 1 })).find((r) => r.kind === 'access')).toMatchObject({ n: 3, high: 1 });
  });
  it('issue #2206: an ask for an AWS action counts once, in the same row, and marks the badge for a high-priority job', () => {
    const ask = { job: 'j3', role: '1/hopper-action', action: 'eks:UpdateNodegroupConfig', resource: 'arn:aws:eks:us-west-1:1:nodegroup/c/g/*', at: '2026-10-19T02:00:00.000Z' };
    const view = { secrets: [], backends: [], templates: [], actionAsks: [ask, { ...ask, job: 'j4' }] } as unknown as VaultView;
    expect(accessRequestsWaiting(view)).toBe(2);
    expect(accessRequestsHigh(view, { j3: { priority: 100 } }, 75)).toBe(1);
  });
});

describe('A template a job saved and waits on (issue #2196; its run card since issue #2197)', () => {
  const job = (id: string, status: Job['status'], priority = 0): Job => ({ id, status, priority } as unknown as Job);
  const asked = template({ name: 'asked-9bba3422fa25', askedBy: 'j1', pending: { image: true, secrets: [], egress: [], profiles: [{ operation: 'write', asset: { kind: 'aws-account', name: '1' } }] } } as Partial<TemplateView>);
  const card = { jobId: 'j1', template: asked.name, askedAt: '2026-10-19T01:37:41.000Z', waits: { template: true, run: false } };
  const vault = (o: Partial<VaultView> = {}): VaultView => ({ secrets: [], backends: [], templates: [asked], runs: [card], ...o } as unknown as VaultView);

  it('counts in Access requests once, on its run card, while its job waits; no longer when the daemon drops the card (the job ended, or the template was approved)', () => {
    expect(accessRequestsWaiting(vault())).toBe(1);
    expect(accessRequestsWaiting(vault({ runs: [] }))).toBe(0);
  });

  it('counts a template a person saved', () => {
    expect(accessRequestsWaiting(vault({ templates: [template({ approval: undefined })], runs: [] }))).toBe(1);
  });

  it('marks it high priority when its job is, as a sandbox run of a high-priority job', () => {
    const view = vault({ runs: [card, { jobId: 'j2', template: 't', askedAt: card.askedAt, request: 'r', waits: { template: false, run: true } }] } as unknown as Partial<VaultView>);
    expect(accessRequestsHigh(view, { j1: job('j1', 'waiting_on', 100), j2: job('j2', 'running', 100) }, 75)).toBe(2);
    expect(accessRequestsHigh(view, { j1: job('j1', 'waiting_on', 50), j2: job('j2', 'running', 50) }, 75)).toBe(0);
    expect(accessRequestsHigh(view, { j1: job('j1', 'waiting_on', 100) }, null)).toBe(0);
    expect(accessRequestsHigh(null, {}, 75)).toBe(0);
  });

  it('the Access requests row and the Needs you total carry the high-priority mark', () => {
    const rows = needsYouRows(counts({ access: 2, accessHigh: 1 }));
    expect(rows.find((r) => r.kind === 'access')).toMatchObject({ n: 2, high: 1 });
    expect(needsYouTotal(rows)).toEqual({ n: 2, high: 1 });
  });

  it('a template saved, approved or removed rereads the vault view, as a vault event does', () => {
    expect(rereadsVault('template.saved')).toBe(true);
    expect(rereadsVault('template.profile_approved')).toBe(true);
    expect(rereadsVault('template.removed')).toBe(true);
    expect(rereadsVault('vault.approved')).toBe(true);
    expect(rereadsVault('job.started')).toBe(false);
  });

  it('a bastion that starts or ends rereads the vault view, which lists the bastions that run (issue #2146)', () => {
    expect(rereadsVault('bastion.started')).toBe(true);
    expect(rereadsVault('bastion.ended')).toBe(true);
    expect(rereadsVault('bastion.relayed')).toBe(false);
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
