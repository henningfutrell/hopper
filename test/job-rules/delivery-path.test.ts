// The delivery path (issue #1458): a job knows where its change lands and how a change another repository needs gets
// there, what delivered means, and that production waits for a person; so it files and follows a required child by
// itself and asks only about real decisions.
import { describe, expect, it } from 'vitest';
import { DELIVERY_LINE, FIXED_JOB_LINES, PROTOCOL_LINES } from '../../src/job-rules/index.ts';

describe('the delivery line', () => {
  it('is a fixed protocol line, after the decisions and question lines, so every job is told it whatever its job rules', () => {
    expect(PROTOCOL_LINES.indexOf(DELIVERY_LINE)).toBeGreaterThan(1);
    expect(FIXED_JOB_LINES).toContain(DELIVERY_LINE);
    expect(PROTOCOL_LINES.at(-1)).not.toBe(DELIVERY_LINE);
  });

  it('names where the change lands, the required child, what delivered means, production, and not to ask', () => {
    expect(DELIVERY_LINE).toMatch(/^\[hopper delivery\] /);
    for (const words of [
      "the job's own repository", 'through its pull request',
      'sh "$HOPPER_GH" issue create --repo OWNER/NAME', '--required', 'a job of that repository delivers it',
      'Do not ask a person to apply a patch',
      'its checks passed there', 'A pull request, a patch or an artifact is not delivered',
      "the repository's own rules and documents", 'production',
      "a person's approval", 'Do not ask a person to choose a delivery path',
    ]) expect(DELIVERY_LINE).toContain(words);
  });

  it('says the hopper routes a required child, so the job waits on it as an item, and asks a person only when not managed or gated (issue #1510)', () => {
    for (const words of [
      'The hopper labels a required child and assigns it', 'Intake lists it as a request card',
      'HOPPER_WAITING with on: issue OWNER/NAME#N', 'Do not ask a person to add the hopper label',
      'on: outside: not managed: <what>', 'on: outside: gated: <what>',
    ]) expect(DELIVERY_LINE).toContain(words);
  });

  it('tells a job with no issue to file the child without --required', () => {
    expect(DELIVERY_LINE).toContain('A job with no issue of its own files it with no --required');
  });
});
