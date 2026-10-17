// Issue #1502: a job ran terraform on the machine, which wrote ~/.terraform.d, and the credential check then held the
// machine. Every job is told to run infrastructure tools only in a sandbox the hopper starts for it.
import { describe, expect, it } from 'vitest';
import { FIXED_JOB_LINES, INFRA_TOOLS_LINE, PROTOCOL_LINES, SKILL_LINE } from '../../src/job-rules/index.ts';

describe('the infra tools line', () => {
  it('is a fixed protocol line, right after the skills line, so every job is told it whatever its job rules', () => {
    expect(PROTOCOL_LINES.indexOf(INFRA_TOOLS_LINE)).toBe(PROTOCOL_LINES.indexOf(SKILL_LINE) + 1);
    expect(FIXED_JOB_LINES).toContain(INFRA_TOOLS_LINE);
    expect(PROTOCOL_LINES.at(-1)).not.toBe(INFRA_TOOLS_LINE);
  });

  it('names the tools, the sandbox, how to ask for one, and why not on the machine', () => {
    expect(INFRA_TOOLS_LINE).toMatch(/^\[hopper infra tools\] /);
    for (const words of ['terraform', 'aws', 'kubectl', 'helm', 'only in a sandbox the hopper starts for the job', 'sh "$HOPPER_SKILL"', 'Never run them on this machine', 'takes no new job']) {
      expect(INFRA_TOOLS_LINE).toContain(words);
    }
  });
});
