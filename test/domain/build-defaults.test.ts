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

// Issue #2737: the build JVMs and their workers take their sizes from the job's own limits, not from a fixed 2 GiB and 2
// workers: the build JVM's heap is half the job's memory limit, and Gradle gets a worker for each GiB of the other half, at
// most one for each CPU of its CPU quota, and at least one. With no memory limit, the fixed defaults stay.
describe('build JVMs sized from the job limits (issue #2737)', () => {
  const idle = '-Dorg.gradle.daemon.idletimeout=300000';
  const gradleOf = (heap: string, workers: number): string =>
    `-Dorg.gradle.daemon=false -Dorg.gradle.jvmargs=-Xmx${heap} -Dorg.gradle.workers.max=${workers} -Dkotlin.compiler.execution.strategy=in-process ${idle}`;

  it('gives the build JVM half the memory limit, and a worker for each GiB of the other half', () => {
    expect(buildDefaultsEnv({}, { memoryMaxGiB: 9 })).toMatchObject({ GRADLE_OPTS: gradleOf('4608m', 4), MAVEN_OPTS: '-Xmx4608m' });
    expect(buildDefaultsEnv({}, { memoryMaxGiB: 2 })).toMatchObject({ GRADLE_OPTS: gradleOf('1024m', 1), MAVEN_OPTS: '-Xmx1024m' });
  });

  it('gives no more workers than the CPU quota holds CPUs, and at least one', () => {
    expect(buildDefaultsEnv({}, { memoryMaxGiB: 9, cpuPercent: 200 })).toMatchObject({ GRADLE_OPTS: gradleOf('4608m', 2) });
    expect(buildDefaultsEnv({}, { memoryMaxGiB: 9, cpuPercent: 50 })).toMatchObject({ GRADLE_OPTS: gradleOf('4608m', 1) });
    expect(buildDefaultsEnv({}, { memoryMaxGiB: 1 })).toMatchObject({ GRADLE_OPTS: gradleOf('512m', 1) });
  });

  it('keeps the payload\'s own options after the sized ones, so they win', () => {
    expect(buildDefaultsEnv({ MAVEN_OPTS: '-Xmx3g' }, { memoryMaxGiB: 9 })).toMatchObject({ MAVEN_OPTS: '-Xmx4608m -Xmx3g' });
  });

  it('keeps the fixed defaults with a CPU quota but no memory limit', () => {
    expect(buildDefaultsEnv({}, { cpuPercent: 100 })).toMatchObject({ MAVEN_OPTS: '-Xmx2g' });
  });
});

// Issue #2737: vitest starts a worker for each CPU it sees, each a Node process with a heap of its own, whatever the job's
// memory limit. With a memory limit, VITEST_MAX_WORKERS (which vitest reads over its config) gets the job's worker count,
// the same as Gradle's; the payload's own value wins. With no memory limit, none.
describe('test runner workers sized from the job limits (issue #2737)', () => {
  it('gives vitest a worker for each GiB of half the memory limit, at most one for each CPU of the quota', () => {
    expect(buildDefaultsEnv({}, { memoryMaxGiB: 9 })).toMatchObject({ VITEST_MAX_WORKERS: '4' });
    expect(buildDefaultsEnv({}, { memoryMaxGiB: 9, cpuPercent: 200 })).toMatchObject({ VITEST_MAX_WORKERS: '2' });
    expect(buildDefaultsEnv({}, { memoryMaxGiB: 1 })).toMatchObject({ VITEST_MAX_WORKERS: '1' });
  });

  it('keeps the payload\'s own worker count', () => {
    expect(buildDefaultsEnv({ VITEST_MAX_WORKERS: '8' }, { memoryMaxGiB: 9 })).toMatchObject({ VITEST_MAX_WORKERS: '8' });
  });

  it('sets no worker count with no memory limit', () => {
    expect(buildDefaultsEnv()).not.toHaveProperty('VITEST_MAX_WORKERS');
    expect(buildDefaultsEnv({}, { cpuPercent: 100 })).not.toHaveProperty('VITEST_MAX_WORKERS');
  });
});
