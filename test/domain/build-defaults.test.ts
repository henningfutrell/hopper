import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildDefaultsEnv, nodeHeapMiB } from '../../src/domain/build-defaults.ts';

// Issue #2622: four lanes on one host each ran a JVM build with the project's own heap settings (a 2 GiB Gradle JVM, a
// Kotlin compile daemon of its own, a test worker per CPU) and took the whole VM. Every job's tools get capped build
// defaults; a project's own gradle.properties or .mvn/jvm.config comes before them, the payload's own after them.
describe('build defaults (issue #2622)', () => {
  const gradle = '-Dorg.gradle.daemon=false -Dorg.gradle.jvmargs=-Xmx2g -Dorg.gradle.workers.max=2'
    + ' -Dkotlin.compiler.execution.strategy=in-process -Dorg.gradle.daemon.idletimeout=300000';

  it('caps the Gradle build JVM, its workers and the Kotlin compiler, and the Maven JVM', () => {
    expect(buildDefaultsEnv()).toEqual({ GRADLE_OPTS: gradle, MAVEN_OPTS: '-Xmx2g' });
  });

  it("puts the payload's own options after the caps, so they win, and keeps the idle timeout last", () => {
    expect(buildDefaultsEnv({ GRADLE_OPTS: '-Xmx4g', MAVEN_OPTS: '-Xmx3g' })).toEqual({
      GRADLE_OPTS: '-Dorg.gradle.daemon=false -Dorg.gradle.jvmargs=-Xmx2g -Dorg.gradle.workers.max=2'
        + ' -Dkotlin.compiler.execution.strategy=in-process -Xmx4g -Dorg.gradle.daemon.idletimeout=300000',
      MAVEN_OPTS: '-Xmx2g -Xmx3g',
    });
  });
});

// Issue #2721: Node sizes its default heap from the cgroup's memory limit, so in a job's scope with MemoryMax=9G its heap
// was 2144 MB, and tsc, which needs about 3.1 GB, aborted with "JavaScript heap out of memory". A job with a memory limit
// gets NODE_OPTIONS with --max-old-space-size at 75% of it, after the payload's own NODE_OPTIONS; never over its own value.
describe('Node heap in a job with a memory limit (issue #2721)', () => {
  const heapOf = (env: Record<string, string>): number => {
    const r = spawnSync(process.execPath, ['-e', 'console.log(require("v8").getHeapStatistics().heap_size_limit / 2 ** 20)'], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    return Number(r.stdout.trim());
  };

  it('is 75% of the memory limit, in MiB', () => {
    expect(nodeHeapMiB(9)).toBe(6912);
    expect(nodeHeapMiB(2)).toBe(1536);
  });

  it('sets NODE_OPTIONS only with a memory limit, after the payload\'s own options', () => {
    expect(buildDefaultsEnv()).not.toHaveProperty('NODE_OPTIONS');
    expect(buildDefaultsEnv({}, { cpuPercent: 100 })).not.toHaveProperty('NODE_OPTIONS');
    expect(buildDefaultsEnv({}, { memoryMaxGiB: 9 })).toMatchObject({ NODE_OPTIONS: '--max-old-space-size=6912' });
    expect(buildDefaultsEnv({ NODE_OPTIONS: '--enable-source-maps' }, { memoryMaxGiB: 9 }))
      .toMatchObject({ NODE_OPTIONS: '--enable-source-maps --max-old-space-size=6912' });
  });

  it('never overrides a heap size the payload set', () => {
    expect(buildDefaultsEnv({ NODE_OPTIONS: '--max-old-space-size=12000' }, { memoryMaxGiB: 9 })).toMatchObject({ NODE_OPTIONS: '--max-old-space-size=12000' });
    expect(buildDefaultsEnv({ NODE_OPTIONS: '--max_old_space_size=12000' }, { memoryMaxGiB: 9 })).toMatchObject({ NODE_OPTIONS: '--max_old_space_size=12000' });
  });

  it('gives a node in the job a heap of at least 3 GB with the default limit of 9 GiB, and the share of a smaller one', () => {
    expect(heapOf(buildDefaultsEnv({}, { memoryMaxGiB: 9 }))).toBeGreaterThanOrEqual(3 * 1024);
    expect(heapOf(buildDefaultsEnv({}, { memoryMaxGiB: 2 }))).toBeGreaterThanOrEqual(1536);
  });
});
