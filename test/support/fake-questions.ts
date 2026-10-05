// The escalation levels every integration test runs with unless it passes its own seams: no model
// is called. Level `opus` answers `fake opus answer`, and escalates a question that says "unsure",
// "risky" or "hard". Level `fable` answers `fake fable answer`, and escalates one that says "risky"
// or "hard" to the owner. The risk rules apply on top, as for real plugins (a question about
// deleting reaches the human).
import type { EscalationLevel } from '../../src/domain/ports.ts';
import { createFakeLevel } from '../../src/questions/index.ts';

const fakeLevel = (name: string, escalates: RegExp): EscalationLevel => createFakeLevel({
  name,
  script: (req) => {
    const escalate = escalates.test(req.question.text);
    return { answer: `fake ${name} answer`, escalate, reason: `fake ${name}: escalate=${escalate}` };
  },
});

export function fakeLevels(): { levels: EscalationLevel[] } {
  return { levels: [fakeLevel('opus', /\b(unsure|risky|hard)\b/i), fakeLevel('fable', /\b(risky|hard)\b/i)] };
}
