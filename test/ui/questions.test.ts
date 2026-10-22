// @vitest-environment happy-dom
// The UI's question card (ui/src/views/questions.tsx), rendered in happy-dom inside the whole app
// against a fake of the daemon's HTTP surface: the browser's only seam. Logged out, there is no card,
// only the landing page (issue #213); logged in, it offers Send answer and Close (Close asks first, in
// a dialog); a 403 on a mutation logs the UI out, to the landing page. Dismiss
// drops a question (asks first); opening the view marks the owner's questions seen. The nav badge
// counts the open questions at the human stage, seen or not, and clears only when none is open (issue #499). The Questions view holds the open questions only (issue #151): the handled ones are
// the question history in Settings, a compact list, each opening to its question and answer.
// A session whose role cannot answer (viewer, issue #39) says so; a 403 naming the role needed keeps
// the session.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, button, card, click, emit, landing, notice, question, unmount, type Call } from './question-card-harness.ts';

afterEach(unmount);


describe('question card', () => {
  it('logged out: no card, only the landing page, with no login code box', async () => {
    await boot({ authed: false });
    await vi.waitFor(() => expect(landing()).not.toBeNull());
    expect(card()).toBeNull();
    expect(document.querySelector('input[aria-label="Login code"]')).toBeNull();
  });

  it('logged in: the answer box offers Send answer and Close', async () => {
    await boot({ authed: true });
    await vi.waitFor(() => expect(card()!.querySelector('textarea')).not.toBeNull());
    expect(button('Send answer')).toBeDefined();
    expect(button('Close')).toBeDefined();
    expect(notice()).toBeNull();
  });

  it('Report a bug on the card opens the report form, its context asked with no job (issues #694, #2478)', async () => {
    const daemon = await boot({ authed: true });
    await vi.waitFor(() => expect(button('Report a bug')).toBeDefined());
    await click(button('Report a bug'));
    await vi.waitFor(() => expect(document.querySelector('[data-slot="bug-report"]')).not.toBeNull());
    expect(daemon.calls).toContainEqual(expect.objectContaining({ path: '/ui/api/bug-reports/context', body: {} }));
  });

  it('Close asks first, then posts /ui/api/questions/:id/close with the session header and a JSON body', async () => {
    const daemon = await boot({ authed: true });
    await vi.waitFor(() => expect(button('Close')).toBeDefined());
    await click(button('Close'));
    const path = `/ui/api/questions/${question.id}/close`;
    expect(daemon.calls.some((c) => c.path === path)).toBe(false);
    const dialog = await vi.waitFor(() => { const d = document.querySelector('[role="alertdialog"]'); expect(d).not.toBeNull(); return d!; });
    await click(button('Close question', dialog));
    await vi.waitFor(() => expect(daemon.calls.some((c) => c.path === path)).toBe(true));
    const call = daemon.calls.find((c) => c.path === path)!;
    expect(call.method).toBe('POST');
    expect(call.headers['x-hopper-session']).toBe('a'.repeat(64));
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body).toEqual({});
  });

  it('a 403 on a mutation logs the UI out, to the landing page', async () => {
    await boot({ authed: true, mutationStatus: 403 });
    const box = await vi.waitFor(() => { const t = card()!.querySelector('textarea'); expect(t).not.toBeNull(); return t!; });
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(box, 'main');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Send answer'));
    await vi.waitFor(() => expect(landing()).not.toBeNull());
    expect(card()).toBeNull();
  });

  it('a viewer: no answer box; the card says the role cannot answer', async () => {
    await boot({ authed: true, role: 'viewer' });
    await vi.waitFor(() => expect(notice()?.textContent).toContain('viewer'));
    expect(card()!.querySelector('textarea')).toBeNull();
    expect(notice()?.textContent).toMatch(/cannot answer/);
  });

  it('a 403 naming the role needed keeps the session: the answer box stays', async () => {
    await boot({ authed: true, role: 'operator', mutationStatus: 403, needs: 'admin' });
    await vi.waitFor(() => expect(button('Close')).toBeDefined());
    await click(button('Close'));
    const dialog = await vi.waitFor(() => { const d = document.querySelector('[role="alertdialog"]'); expect(d).not.toBeNull(); return d!; });
    await click(button('Close question', dialog));
    await new Promise((r) => setTimeout(r, 50));
    expect(card()!.querySelector('textarea')).not.toBeNull();
    expect(localStorage.getItem('jh_session')).toBe('a'.repeat(64));
  });

  it('logged out with OIDC, GitHub or SAML realms: the landing page offers a sign-in button per realm', async () => {
    await boot({ authed: false, realms: [{ name: 'corp', label: 'Corp SSO', type: 'oidc' }] });
    await vi.waitFor(() => expect(button('Sign in with Corp SSO', document.body)).toBeDefined());
  });

  // Issue #376: a dialog the agent denies by itself when its countdown runs out says so, with the time left.
  it('a dialog with a countdown: the card says Claude Code denies it by itself, and when', async () => {
    await boot({ authed: true, lapsesAt: new Date(Date.now() + 90_000).toISOString() });
    const lapses = await vi.waitFor(() => { const l = card()!.querySelector('[data-slot="lapses"]'); expect(l).not.toBeNull(); return l!; });
    expect(lapses.textContent).toMatch(/^Claude Code denies this by itself in 1m.* unless it is answered first\.$/);
  });

  it('no countdown: no such line', async () => {
    await boot({ authed: true });
    await vi.waitFor(() => expect(card()!.querySelector('textarea')).not.toBeNull());
    expect(card()!.querySelector('[data-slot="lapses"]')).toBeNull();
  });

  it('logged in: Dismiss sits beside Close, asks first, then posts /ui/api/questions/:id/dismiss', async () => {
    const daemon = await boot({ authed: true });
    await vi.waitFor(() => expect(button('Dismiss')).toBeDefined());
    await click(button('Dismiss'));
    const path = `/ui/api/questions/${question.id}/dismiss`;
    expect(daemon.calls.some((c) => c.path === path)).toBe(false);
    const dialog = await vi.waitFor(() => { const d = document.querySelector('[role="alertdialog"]'); expect(d).not.toBeNull(); return d!; });
    expect(dialog.textContent).toContain('cancelled');
    await click(button('Dismiss question', dialog));
    await vi.waitFor(() => expect(daemon.calls.some((c) => c.path === path)).toBe(true));
    expect(daemon.calls.find((c) => c.path === path)!.body).toEqual({});
  });
});

const badge = () => document.querySelector('a[href="#questions"] [data-slot="nav-badge"]');

describe("the levels' recommendations on an escalated question", () => {
  const attempts = [
    { tier: 'opus', role: 'level', model: 'claude-opus-x', startedAt: '2026-10-03T20:00:00.000Z', answer: 'wait for the owner', escalate: true, reason: 'not sure', outcome: 'escalated' },
    { tier: 'fable', role: 'level', model: 'claude-fable-x', startedAt: '2026-10-03T20:00:01.000Z', answer: 'take option 1', escalate: true, reason: 'the owner picks', outcome: 'escalated' },
  ];

  const useButtons = () => [...card()!.querySelectorAll('button')].filter((b) => /^Use \w+'s answer$/.test(b.textContent?.trim() ?? ''));
  const answers = (daemon: { calls: Call[] }) => daemon.calls.filter((c) => c.path === `/ui/api/questions/${question.id}/answer`);
  const result = () => card()?.querySelector('[data-slot="answer-result"]') ?? null;
  // Issue #2375: the trail is folded behind "N model answers"; open it.
  const openTrail = async () => {
    const toggle = await vi.waitFor(() => { const t = card()!.querySelector<HTMLElement>('[data-slot="model-answers-toggle"]'); expect(t).not.toBeNull(); return t!; });
    await click(toggle);
  };

  it('show on the trail with the model that ran, each with a button that names whose answer it uses', async () => {
    await boot({ authed: true, attempts });
    await openTrail();
    await vi.waitFor(() => expect(card()!.querySelector('textarea')).not.toBeNull());
    expect(card()!.textContent).toContain('take option 1');
    expect(card()!.textContent).toContain('claude-fable-x');
    expect(useButtons().map((b) => b.textContent?.trim())).toEqual(["Use Opus's answer", "Use Fable's answer"]);
  });

  // Issue #459: one click sends; no separate Send. The same answer route as Send answer.
  it('Use answer sends that answer at once: exactly one POST of it, and the card says it was sent', async () => {
    const daemon = await boot({ authed: true, attempts });
    await openTrail();
    await vi.waitFor(() => expect(useButtons()).toHaveLength(2));
    await click(useButtons()[1]);
    await vi.waitFor(() => expect(answers(daemon)).toHaveLength(1));
    const call = answers(daemon)[0]!;
    expect(call.method).toBe('POST');
    expect(call.headers['x-hopper-session']).toBe('a'.repeat(64));
    expect(call.body).toEqual({ answer: 'take option 1' });
    await vi.waitFor(() => expect(result()?.textContent).toMatch(/sent/i));
    expect(card()!.querySelector('textarea')!.value).toBe('');
  });

  it('a double click is one submission: the buttons are disabled while it is in flight', async () => {
    const daemon = await boot({ authed: true, attempts, mutationDelayMs: 100 });
    await openTrail();
    await vi.waitFor(() => expect(useButtons()).toHaveLength(2));
    const use = useButtons()[0]!;
    await act(async () => { use.click(); use.click(); });
    expect(useButtons().every((b) => b.disabled)).toBe(true);
    expect(button('Sending…')!.disabled).toBe(true);
    await click(useButtons()[1]);
    await vi.waitFor(() => expect(result()?.textContent).toMatch(/sent/i));
    expect(answers(daemon)).toHaveLength(1);
    expect(answers(daemon)[0]!.body).toEqual({ answer: 'wait for the owner' });
  });

  it('a failed send says why on the card, with Retry, which sends the same answer again', async () => {
    const daemon = await boot({ authed: true, attempts, mutationStatus: 500, mutationError: 'database unavailable' });
    await openTrail();
    await vi.waitFor(() => expect(useButtons()).toHaveLength(2));
    await click(useButtons()[1]);
    await vi.waitFor(() => expect(result()?.textContent).toContain('database unavailable'));
    expect(answers(daemon)).toHaveLength(1);
    await click(button('Retry'));
    await vi.waitFor(() => expect(answers(daemon)).toHaveLength(2));
    expect(answers(daemon)[1]!.body).toEqual({ answer: 'take option 1' });
  });

  it('the answer box and Send answer stay, for an answer of the owner\'s own', async () => {
    await boot({ authed: true, attempts });
    await openTrail();
    await vi.waitFor(() => expect(button('Send answer')).toBeDefined());
    expect(card()!.querySelector('textarea')).not.toBeNull();
  });

  // Issue #1169: every question is answered through one Questionnaire form; Send answer is its submit.
  it('the answer box is the one question form: a questionnaire whose submit is Send answer', async () => {
    const daemon = await boot({ authed: true, attempts });
    await openTrail();
    const form = await vi.waitFor(() => { const f = card()!.querySelector<HTMLFormElement>('[data-slot="questionnaire"][data-question-form="answer"]'); expect(f).not.toBeNull(); return f!; });
    expect(form.querySelector('[data-slot="questionnaire-title"]')?.textContent).toBe('Your answer');
    expect(form.querySelector('textarea')?.getAttribute('aria-label')).toBe('Your answer');
    expect(button('Send answer')!.closest('[data-slot="questionnaire-submit"], [data-slot="questionnaire"]')).not.toBeNull();
    const box = form.querySelector('textarea')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'my own'); box.dispatchEvent(new Event('input', { bubbles: true })); });
    await click(button('Send answer'));
    await vi.waitFor(() => expect(answers(daemon)).toHaveLength(1));
    expect(answers(daemon)[0]!.body).toEqual({ answer: 'my own' });
  });
});

describe('the Questions badge', () => {
  // Issue #499: the badge counts what waits on the owner, not what they have not looked at yet.
  it('counts the open questions at the human stage; opening Questions marks them seen and the badge stays', async () => {
    const daemon = await boot({ authed: true, hash: '#dashboard' });
    await vi.waitFor(() => expect(badge()?.textContent).toBe('1'));
    expect(daemon.calls.some((c) => c.path.endsWith('/seen'))).toBe(false);
    await act(async () => { window.location.hash = '#questions'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await vi.waitFor(() => expect(daemon.calls.some((c) => c.path === `/ui/api/questions/${question.id}/seen` && c.method === 'POST')).toBe(true));
    await vi.waitFor(() => expect(daemon.open.seenAt).toBeDefined());
    await act(async () => { window.location.hash = '#dashboard'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(badge()?.textContent).toBe('1');
  });

  it('a question already seen still counts on a fresh load', async () => {
    await boot({ authed: true, hash: '#dashboard', seenAt: '2026-10-03T20:01:00.000Z' });
    await vi.waitFor(() => expect(badge()?.textContent).toBe('1'));
  });

  it('a question still with an escalation level does not count: it does not wait on the owner yet', async () => {
    await boot({ authed: true, hash: '#dashboard', tier: 'opus' });
    await vi.waitFor(() => expect(document.querySelector('a[href="#questions"]')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(badge()).toBeNull();
  });

  it('clears only when none is open, and comes back when one is raised: live, from the stream, no reload', async () => {
    const daemon = await boot({ authed: true, hash: '#dashboard', seenAt: '2026-10-03T20:01:00.000Z' });
    await vi.waitFor(() => expect(badge()?.textContent).toBe('1'));
    daemon.setOpen([]);
    await emit('question.answered');
    await vi.waitFor(() => expect(badge()).toBeNull());
    daemon.setOpen([{ ...daemon.open, seenAt: undefined }, { ...daemon.open, id: 'd0e1f2a3', seenAt: undefined }]);
    await emit('question.escalated_to_human');
    await vi.waitFor(() => expect(badge()?.textContent).toBe('2'));
  });
});

describe('handled questions', () => {
  it('are not on the Questions view, nor are the question gates', async () => {
    await boot({ authed: true });
    expect(document.querySelector('[data-slot="handled-questions"]')).toBeNull();
    expect(document.querySelector('[data-slot="question-gates"]')).toBeNull();
  });

  it('are the question history, a section of Questions (issue #897), a compact list; a row opens to the question, the answer and who gave it', async () => {
    await boot({ authed: true, hash: '#questions/history' });
    const list = await vi.waitFor(() => { const l = document.querySelector('[data-slot="handled-questions"]'); expect(l).not.toBeNull(); return l!; });
    const rows = list.querySelectorAll('[data-slot="handled-question"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Rebase or merge?');
    expect(rows[0]!.textContent).toContain('answered');
    expect(rows[0]!.textContent).not.toContain('merge\n');
    await click(rows[0]!.querySelector('button') as HTMLElement);
    const marker = await vi.waitFor(() => { const m = rows[0]!.querySelector('[data-slot="marker"][data-answer-source]'); expect(m).not.toBeNull(); return m!; });
    expect(marker.getAttribute('data-answer-source')).toBe('person');
    expect(marker.textContent).toBe('Answered by a person');
    expect(rows[0]!.querySelector('[data-slot="question-text"]')?.textContent).toContain('Rebase or merge?');
    expect(list.textContent).not.toContain(question.text);
  });
});
