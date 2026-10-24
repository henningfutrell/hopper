// The build defaults (issue #2622, design.md "Work tree" → "The job's environment"): four lanes on one host each ran a JVM
// build with the project's own heap settings — a 2 GiB Gradle JVM, a Kotlin compile daemon of its own, a test worker per
// CPU — and together took the whole VM. Every job's tools get capped options in GRADLE_OPTS and MAVEN_OPTS. Gradle reads
// its properties from the client JVM's system properties over every gradle.properties, and Maven puts MAVEN_OPTS after
// `.mvn/jvm.config`, so a project's own settings cannot raise them; the payload's own options come after them, and win.
// Issue #2721: Node sizes its default heap from the cgroup's memory limit (`process.constrainedMemory()`), a quarter of it,
// so in a scope with MemoryMax=9G tsc got 2144 MB and aborted with "JavaScript heap out of memory". A job with a memory
// limit gets `--max-old-space-size` at NODE_HEAP_SHARE of it in NODE_OPTIONS, after the payload's own options.
// Issue #2737: with a memory limit, the build JVMs take their sizes from it in place of the fixed 2 GiB and 2 workers: the
// build JVM's heap is JVM_HEAP_SHARE of it, and Gradle gets a worker for each GiB of the rest, at most one for each CPU of
// the job's CPU quota. Every other JVM (a test worker, a forked compiler) sizes its own heap from the scope's cgroup limit.
import type { JobLimits } from './job-limits.ts';

/** Gradle: no daemon, its build JVM at `heap`, `workers` workers, Kotlin compiled in that JVM. */
const gradleDefaults = (heap: string, workers: number): string =>
  `-Dorg.gradle.daemon=false -Dorg.gradle.jvmargs=-Xmx${heap} -Dorg.gradle.workers.max=${workers} -Dkotlin.compiler.execution.strategy=in-process`;
/** Gradle with no memory limit: its build JVM at 2 GiB (a job's memory, MEMORY_PER_JOB_GIB), 2 workers. */
export const GRADLE_BUILD_DEFAULTS = gradleDefaults('2g', 2);
/** Maven with no memory limit: its JVM at 2 GiB. */
export const MAVEN_BUILD_DEFAULTS = '-Xmx2g';

/** The build JVM's heap, as this share of the job's memory limit (issue #2737): the rest is for its workers and Node. */
export const JVM_HEAP_SHARE = 0.5;

/** Gradle's workers with a memory limit of `memoryMaxGiB`: one for each GiB over the build JVM's heap, at most one for each CPU of `cpuPercent`, at least one. */
export const gradleWorkers = (memoryMaxGiB: number, cpuPercent?: number): number =>
  Math.max(1, Math.min(Math.floor(memoryMaxGiB * (1 - JVM_HEAP_SHARE)), cpuPercent !== undefined ? Math.floor(cpuPercent / 100) : Infinity));

/** GRADLE_OPTS and MAVEN_OPTS before the payload's own: sized from the job's limits with a memory limit, else the fixed defaults. */
function jvmDefaults(limits?: JobLimits): { gradle: string; maven: string } {
  if (limits?.memoryMaxGiB === undefined) return { gradle: GRADLE_BUILD_DEFAULTS, maven: MAVEN_BUILD_DEFAULTS };
  const heap = `${Math.floor(limits.memoryMaxGiB * 1024 * JVM_HEAP_SHARE)}m`;
  return { gradle: gradleDefaults(heap, gradleWorkers(limits.memoryMaxGiB, limits.cpuPercent)), maven: `-Xmx${heap}` };
}
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
 * GRADLE_OPTS and MAVEN_OPTS: the build defaults, sized from `limits` (issue #2737), then the payload's own (`env`); Gradle's idle timeout last, which wins.
 * With a memory limit (`limits`), NODE_OPTIONS: the payload's own, then the job's heap, unless the payload set one.
 */
export function buildDefaultsEnv(env: Readonly<Record<string, string>> = {}, limits?: JobLimits): Record<string, string> {
  const jvm = jvmDefaults(limits);
  return {
    GRADLE_OPTS: joined(jvm.gradle, env.GRADLE_OPTS, GRADLE_IDLE_OPT),
    MAVEN_OPTS: joined(jvm.maven, env.MAVEN_OPTS),
    ...(limits?.memoryMaxGiB !== undefined ? {
      NODE_OPTIONS: HEAP_FLAG.test(env.NODE_OPTIONS ?? '') ? env.NODE_OPTIONS! : joined(env.NODE_OPTIONS, `--max-old-space-size=${nodeHeapMiB(limits.memoryMaxGiB)}`),
    } : {}),
  };
}
