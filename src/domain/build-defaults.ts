// The build defaults (issue #2622, design.md "Work tree" → "The job's environment"): four lanes on one host each ran a JVM
// build with the project's own heap settings — a 2 GiB Gradle JVM, a Kotlin compile daemon of its own, a test worker per
// CPU — and together took the whole VM. Every job's tools get capped options in GRADLE_OPTS and MAVEN_OPTS. Gradle reads
// its properties from the client JVM's system properties over every gradle.properties, and Maven puts MAVEN_OPTS after
// `.mvn/jvm.config`, so a project's own settings cannot raise them; the payload's own options come after them, and win.
// Issue #2721: Node sizes its default heap from the cgroup's memory limit (`process.constrainedMemory()`), a quarter of it,
// so in a scope with MemoryMax=9G tsc got 2144 MB and aborted with "JavaScript heap out of memory". A job with a memory
// limit gets `--max-old-space-size` at NODE_HEAP_SHARE of it in NODE_OPTIONS, after the payload's own options.
import type { JobLimits } from './job-limits.ts';

/** Gradle: no daemon, its build JVM at 2 GiB (a job's memory, MEMORY_PER_JOB_GIB), 2 workers, Kotlin compiled in that JVM. */
export const GRADLE_BUILD_DEFAULTS = '-Dorg.gradle.daemon=false -Dorg.gradle.jvmargs=-Xmx2g -Dorg.gradle.workers.max=2'
  + ' -Dkotlin.compiler.execution.strategy=in-process';
/** Maven: its JVM at 2 GiB. */
export const MAVEN_BUILD_DEFAULTS = '-Xmx2g';
/** Gradle's daemon idle timeout in a job (issue #2489): 5 minutes, not Gradle's 3 hours, so it ends soon after its build. */
export const GRADLE_IDLE_OPT = '-Dorg.gradle.daemon.idletimeout=300000';

/** Node's old space, as this share of the job's memory limit (issue #2721): below MemoryHigh (90%), room for the rest. */
export const NODE_HEAP_SHARE = 0.75;

/** `--max-old-space-size` for a job whose memory limit is `memoryMaxGiB`, in MiB. */
export const nodeHeapMiB = (memoryMaxGiB: number): number => Math.floor(memoryMaxGiB * 1024 * NODE_HEAP_SHARE);

const joined = (...opts: (string | undefined)[]): string => opts.filter((o) => o).join(' ');

/** A heap size Node takes from NODE_OPTIONS: `-` and `_` mean the same in its flags. */
const HEAP_FLAG = /--max[-_]old[-_]space[-_]size\b/;

/**
 * GRADLE_OPTS and MAVEN_OPTS: the build defaults, then the payload's own (`env`); Gradle's idle timeout last, which wins.
 * With a memory limit (`limits`), NODE_OPTIONS: the payload's own, then the job's heap, unless the payload set one.
 */
export const buildDefaultsEnv = (env: Readonly<Record<string, string>> = {}, limits?: JobLimits): Record<string, string> => ({
  GRADLE_OPTS: joined(GRADLE_BUILD_DEFAULTS, env.GRADLE_OPTS, GRADLE_IDLE_OPT),
  MAVEN_OPTS: joined(MAVEN_BUILD_DEFAULTS, env.MAVEN_OPTS),
  ...(limits?.memoryMaxGiB !== undefined ? {
    NODE_OPTIONS: HEAP_FLAG.test(env.NODE_OPTIONS ?? '') ? env.NODE_OPTIONS! : joined(env.NODE_OPTIONS, `--max-old-space-size=${nodeHeapMiB(limits.memoryMaxGiB)}`),
  } : {}),
});
