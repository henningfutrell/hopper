// The classifier is scheduled with setImmediate on job.queued: a stop, and the store's close after it, can come first.
import { describe, expect, it } from 'vitest';
import { createClassifier } from '../../src/engine/classifier.ts';

describe('the classifier', () => {
  it('reads nothing of the store once the hopper stops: the store may be closed', async () => {
    const reads: string[] = [];
    const classifier = createClassifier({
      stopping: () => true,
      router: { advise: async () => { throw new Error('not asked'); } },
      store: { jobs: { get: (id: string) => { reads.push(id); throw new Error('postgres: this database is closed'); } } },
    } as never);
    expect(() => classifier.classifyJob('j')).not.toThrow();
    await classifier.idle();
    expect(reads).toEqual([]);
  });
});
