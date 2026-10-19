// The test order (issue #2046). With no duration cache, as on CI, vitest starts the larger test files first. The crash
// tests (test/crash/) are small files of long tests: each starts hoppers as child processes and kills them. Started last,
// they ran alone at the end of a shard, past its 10-minute limit. This sequencer starts them first, so the other workers
// run the rest of the shard beside them.
import { BaseSequencer, type TestSpecification } from 'vitest/node';

const CRASH = /[/\\]test[/\\]crash[/\\]/;

export function crashFirst<T>(files: readonly T[], path: (file: T) => string): T[] {
  return [...files.filter((f) => CRASH.test(path(f))), ...files.filter((f) => !CRASH.test(path(f)))];
}

export class CrashFirstSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return crashFirst(await super.sort(files), (f) => f.moduleId);
  }
}
