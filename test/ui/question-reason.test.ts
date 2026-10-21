// @vitest-environment happy-dom
// Issue #679: the top of a question card says why the question came to a person and what the level recommended, with
// nothing expanded; the Use button names the level; the trail no longer says "(no rules yet)"; the Questions list
// filters by the reason, each with its count. The whole app in happy-dom against a fake daemon (question-card-harness.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, button, card, click, question, unmount } from './question-card-harness.ts';

afterEach(unmount);

describe('why a question came to a person', () => {
  const banner = (c: Element | null = card()) => c?.querySelector('[data-slot="escalation-reason"]') ?? null;
  const fableSaysGo = { tier: 'fable', role: 'level', startedAt: '2026-10-03T20:00:01.000Z', answer: 'Go ahead', escalate: false, confidence: 'high', riskRules: ['credentials'], reason: 'fine (no rules yet)', outcome: 'escalated' };
  const guard = {
    reason: 'guard', guards: [{ name: 'credentials', describe: 'credentials, secrets, passwords, keys or tokens' }],
    recommendation: { by: 'fable', answer: 'Go ahead', confidence: 'high' },
  };

  it('a guard: the banner names it, says the answer was held back on purpose, and what Fable says; above the question', async () => {
    await boot({ authed: true, attempts: [fableSaysGo], escalation: guard });
    const b = await vi.waitFor(() => { const x = banner(); expect(x).not.toBeNull(); return x!; });
    expect(b.textContent).toMatch(/Sent to you because a guard holds it: credentials/);
    expect(b.textContent).toMatch(/held back on purpose/);
    expect(b.textContent).toMatch(/Fable says: Go ahead/);
    expect(b.compareDocumentPosition(card()!.querySelector('[data-slot="question-text"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Issue #2375: the trail is folded behind "1 model answer".
    await click(card()!.querySelector<HTMLElement>('[data-slot="model-answers-toggle"]')!);
    expect(button("Use Fable's answer")).toBeDefined();
  });

  it('not confident, and a reason not recorded, say so plainly', async () => {
    await boot({ authed: true, escalation: { reason: 'low_confidence', recommendation: { by: 'fable', answer: 'maybe', confidence: 'medium' } } });
    await vi.waitFor(() => expect(banner()?.textContent).toMatch(/Sent to you because Fable was not confident enough \(medium confidence\)/));
    await unmount();
    await boot({ authed: true });
    await vi.waitFor(() => expect(banner()?.textContent).toMatch(/Sent to you/));
  });

  it('every hold: the banner lists each reason, and what Fable says', async () => {
    const all = {
      reason: 'guard', guards: [{ name: 'credentials', describe: 'credentials, secrets, passwords, keys or tokens' }],
      holds: [
        { reason: 'guard', by: 'risk', guards: [{ name: 'credentials', describe: 'credentials, secrets, passwords, keys or tokens' }] },
        { reason: 'high_priority' },
        { reason: 'low_confidence', confidence: 'medium', threshold: 'high' },
      ],
      recommendation: { by: 'fable', answer: 'Go ahead', confidence: 'medium' },
    };
    await boot({ authed: true, attempts: [fableSaysGo], escalation: all });
    const b = await vi.waitFor(() => { const x = banner(); expect(x).not.toBeNull(); return x!; });
    expect(b.textContent).toMatch(/Sent to you because risk rule credentials holds it, its job is high priority and Fable was not confident enough \(medium confidence, needs high\)\./);
    expect(b.textContent).toMatch(/held back on purpose/);
    expect(b.textContent).toMatch(/Fable says: Go ahead/);
  });

  it('issue #679: a card the keyword rules checked says so, with a link to set up the Decider', async () => {
    await boot({ authed: true, attempts: [fableSaysGo], escalation: { ...guard, riskCheck: { by: 'rules' } } });
    const note = await vi.waitFor(() => { const x = banner()?.querySelector('[data-slot="risk-check-note"]'); expect(x).toBeTruthy(); return x!; });
    expect(note.textContent).toMatch(/Risk checked by keyword rules; set up the Decider for better checks\./);
    expect(note.querySelector('a')?.getAttribute('href')).toBe('#settings/decider');
  });

  it('the trail no longer shows "(no rules yet)"', async () => {
    await boot({ authed: true, attempts: [fableSaysGo], escalation: guard });
    await click(await vi.waitFor(() => { const t = card()?.querySelector<HTMLElement>('[data-slot="model-answers-toggle"]'); expect(t).toBeTruthy(); return t!; }));
    await vi.waitFor(() => expect(card()!.textContent).toContain('fine'));
    expect(card()!.textContent).not.toContain('no rules yet');
  });

  it('the list filters by reason, each with its count', async () => {
    const other = (id: string, text: string, escalation: unknown) => ({ ...question, id, text, escalation });
    await boot({
      authed: true, escalation: guard,
      more: [other('a1', 'Push the tag?', guard), other('a2', 'Which name?', { reason: 'low_confidence' }),
        // Held by a guard and not confident (issue #679): it counts under both.
        other('a3', 'Rotate it?', { ...guard, holds: [{ reason: 'guard', by: 'risk', guards: guard.guards }, { reason: 'low_confidence', confidence: 'low', threshold: 'high' }] })],
    });
    const filters = () => document.querySelector('[data-slot="reason-filter"]');
    await vi.waitFor(() => expect(filters()).not.toBeNull());
    const chip = (label: RegExp) => [...filters()!.querySelectorAll('button')].find((b) => label.test(b.textContent ?? ''));
    expect(chip(/^All\s*4$/)).toBeDefined();
    expect(chip(/^Guard\s*3$/)).toBeDefined();
    expect(chip(/^Not confident\s*2$/)).toBeDefined();
    const shown = () => [...document.querySelectorAll('[data-question]')].map((x) => x.getAttribute('data-question'));
    expect(shown()).toHaveLength(4);
    await click(chip(/^Not confident/));
    expect(shown().sort()).toEqual(['a2', 'a3']);
    await click(chip(/^Guard/));
    expect(shown().sort()).toEqual(['a1', 'a3', question.id].sort());
    await click(chip(/^All/));
    expect(shown()).toHaveLength(4);
  });
});
