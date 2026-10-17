// Decline on a request card (issues #1035, #1710, design.md "Decline"): the person picks what happens to the issue, and
// GitHub keeps the record, so every hopper on the repository sees it. `close`: the issue is closed as not planned and
// loses the source's label, its priority labels and `hopper:done`. `open`: the issue stays open and loses the source's
// label only, so no hopper lists it. Either way one short comment says what the hopper did and how to queue it again. The
// issue comes back only when a person adds the label again (and reopens it, when it was closed). An admin sets the choice
// the confirm step offers first (Settings → Intake): Leave open for a request card, Close for a reopened card by default.
// Pure.

export const DECLINE_CHOICES = ['close', 'open'] as const;
export type DeclineChoice = typeof DECLINE_CHOICES[number];

/** The choice the confirm step offers first, for a request card and for a reopened card (issue #1126). */
export interface IntakeDeclineDefaults {
  request: DeclineChoice;
  reopened: DeclineChoice;
}

export const DEFAULT_INTAKE_DECLINE: IntakeDeclineDefaults = { request: 'open', reopened: 'close' };

/** The default choice for a card. */
export const declineChoiceFor = (d: IntakeDeclineDefaults, reopened: boolean): DeclineChoice => (reopened ? d.reopened : d.request);

/**
 * The comment a decline posts on the issue: what the hopper did and how to queue it again. It names no person and never
 * quotes the issue's text.
 */
export function declineNote(choice: DeclineChoice, reopened: boolean, label: string): string {
  const what = reopened ? 'Declined in hopper Intake after the issue was reopened' : 'Declined in hopper Intake';
  return choice === 'close'
    ? `${what}: hopper closed this issue as not planned and removed its hopper labels. To queue it again, reopen it and add the \`${label}\` label.`
    : `${what}: hopper removed the \`${label}\` label, so no hopper queues it. The issue stays open. To queue it again, add the \`${label}\` label.`;
}
