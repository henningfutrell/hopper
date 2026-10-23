// The build defaults (issue #2622, design.md "Work tree" → "The job's environment"): four lanes on one host each ran a JVM
// build with the project's own heap settings — a 2 GiB Gradle JVM, a Kotlin compile daemon of its own, a test worker per
// CPU — and together took the whole VM. Every job's tools get capped options in GRADLE_OPTS and MAVEN_OPTS. Gradle reads
// its properties from the client JVM's system properties over every gradle.properties, and Maven puts MAVEN_OPTS after
// `.mvn/jvm.config`, so a project's own settings cannot raise them; the payload's own options come after them, and win.

/** Gradle: no daemon, its build JVM at 2 GiB (a job's memory, MEMORY_PER_JOB_GIB), 2 workers, Kotlin compiled in that JVM. */
export const GRADLE_BUILD_DEFAULTS = '-Dorg.gradle.daemon=false -Dorg.gradle.jvmargs=-Xmx2g -Dorg.gradle.workers.max=2'
  + ' -Dkotlin.compiler.execution.strategy=in-process';
/** Maven: its JVM at 2 GiB. */
export const MAVEN_BUILD_DEFAULTS = '-Xmx2g';
/** Gradle's daemon idle timeout in a job (issue #2489): 5 minutes, not Gradle's 3 hours, so it ends soon after its build. */
export const GRADLE_IDLE_OPT = '-Dorg.gradle.daemon.idletimeout=300000';

const joined = (...opts: (string | undefined)[]): string => opts.filter((o) => o).join(' ');

/** GRADLE_OPTS and MAVEN_OPTS: the build defaults, then the payload's own (`env`); Gradle's idle timeout last, which wins. */
export const buildDefaultsEnv = (env: Readonly<Record<string, string>> = {}): Record<'GRADLE_OPTS' | 'MAVEN_OPTS', string> => ({
  GRADLE_OPTS: joined(GRADLE_BUILD_DEFAULTS, env.GRADLE_OPTS, GRADLE_IDLE_OPT),
  MAVEN_OPTS: joined(MAVEN_BUILD_DEFAULTS, env.MAVEN_OPTS),
});
