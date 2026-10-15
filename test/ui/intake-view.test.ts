// @vitest-environment happy-dom
// Issue #798 in the UI, against a fake of the daemon's HTTP surface. The issues a source listed have their own view, Intake
// (issue #897; Not taken until then), badged with the request cards waiting for approval: each source's issues grouped by
// why, with a count per group, no inner scroll box, Approve on a request card and Take off the backburner on a
// backburner issue. Issue #1035: only the issues waiting on an intake decision; taken, partly done and pull-request-waits
// issues are job progress, on Jobs, and Intake counts them in one line that links there. Issue #808: the issues on the backburner are
// counted in the nav and from the Queue, and each says its number, since when and by whom it is on the backburner.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DETAIL, SOURCES, boot, button, click, daemon, group, navLink, posts, request, row, streamed, unmount, url, view } from './intake-view-harness.ts';

afterEach(unmount);

describe('Intake: the issues a source listed, grouped by why (issues #798, #897)', () => {
  it('the nav entry is badged with the cards the page shows under Needs approval, whatever the ledger counts (issue #1193)', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    const shown = group(view()!, 'request').querySelector('[data-intake-group-count]')!.textContent;
    expect(shown).toBe('2');
    await vi.waitFor(() => expect(navLink('#intake').querySelector('[data-slot="nav-badge"]')?.textContent).toBe(shown));
    expect(navLink('#intake').textContent).toContain('Intake');
  });

  it('a reopened card (issue #1126) counts on the page and in the badge at the same moment (issue #1193)', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(navLink('#intake').querySelector('[data-slot="nav-badge"]')?.textContent).toBe('2'));
    const reopened = { key: url(11), title: 'Done, still open', repo: 'octo-user/hopper', reason: 'reopened after its job was done: approve it to run it again', action: 'approve', group: 'request',
      request: { ...request(11), why: ['reopened after its job was done'], reopened: { jobs: [{ id: 'j-11', status: 'finished' }] } } };
    await act(async () => { streamed.get('source.updated')!({ data: JSON.stringify({ ...SOURCES[0], detail: { ...DETAIL, intake: [...DETAIL.intake, reopened] } }) }); });
    expect(group(view()!, 'request').querySelector('[data-intake-group-count]')!.textContent).toBe('3');
    expect(navLink('#intake').querySelector('[data-slot="nav-badge"]')?.textContent).toBe('3');
  });

  it('groups the issues waiting on an intake decision by why, with counts, requests first', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    const groups = [...view()!.querySelectorAll<HTMLElement>('[data-intake-group]')].map((g) => g.getAttribute('data-intake-group'));
    expect(groups).toEqual(['request', 'not-assigned', 'backburner', 'other']);
    const count = (g: string) => group(view()!, g).querySelector('[data-intake-group-count]')!.textContent;
    expect([count('request'), count('backburner'), count('other')]).toEqual(['2', '2', '1']);
    expect(group(view()!, 'request').textContent).toContain('Needs approval');
    expect(view()!.querySelector('.overflow-y-auto')).toBeNull();
  });

  it('Approve on a request card and Take off the backburner act from the view', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    await click(button(row(view()!, url(9)), 'Approve'));
    await click(button(row(view()!, url(4)), 'Take off the backburner'));
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(posts).toEqual([
      { path: '/ui/api/sources/github-account/intake', body: { kind: 'approve', keys: [url(9)], hash: request(9).hash } },
      { path: '/ui/api/sources/github-account/intake', body: { kind: 'unbackburner', keys: [url(4)] } },
    ]);
  });
});

describe('Intake leaves job progress to Jobs (issue #1035)', () => {
  it('lists no taken, partly done or pull-request-waits issue, and counts them in one line that links to Jobs', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    for (const n of [1, 2, 6, 7]) expect(row(view()!, url(n))).toBeNull();
    const link = view()!.querySelector<HTMLAnchorElement>('[data-intake-in-progress]')!;
    expect(link.getAttribute('href')).toBe('#jobs');
    expect(link.textContent).toBe('4 in progress on Jobs');
    expect(view()!.querySelector('[data-intake-summary]')!.textContent).toContain('6 waiting for intake');
  });

  it('with 4 taken issues, 1 partly done issue and 0 requests, it lists no issue and says nothing is waiting', async () => {
    const taken = (n: number) => ({ key: url(n), title: `Taken ${n}`, repo: 'octo-user/hopper', jobId: `j-${n}`, jobStatus: 'running' });
    const intake = [taken(1), taken(2), taken(3), taken(4),
      { key: url(5), title: 'Half', repo: 'octo-user/hopper', reason: 'partly done: the rest runs once its pull request merges', group: 'partly-done' }];
    await boot('#intake');
    await act(async () => { streamed.get('source.updated')!({ data: JSON.stringify({ ...SOURCES[0], detail: { ...DETAIL, intake } }) }); });
    await vi.waitFor(() => expect(view()!.querySelector('[data-intake-item]')).toBeNull());
    expect(view()!.querySelector('[data-intake-group]')).toBeNull();
    expect(view()!.textContent).toContain('Nothing waiting for intake');
    expect(view()!.querySelector<HTMLAnchorElement>('[data-intake-in-progress]')!.textContent).toBe('5 in progress on Jobs');
  });
});

describe('Decline on a request card (issue #1035)', () => {
  it('Decline sends the text as read, and the card says it was declined', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    await click(button(row(view()!, url(9)), 'Decline'));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts).toEqual([{ path: '/ui/api/sources/github-account/intake', body: { kind: 'decline', keys: [url(9)], hash: request(9).hash } }]);
    await vi.waitFor(() => expect(row(view()!, url(9)).querySelector('[data-slot="request-declined"]')).not.toBeNull());
    expect(button(row(view()!, url(9)), 'Approve')).toBeUndefined();
  });

  it('a declined request is no row: Intake counts it in one line', async () => {
    const declined = { key: url(11), title: 'No thanks', repo: 'octo-user/hopper', reason: 'a request you declined: an edit to its title or body shows it again', group: 'declined' };
    await boot('#intake');
    await act(async () => { streamed.get('source.updated')!({ data: JSON.stringify({ ...SOURCES[0], detail: { ...DETAIL, intake: [...DETAIL.intake, declined] } }) }); });
    await vi.waitFor(() => expect(view()!.querySelector('[data-intake-declined]')).not.toBeNull());
    expect(row(view()!, url(11))).toBeNull();
    expect(view()!.querySelector('[data-intake-group="declined"]')).toBeNull();
    expect(view()!.querySelector('[data-intake-declined]')!.textContent).toBe('1 request declined');
    expect(view()!.querySelector('[data-intake-summary]')!.textContent).toContain('6 waiting for intake');
  });
});

describe('the backburner is always visible (issue #808)', () => {
  it('the nav entry also counts the issues on the backburner, apart from the requests', async () => {
    await boot('#dashboard');
    await vi.waitFor(() => expect(navLink('#intake').querySelector('[data-slot="nav-badge-backburner"]')?.textContent).toBe('2'));
    expect(navLink('#intake').querySelector('[data-slot="nav-badge-backburner"]')!.getAttribute('title')).toBe('2 issues on the backburner');
    expect(navLink('#intake').querySelector('[data-slot="nav-badge"]')?.textContent).toBe('2');
  });

  it('each row says its issue number; a backburner row says since when and by whom, and looks unlike a taken one', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-11T09:00:00.000Z') });
    try {
      await boot('#intake');
      await vi.waitFor(() => expect(view()).not.toBeNull());
    } finally { vi.useRealTimers(); }
    expect(row(view()!, url(3)).textContent).toContain('#3');
    const parked = row(view()!, url(4));
    expect(parked.textContent).toContain('#4');
    expect(parked.querySelector('[data-backburner-since]')!.textContent).toBe('on the backburner 10d ago, by octo-user');
    expect(parked.getAttribute('data-backburner')).not.toBeNull();
    expect(row(view()!, url(5)).textContent).toContain('on the backburner');
    expect(row(view()!, url(5)).querySelector('[data-backburner-since]')).toBeNull();
  });

  it('the Queue links to the issues on the backburner, with their count', async () => {
    await boot('#queue');
    const link = () => document.querySelector<HTMLAnchorElement>('[data-slot="queue-backburner"]');
    await vi.waitFor(() => expect(link()).not.toBeNull());
    expect(link()!.getAttribute('href')).toBe('#intake');
    expect(link()!.textContent).toContain('2 issues on the backburner');
  });
});

describe('Approve on a request card: it shows at once, says how it ended, and keeps the place (issue #811)', () => {
  // The daemon's list after the approval: issue 9 is taken, as the sync the approval runs makes its job.
  const approved = () => [{ ...SOURCES[0], detail: { ...DETAIL, intake: DETAIL.intake.map((x) => (x.key === url(9)
    ? { key: url(9), title: 'Request 9', repo: 'octo-user/hopper', jobId: 'j-9', jobStatus: 'queued' } : x)) } }];
  const groupOf = (el: HTMLElement) => el.closest('[data-intake-group]')!.getAttribute('data-intake-group');

  it.each([
    ['Intake', '#intake', view],
  ])('%s: the button waits at once, sends once, and the approved issue stays where it was, with focus', async (_name, hash, list) => {
    await boot(hash);
    let release!: () => void;
    daemon.answer = (body) => new Promise((resolve) => { release = () => resolve({ done: body.keys, failed: {} }); });
    await vi.waitFor(() => expect(list()).not.toBeNull());
    const approve = button(row(list()!, url(9)), 'Approve')!;
    await click(approve);
    const waiting = row(list()!, url(9)).querySelector<HTMLButtonElement>('[data-slot="request-approve"]')!;
    expect(waiting.disabled).toBe(true);
    expect(waiting.getAttribute('aria-busy')).toBe('true');
    expect(waiting.textContent).toContain('Approving');
    await click(waiting);
    expect(posts).toHaveLength(1);

    // The sync the approval runs ends before the daemon answers: the stream brings the issue taken while Approve waits.
    await act(async () => { streamed.get('source.updated')!({ data: JSON.stringify(approved()[0]) }); });
    expect(groupOf(row(list()!, url(9)))).toBe('request');
    await act(async () => { release(); });
    await vi.waitFor(() => expect(row(list()!, url(9)).querySelector('[data-approved]')).not.toBeNull());
    const done = row(list()!, url(9));
    expect(groupOf(done)).toBe('request');
    expect(done.querySelector('[data-slot="request-card"]')).toBeNull();
    expect(done.textContent).toContain('taken');
    const requests = [...group(list()!, 'request').querySelectorAll<HTMLElement>('[data-intake-item]')].map((r) => r.getAttribute('data-intake-item'));
    expect(requests).toEqual([url(9), url(10)]);
    expect(group(list()!, 'request').querySelector('[data-intake-group-count]')!.textContent).toBe('1');
    expect(document.activeElement).toBe(done);
  });

  it.each([
    'already approved: its job is queued',
    'already taken, no approval needed: its job is running',
  ])('an approval answered "%s" (approved elsewhere since the page loaded) shows the issue approved, not an error (issue #1045)', async (why) => {
    await boot('#intake');
    daemon.answer = (body) => ({ done: [], failed: { [body.keys[0]!]: why } });
    await vi.waitFor(() => expect(view()).not.toBeNull());
    await click(button(row(view()!, url(9)), 'Approve'));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(row(view()!, url(9)).querySelector('[data-slot="request-error"]')).toBeNull();
    // The sync lists the issue taken, as the approval elsewhere made its job.
    await act(async () => { streamed.get('source.updated')!({ data: JSON.stringify(approved()[0]) }); });
    await vi.waitFor(() => expect(row(view()!, url(9)).querySelector('[data-approved]')).not.toBeNull());
  });

  it('a refused approval says why on the card, and the card stays with Approve', async () => {
    await boot('#intake');
    daemon.answer = (body) => ({ done: [], failed: { [body.keys[0]!]: 'its title or body changed since it was shown: read it again' } });
    await vi.waitFor(() => expect(view()).not.toBeNull());
    await click(button(row(view()!, url(9)), 'Approve'));
    await vi.waitFor(() => expect(row(view()!, url(9)).querySelector('[data-slot="request-error"]')).not.toBeNull());
    const card = row(view()!, url(9));
    expect(card.querySelector('[data-slot="request-error"]')!.textContent).toContain('its title or body changed since it was shown');
    expect(card.querySelector('[data-approved]')).toBeNull();
    expect(button(card, 'Approve')!.disabled).toBe(false);
  });
});

describe('Intake says why a source lists no issue (issue #1125)', () => {
  const panel = (name: string) => document.querySelector<HTMLElement>(`[data-intake="${name}"]`);
  const update = async (s: unknown) => { await act(async () => { streamed.get('source.updated')!({ data: JSON.stringify(s) }); }); };

  it('a paused source has its panel, with why it lists nothing', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    await update({ name: 'github-app', kind: 'github-app', state: 'disabled', itemsSeen: 0, jobsCreated: 0, activeJobs: 0,
      detail: { mode: 'app', paused: 'no GitHub account connected: the app takes the issues assigned to it — Sources → Connect GitHub' } });
    await vi.waitFor(() => expect(panel('github-app')).not.toBeNull());
    expect(panel('github-app')!.querySelector('[data-intake-paused]')!.textContent).toContain('Not listing issues: no GitHub account connected');
  });

  it('a repository the last sync could not list is named, with what GitHub said', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    await update({ ...SOURCES[0], detail: { ...DETAIL, repoErrors: { 'octo-user/gone': 'Could not resolve to a Repository' } } });
    await vi.waitFor(() => expect(view()!.querySelector('[data-intake-repo-error]')).not.toBeNull());
    const line = view()!.querySelector<HTMLElement>('[data-intake-repo-error="octo-user/gone"]')!;
    expect(line.textContent).toContain('octo-user/gone');
    expect(line.textContent).toContain('Could not resolve to a Repository');
  });

  it('a source whose last sync failed says so, with its error', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    await update({ ...SOURCES[0], state: 'error', lastError: 'list 1 repositories: GitHub refused the call', detail: DETAIL });
    await vi.waitFor(() => expect(view()!.querySelector('[data-intake-error]')).not.toBeNull());
    expect(view()!.querySelector('[data-intake-error]')!.textContent).toContain('The last sync failed: list 1 repositories: GitHub refused the call');
  });
});
