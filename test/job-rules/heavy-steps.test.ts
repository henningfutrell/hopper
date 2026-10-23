// Issue #2622 part 3: a JVM build that a job starts as `./gradlew` is a path, so no shim on its PATH asks the heavy-step
// gate for it. Every job is told to run a heavy step through `sh "$HOPPER_HEAVY"`, and that the shims ask by themselves.
import { describe, expect, it } from 'vitest';
import { FIXED_JOB_LINES, HEAVY_STEPS_LINE, INFRA_TOOLS_LINE, PROTOCOL_LINES } from '../../src/job-rules/index.ts';

describe('the heavy steps line', () => {
  it('is a fixed protocol line, right after the infra tools line, so every job is told it whatever its job rules', () => {
    expect(PROTOCOL_LINES.indexOf(HEAVY_STEPS_LINE)).toBe(PROTOCOL_LINES.indexOf(INFRA_TOOLS_LINE) + 1);
    expect(FIXED_JOB_LINES).toContain(HEAVY_STEPS_LINE);
  });

  it('names the heavy steps, how to run one through the gate, and that the wait says why', () => {
    expect(HEAVY_STEPS_LINE).toMatch(/^\[hopper heavy steps\] /);
    for (const words of ['./gradlew', './mvnw', 'sh "$HOPPER_HEAVY" ./gradlew test', 'says why', 'gradle, mvn, npm, pnpm, yarn, npx and playwright']) {
      expect(HEAVY_STEPS_LINE).toContain(words);
    }
  });
});
