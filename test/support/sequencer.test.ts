// Issue #2046: with no duration cache, as on CI, vitest starts the larger test files first, and the crash tests are
// small files of long tests. They started last and ran alone at the end of the shard, past the shard's time limit.
import { describe, expect, it } from 'vitest';
import { crashFirst } from './sequencer.ts';

describe('crashFirst', () => {
  it('puts the crash tests first and keeps the order of each part', () => {
    const files = ['/r/test/ui/a.test.ts', '/r/test/crash/proxy-kill.test.ts', '/r/test/integration/b.test.ts', '/r/test/crash/random.test.ts'];
    expect(crashFirst(files, (f) => f)).toEqual([
      '/r/test/crash/proxy-kill.test.ts', '/r/test/crash/random.test.ts', '/r/test/ui/a.test.ts', '/r/test/integration/b.test.ts',
    ]);
  });
});
