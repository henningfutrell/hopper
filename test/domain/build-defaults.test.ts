import { describe, expect, it } from 'vitest';
import { buildDefaultsEnv } from '../../src/domain/build-defaults.ts';

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
