// @vitest-environment happy-dom
// The Failures view (issue #509), rendered inside the whole app against a fake of the daemon's HTTP surface: the
// open problems with their jobs and actions, the recent assessed failures with their decision and summary, the
// profile, the settings (admin). An action shows only when the daemon would take it — the answer's `actions` and
// the session's role — and goes to the daemon. It updates live: an assessor event reads the failures again. A
// failed job shows its assessment where its error shows.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { T0, at, problem, record, handoff, view, FakeEventSource, boot, settle, buttonsIn, problemCard, handoffRow, navBadge, daemon, unmount, type Daemon } from './failures-view-harness.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(T0);
});

afterEach(async () => {
  await unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the Failures view', () => {
  it('an open problem: its cause, its jobs and the held ones; the nav badge counts open problems', async () => {
    await boot('#failures', { failures: view() });
    const c = problemCard()!;
    expect(c).not.toBeNull();
    expect(c.textContent).toContain('Disk full on desk');
    expect(c.textContent).toContain('3 jobs');
    expect(c.textContent).toContain('1 held');
    expect(document.querySelector('a[href="#failures"] [data-slot="nav-badge"]')?.textContent).toBe('1');
  });

  it('offers only the actions the daemon would take: Resolve yes, Release held no (none held)', async () => {
    await boot('#failures', { failures: view() });
    expect(buttonsIn(problemCard())).toContain('Resolve');
    expect(buttonsIn(problemCard()).join(' ')).not.toContain('Release held');
    const retryable = document.querySelector('[data-failure="f2"]');
    const waiting = document.querySelector('[data-failure="f1"]');
    expect(buttonsIn(retryable)).toContain('Retry');
    expect(buttonsIn(waiting)).not.toContain('Retry');
  });

  it('a viewer is offered no action, and sees no settings', async () => {
    await boot('#failures', { failures: view(), role: 'viewer' });
    expect(buttonsIn(problemCard())).not.toContain('Resolve');
    expect(buttonsIn(document.querySelector('[data-failure="f2"]'))).not.toContain('Retry');
    expect(document.querySelector('[data-section="failure-settings"]')).toBeNull();
  });

  it('an admin sees the settings', async () => {
    await boot('#failures', { failures: view(), role: 'admin' });
    expect(document.querySelector('[data-section="failure-settings"]')).not.toBeNull();
  });

  it('Resolve and Retry go to the daemon', async () => {
    await boot('#failures', { failures: view({ problems: [problem({ actions: { resolve: { ok: true }, release: { ok: true } } })] }) });
    const click = async (el: Element | null, text: string) => {
      const b = [...(el?.querySelectorAll('button') ?? [])].find((x) => x.textContent === text) as HTMLButtonElement;
      await act(async () => { b.click(); });
      await settle();
    };
    await click(problemCard(), 'Release held');
    expect(daemon.posts).toContain('POST /ui/api/failures/problems/p1/release');
    await click(problemCard(), 'Resolve');
    expect(daemon.posts).toContain('POST /ui/api/failures/problems/p1/resolve');
    await click(document.querySelector('[data-failure="f2"]'), 'Retry');
    expect(daemon.posts).toContain('POST /ui/api/failures/f2/retry');
    // Answered before the give-back (issue #1194): the button waits until the stream says how it ended.
    expect(buttonsIn(document.querySelector('[data-failure="f2"]'))).toContain('Running again');
  });

  it('the recent failures show decision and summary; the profile its top signatures and breakdowns', async () => {
    await boot('#failures', { failures: view() });
    const f2 = document.querySelector('[data-failure="f2"]')!;
    expect(f2.textContent).toContain('needs a person');
    expect(f2.textContent).toContain('Needs a person. Ran 1 time on desk. Failed: tests fail.');
    const profile = document.querySelector('[data-section="failure-profile"]')!;
    expect(profile.textContent).toContain('Disk full');
    expect(profile.textContent).toContain('desk');
    expect(profile.textContent).toContain('o/a');
    expect(profile.textContent).toContain('herdr-claude');
  });

  it('updates live: a failure event reads the failures again', async () => {
    const d: Daemon = { failures: view({ problems: [] }) };
    await boot('#failures', d);
    expect(problemCard()).toBeNull();
    d.failures = view();
    await act(async () => { FakeEventSource.last!.send({ seq: 1, schemaVersion: 1, id: 'e1', type: 'failure.grouped', at: at(1), jobId: 'j1', data: {} }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await settle();
    expect(problemCard()).not.toBeNull();
  });

  it('a failed job shows its assessment where its error shows', async () => {
    await boot('#queue', { failures: view() });
    const a = document.querySelector('[data-job-id="j1"] [data-assessment]');
    expect(a?.textContent).toContain('Held: Disk full on desk');
  });

  it('Report a bug on a hand-off card and a failure row opens the report form, its context asked with no job (issues #694, #2478)', async () => {
    await boot('#failures', { failures: view({ handoffs: [handoff()] }) });
    const report = (el: Element | null) => [...(el?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Report a bug');
    expect(report(document.querySelector('[data-failure="f1"]'))).toBeDefined();
    await act(async () => { report(handoffRow())!.click(); });
    await settle();
    expect(document.querySelector('[data-slot="bug-report"]')).not.toBeNull();
    expect(daemon.posts).toContain('POST /ui/api/bug-reports/context');
    expect(daemon.bodies).toContainEqual({});
    expect(daemon.bodies).not.toContainEqual({ jobId: 'j9' });
  });

  it('a viewer is offered no Report a bug on a card', async () => {
    await boot('#failures', { failures: view({ handoffs: [handoff()] }), role: 'viewer' });
    expect(buttonsIn(handoffRow())).not.toContain('Report a bug');
    expect(buttonsIn(document.querySelector('[data-failure="f1"]'))).not.toContain('Report a bug');
  });

  it('Needs a person: each open hand-off with its reason and what happened, its own count; the nav badge counts it too', async () => {
    await boot('#failures', { failures: view({ handoffs: [handoff(), handoff({ id: 'h2', jobId: 'j8', reason: 'retry_limit' })] }) });
    const section = document.querySelector('[data-section="needs-a-person"]')!;
    expect(section).not.toBeNull();
    expect(section.querySelector('[data-slot="handoff-count"]')?.textContent).toBe('2');
    expect(handoffRow()!.querySelector('[data-slot="what-happened"]')!.textContent).toBe('The job stopped before it opened or updated a PR.');
    expect(handoffRow('h2')!.textContent).toContain('retries used up');
    // One open problem and two open hand-offs.
    expect(navBadge()).toBe('3');
  });

  it('starts with what happened, then the recommended resolution as the main button with why; the rest after it, each saying what it leads to (issues #551, #621)', async () => {
    const card = { whatHappened: 'The job updated PR #616. #616 is merged. The issue is done.', recommended: 'done_by_hand', why: 'The work is done.', link: 'https://github.com/o/r/pull/616' };
    const shipped = handoff({ id: 'h2', continueResumes: false, card });
    await boot('#failures', { failures: view({ handoffs: [handoff(), shipped] }) });
    const row = handoffRow('h2')!;
    expect(row.querySelector('[data-slot="what-happened"]')!.textContent).toBe('The job updated PR #616. #616 is merged. The issue is done.');
    const items = [...row.querySelectorAll('[data-resolution]')];
    expect(items.map((li) => li.getAttribute('data-resolution'))).toEqual(['done_by_hand', 'continue', 'fixed', 'wont_do']);
    expect(items[0]!.hasAttribute('data-recommended')).toBe(true);
    expect(items[0]!.querySelector('button')!.textContent).toBe('Done');
    expect(items[0]!.textContent).toContain('The work is done.');
    expect(row.querySelector('[data-resolution="continue"] button')!.textContent).toBe('Continue');
    expect(row.querySelector('[data-resolution="continue"]')!.textContent).toContain('a new job of its item runs');
    expect(row.querySelector('[data-resolution="fixed"] button')!.textContent).toBe('Run again');
    // Done carries the link to the work.
    expect((row.querySelector('input[aria-label="Link"]') as HTMLInputElement).value).toBe('https://github.com/o/r/pull/616');
    // The first card recommends Continue: its session goes on.
    expect(handoffRow()!.querySelector('[data-recommended]')!.getAttribute('data-resolution')).toBe('continue');
    expect(handoffRow()!.querySelector('[data-recommended]')!.textContent).toContain('Its session can go on.');
  });

  it('the summary, the cause, the assessment and the raw error are behind Details (issue #621)', async () => {
    await boot('#failures', { failures: view({ handoffs: [handoff({ causeName: 'Tests fail' })] }) });
    const details = handoffRow()!.querySelector('details[data-slot="details"]')!;
    expect(details.querySelector('summary')!.textContent).toBe('Details');
    expect(details.textContent).toContain('Needs a person. Ran 1 time on desk. Failed: tests fail.');
    expect(details.textContent).toMatch(/Known cause: Tests fail.*no known cause matches.*HOPPER_FAILED tests fail/s);
    expect(handoffRow()!.querySelector('[data-slot="what-happened"]')!.textContent).not.toContain('HOPPER_FAILED');
  });

  it('a refused resolution says why instead of disappearing; a viewer is offered none', async () => {
    const refused = { ok: false, why: 'a newer job of its item exists' };
    await boot('#failures', { failures: view({ handoffs: [handoff(), handoff({ id: 'h2', actions: { continue: refused, fixed: refused, doneByHand: { ok: true }, wontDo: { ok: true } } })] }) });
    expect(buttonsIn(handoffRow())).toEqual(expect.arrayContaining(['Continue', 'Run again', 'Done', "Won't do"]));
    expect(buttonsIn(handoffRow('h2'))).not.toContain('Continue');
    expect(buttonsIn(handoffRow('h2'))).toContain('Done');
    expect(handoffRow('h2')!.querySelector('[data-resolution="continue"]')!.textContent).toContain('not now — a newer job of its item exists');
    await unmount();
    await boot('#failures', { failures: view({ handoffs: [handoff()] }), role: 'viewer' });
    expect(handoffRow()!.querySelector('[data-slot="resolve"]')).toBeNull();
    // A viewer sees the recommendation without buttons (issue #621).
    expect(handoffRow()!.querySelector('[data-slot="recommended"]')!.textContent).toBe('Continue: Its session can go on. Tell it what to do in a note.');
  });

  it('a resolution goes to the daemon with the note (Won\'t do only with one); once resolved, the card says what was done and links the next job', async () => {
    const d: Daemon = { failures: view({ problems: [], handoffs: [handoff()] }) };
    await boot('#failures', d);
    expect(navBadge()).toBe('1');
    const button = (text: string) => [...(handoffRow()?.querySelectorAll('button') ?? [])].find((x) => x.textContent === text) as HTMLButtonElement;
    expect(button("Won't do").disabled).toBe(true);
    const note = handoffRow()!.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'Use the blue paint.');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button("Won't do").disabled).toBe(false);
    await act(async () => { button('Continue').click(); });
    await settle();
    expect(daemon.posts).toContain('POST /ui/api/failures/handoffs/h1/resolve');
    expect(daemon.bodies.at(-1)).toEqual({ action: 'continue', note: 'Use the blue paint.' });
    expect(button('Going on').disabled).toBe(true);
    d.failures = view({ problems: [], handoffs: [handoff({
      status: 'closed', end: 'continued', closedAt: at(1), nextJobId: 'j9',
      resolution: { action: 'continue', resumed: true, by: 'Pat', at: at(1), note: 'Use the blue paint.', writeBack: 'written' },
      actions: { continue: { ok: false, why: 'already resolved: continued' }, fixed: { ok: false, why: 'already resolved: continued' }, doneByHand: { ok: false, why: 'x' }, wontDo: { ok: false, why: 'x' } },
    })] });
    await act(async () => { FakeEventSource.last!.send({ seq: 2, schemaVersion: 1, id: 'e2', type: 'handoff.closed', at: at(1), jobId: 'j9', data: {} }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await settle();
    expect(navBadge()).toBeUndefined();
    const resolved = handoffRow()!.querySelector('[data-slot="resolution"]')!.textContent;
    expect(resolved).toContain('continued in its session');
    expect(resolved).toContain('by Pat');
    expect(resolved).toContain('told its issue');
    expect(handoffRow()!.querySelector('[data-slot="next-job"]')!.textContent).toContain('Goes on as');
    expect(handoffRow()!.querySelector('[data-slot="resolve"]')).toBeNull();
    // Resolved, it left Needs a person for Ended (issue #618).
    expect(handoffRow()!.closest('[data-section]')!.getAttribute('data-section')).toBe('ended');
    expect(document.querySelector('[data-section="needs-a-person"]')!.textContent).toContain('no job waits on a person');
  });

  it('a closed hand-off and an ended failure are out of Needs a person and the open failures, in Ended (issue #618)', async () => {
    const closed = handoff({ id: 'h3', jobId: 'j7', status: 'closed', end: 'item_closed', closedAt: at(-5) });
    const ended = record({ id: 'f4', jobId: 'j7', outcome: 'item_closed', outcomeAt: at(-5), problemId: undefined, actions: { retry: { ok: false, why: 'its item is closed' } } });
    await boot('#failures', { failures: view({ problems: [], handoffs: [handoff(), closed], ended: [ended] }) });
    const needs = document.querySelector('[data-section="needs-a-person"]')!;
    expect(needs.querySelector('[data-handoff="h1"]')).not.toBeNull();
    expect(needs.querySelector('[data-handoff="h3"]')).toBeNull();
    expect(needs.querySelector('[data-slot="handoff-count"]')?.textContent).toBe('1');
    const history = document.querySelector('[data-section="ended"]')!;
    expect(history.querySelector('[data-handoff="h3"]')!.textContent).toContain('its item is closed');
    expect(history.querySelector('[data-failure="f4"]')!.textContent).toContain('its item is closed');
    expect(document.querySelector('[data-section="open-failures"] [data-failure="f4"]')).toBeNull();
    expect(navBadge()).toBe('1');
  });

  it('nothing ended: no Ended section', async () => {
    await boot('#failures', { failures: view() });
    expect(document.querySelector('[data-section="ended"]')).toBeNull();
  });

  it('an admin can name the cause from the card, with what to do next time', async () => {
    await boot('#failures', { failures: view({ handoffs: [handoff()] }), role: 'admin' });
    const learn = handoffRow()!.querySelector('[data-slot="learn"]')!;
    expect(learn.textContent).toContain('Name this cause');
    await act(async () => { (learn.querySelector('button') as HTMLButtonElement).click(); });
    expect(handoffRow()!.querySelector('input[aria-label="Next time"]')).not.toBeNull();
  });

  it('counts what is left (issues #517, #1067): the work items that failed, and those that need a person', async () => {
    await boot('#failures', { failures: view({ counts: { failed: 2, needsPerson: 1 } }) });
    const counts = document.querySelector('[data-section="failure-counts"]')!;
    expect(counts.textContent).toContain('2 work items failed');
    expect(counts.textContent).toContain('1 work item needs a person');
  });

  it('nothing left: it says so', async () => {
    await boot('#failures', { failures: view({ counts: { failed: 0, needsPerson: 0 } }) });
    expect(document.querySelector('[data-section="failure-counts"]')!.textContent).toContain('No work item failed, and none needs a person');
  });

  it('a superseded failure says its item ran again, and offers no Retry', async () => {
    await boot('#failures', { failures: view({ recent: [record({ id: 'f3', jobId: 'j3', outcome: 'superseded', nextJobId: 'j4', problemId: undefined, summary: 'Already run again (job j4).', actions: { retry: { ok: false, why: 'already run again' } } })] }) });
    const f3 = document.querySelector('[data-failure="f3"]')!;
    expect(f3.textContent).toContain('its item ran again');
    expect(buttonsIn(f3)).not.toContain('Retry');
  });
});
