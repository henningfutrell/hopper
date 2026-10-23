// Heavy steps (issue #2622 part 3, design.md "The heavy-step gate"): lanes were admitted while their agents were light,
// then four of them started a JVM build within two minutes and took the VM's memory. A heavy step is a command that takes
// gigabytes for minutes: a JVM build, a package install, a Playwright browser install or test run, an image build. A job
// runs it through `sh "$HOPPER_HEAVY"`, which asks the hopper first (src/decider/heavy-steps.ts decides). The job's PATH
// has a shim for each command here (written by the guards step, src/client/job-runtime.ts), so a job that runs `npm
// install` asks too; `./gradlew` is a path, not a name on PATH, and the job rules tell the job to run it through the gate.

export type HeavyKind = 'build' | 'install' | 'browser' | 'image';

/** What each kind of heavy step keeps, at most, in GiB: a JVM build under the build defaults (a 2 GiB heap, metaspace, 2 workers). */
export const HEAVY_STEP_GIB: Readonly<Record<HeavyKind, number>> = { build: 3, install: 1, browser: 2, image: 2 };
/** A JVM build at its worst, as measured with a project's own heap settings: how many a host's memory holds at once. */
export const BUILD_WORST_GIB = 5;

const GIB = 1024 ** 3;
/** Demand from history (part 4): the recent jobs of a repository whose peaks a step's need reads, and how far back. */
export const HEAVY_HISTORY_JOBS = 10;
export const HEAVY_HISTORY_DAYS = 30;

/**
 * What a heavy step of `kind` needs (part 4): the most of `peaks`, the memory its repository's recent jobs took at their
 * peak (`job.resources_used`), so a 3 GiB history reserves 3 GiB; with no peak recorded, the estimate of its kind.
 */
export function heavyNeedOf(kind: HeavyKind, peaks: readonly number[]): { bytes: number; recorded: boolean } {
  const peak = Math.max(0, ...peaks);
  return peak > 0 ? { bytes: peak, recorded: true } : { bytes: HEAVY_STEP_GIB[kind] * GIB, recorded: false };
}

/** What the job's client is told while it waits, and how often it asks again. */
export const HEAVY_RETRY_S = 5;

/**
 * Part 7: a heavy step as the Machines page shows it: the job, its machine, kind and command, since when, the memory it keeps
 * (`recorded`: its repository's peak) and since when it is paused; or `waiting`, since its first ask. `reason`: why it is
 * paused or waits.
 */
export interface HeavyStepView {
  jobId: string; machineId: string; kind: HeavyKind; command: string; since: string;
  bytes?: number; recorded?: boolean; paused?: string; waiting?: true; reason?: string;
}

const JVM_BUILDS = ['gradle', 'gradlew', 'mvn', 'mvnw'];
const INSTALLERS = ['npm', 'pnpm', 'yarn'];
const INSTALL_WORDS = ['install', 'i', 'ci', 'add', 'install-test', 'it'];
const BROWSER_WORDS = ['install', 'test'];
const VERSION_FLAGS = ['--version', '-v', '-version', '--help', '-h', '-?'];
const IMAGE_BUILDERS = ['podman', 'docker'];

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The kind of heavy step `argv` is, the command first; undefined: none. */
export function heavyKindOf(argv: readonly string[]): HeavyKind | undefined {
  const [cmd, ...args] = argv;
  if (cmd === undefined) return undefined;
  const name = nameOf(cmd);
  const words = args.filter((a) => !a.startsWith('-'));
  if (JVM_BUILDS.includes(name)) return args.length && args.every((a) => VERSION_FLAGS.includes(a)) ? undefined : 'build';
  if (INSTALLERS.includes(name)) return INSTALL_WORDS.includes(words[0] ?? (name === 'yarn' ? 'install' : '')) ? 'install' : undefined;
  if (name === 'playwright') return BROWSER_WORDS.includes(words[0] ?? '') ? 'browser' : undefined;
  if (name === 'npx') return words[0] === 'playwright' && BROWSER_WORDS.includes(words[1] ?? '') ? 'browser' : undefined;
  if (IMAGE_BUILDERS.includes(name)) return words[0] === 'build' || words[0] === 'buildx' || (words[0] === 'image' && words[1] === 'build') ? 'image' : undefined;
  return undefined;
}

/** How a command reads in a wait reason: its name and the words that made it heavy. */
export const heavyCommandText = (argv: readonly string[]): string =>
  [nameOf(argv[0] ?? ''), ...argv.slice(1).filter((a) => !a.startsWith('-')).slice(0, 2)].join(' ');

/**
 * The shims the job's PATH gets, as groups of names: each asks the gate always, when its first word is one of `first` (no
 * word: it asks too), or when `anywhere` is one of its words. The gate's own classification decides; a shim only spares a
 * light call the round trip. podman and docker are the guards' (job-runtime.ts), which ask for `build`.
 */
export function heavyShimCases(): { names: string[]; first?: string[]; anywhere?: string }[] {
  return [{ names: JVM_BUILDS }, { names: INSTALLERS, first: INSTALL_WORDS }, { names: ['playwright'], first: BROWSER_WORDS }, { names: ['npx'], anywhere: 'playwright' }];
}

/**
 * The shim, one line after its `#!/bin/sh`, named for its command: the real command of that name further on PATH, run
 * through `sh "$HOPPER_HEAVY"` when its words may make it heavy, else as it is. Inside a heavy step (HOPPER_HEAVY_HELD),
 * or with no gate (HOPPER_HEAVY unset), always as it is. Short: it goes on the guards step's terminal line.
 */
export function heavyShim(): string {
  const arms = heavyShimCases().map((c) => `${c.names.join('|')}) ${c.first ? `case \${1:-${c.first[0]}} in ${c.first.join('|')}) g=1;; esac`
    : c.anywhere ? `case " $* " in *" ${c.anywhere} "*) g=1;; esac` : 'g=1'};;`);
  return [
    'n=${0##*/}; r=; o=$IFS; IFS=:; for p in $PATH; do [ -x "$p/$n" ] && ! [ "$p/$n" -ef "$0" ] && { r=$p/$n; break; }; done; IFS=$o;',
    '[ -n "$r" ] || { echo "hopper: $n: not found" >&2; exit 127; };',
    `g=; case $n in ${arms.join(' ')} esac;`,
    '[ -n "$g" ] && [ -z "$HOPPER_HEAVY_HELD" ] && [ -r "$HOPPER_HEAVY" ] && exec sh "$HOPPER_HEAVY" "$r" "$@";',
    'exec "$r" "$@"',
  ].join(' ');
}

/** The shims for the guards step: the script and the names it is written as. */
export const HEAVY_SHIMS = { shim: heavyShim(), names: heavyShimCases().flatMap((c) => c.names) };
