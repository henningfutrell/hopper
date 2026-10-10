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
    expect(button("Use Fable's answer")).toBeDefined();
  });

  it('not confident, and a reason not recorded, say so plainly', async () => {
    await boot({ authed: true, escalation: { reason: 'low_confidence', recommendation: { by: 'fable', answer: 'maybe', confidence: 'medium' } } });
    await vi.waitFor(() => expect(banner()?.textContent).toMatch(/Sent to you because Fable was not confident enough \(medium confidence\)/));
    await unmount();
    await boot({ authed: true });
    await vi.waitFor(() => expect(banner()?.textContent).toMatch(/Sent to you/));
  });

  it('the trail no longer shows "(no rules yet)"', async () => {
    await boot({ authed: true, attempts: [fableSaysGo], escalation: guard });
    await vi.waitFor(() => expect(card()!.textContent).toContain('fine'));
    expect(card()!.textContent).not.toContain('no rules yet');
  });

  it('the list filters by reason, each with its count', async () => {
    const other = (id: string, text: string, escalation: unknown) => ({ ...question, id, text, escalation });
    await boot({
      authed: true, escalation: guard,
      more: [other('a1', 'Push the tag?', guard), other('a2', 'Which name?', { reason: 'low_confidence' })],
    });
    const filters = () => document.querySelector('[data-slot="reason-filter"]');
    await vi.waitFor(() => expect(filters()).not.toBeNull());
    const chip = (label: RegExp) => [...filters()!.querySelectorAll('button')].find((b) => label.test(b.textContent ?? ''));
    expect(chip(/^All\s*3$/)).toBeDefined();
    expect(chip(/^Guard\s*2$/)).toBeDefined();
    expect(chip(/^Not confident\s*1$/)).toBeDefined();
    const shown = () => [...document.querySelectorAll('[data-question]')].map((x) => x.getAttribute('data-question'));
    expect(shown()).toHaveLength(3);
    await click(chip(/^Not confident/));
    expect(shown()).toEqual(['a2']);
    await click(chip(/^Guard/));
    expect(shown().sort()).toEqual(['a1', question.id].sort());
    await click(chip(/^All/));
    expect(shown()).toHaveLength(3);
  });
});
