// The read-only check (issue #716, item 4; design.md "The read-only check"): a template a job asked for with read needs
// only is checked before its first box. The hopper runs a set of probes in a box of the template — the template's image,
// its tools, the sandbox flags — and each write must be refused, each read must work. The template takes no box and no
// job until the check of its current version passed. The probes are a catalog (src/sandbox/probes.ts), so issue #715 can
// add to it or replace it.
import type { AssetKind, OperationProfile } from './access.ts';
import type { BoxTool } from './sandboxes.ts';

/** What a probe expects: the write is refused (`denied`), or the read works (`allowed`). */
export type ProbeExpect = 'denied' | 'allowed';

/**
 * One probe: a shell snippet that a box of the template runs, for each need on an asset of one of its kinds. `$ASSET` is
 * the asset's name and `$HOPPER_TOOLS` the directory of the tools the hopper added (the real binaries, past any wrapper
 * on PATH). A `denied` probe passes when the snippet fails and its output says the write was refused (`denial`); an
 * `allowed` probe passes when it exits 0. `cleanup` runs only when a `denied` probe's write went through.
 */
export interface Probe {
  id: string;
  /** What it tries, in words. */
  title: string;
  kinds: readonly AssetKind[];
  /** The tool it runs: a template that does not add it is still probed, and the probe fails (the tool is not there). */
  tool: BoxTool;
  expect: ProbeExpect;
  script: string;
  /** The words of a refusal; absent: the catalog's default. */
  denial?: RegExp;
  cleanup?: string;
}

/** A probe for one asset: what the check runs. */
export interface ProbeRun { probe: Probe; asset: string }

/** The probes for a template's needs. The default is the hopper's catalog; issue #715 passes its own. */
export interface ProbeCatalog { runsFor(needs: readonly OperationProfile[]): ProbeRun[] }

/** What a probe did: `allowed` (exit 0), `denied` (failed with a refusal), `error` (failed some other way, or did not run). */
export type ProbeOutcome = 'allowed' | 'denied' | 'error';

export interface ProbeResult {
  id: string;
  asset: string;
  expect: ProbeExpect;
  outcome: ProbeOutcome;
  passed: boolean;
  /** Its exit code; absent: it did not run. */
  exit?: number;
  /** The end of what it wrote, at most PROBE_OUTPUT_MAX characters. */
  output: string;
}

/** How much of a probe's output the check keeps. */
export const PROBE_OUTPUT_MAX = 500;

/** The state of a check: `running` while its box runs, then `passed` or `failed`. */
export type CheckState = 'running' | 'passed' | 'failed';

/** The check of one version of a template (its `savedAt`): kept on the template. */
export interface ReadOnlyCheck {
  version: string;
  state: CheckState;
  /** When it started (`running`) or ended. */
  at: string;
  probes: ProbeResult[];
  /** Why it failed with no probe result, or as well: the box did not start, it ran out of time. */
  problem?: string;
}

/** Whether a template must pass a read-only check: one a job asked for with read needs only. */
export interface CheckedTemplate { name: string; savedAt: string; readOnly?: boolean; check?: ReadOnlyCheck }

/** The check of the template's current version; undefined when there is none. */
export const currentCheck = (t: CheckedTemplate): ReadOnlyCheck | undefined => (t.check?.version === t.savedAt ? t.check : undefined);

/** The probes that failed, in words: `<id> on <asset>`. */
export const failedProbes = (c: ReadOnlyCheck): string[] => c.probes.filter((p) => !p.passed).map((p) => `${p.id} on ${p.asset} (${p.outcome})`);

/** Why a box of the template waits for its read-only check; undefined when it needs none or its current version passed. */
export function checkWait(t: CheckedTemplate): string | undefined {
  if (!t.readOnly) return undefined;
  const c = currentCheck(t);
  if (c?.state === 'passed') return undefined;
  const wait = `waiting for the read-only check of ${t.name}`;
  if (!c) return `${wait}: it has not run on this version yet`;
  if (c.state === 'running') return `${wait}: it runs now`;
  const failed = [...failedProbes(c), ...(c.problem ? [c.problem] : [])];
  return `${wait}: it failed (${failed.join('; ')}). A person runs it again in Settings → Vault, or with hopper template check ${t.name}`;
}
