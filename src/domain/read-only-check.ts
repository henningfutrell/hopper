// The read-only check (issue #716, item 4; design.md "The read-only check"): a template a job asked for with read needs
// only is checked before its first box. The hopper runs a set of probes in a box of the template — the template's image,
// its tools, the sandbox flags — and each write must be refused, each read must work. The template takes no box and no
// job until the check of its current version passed. The probes are a catalog (src/sandbox/probes.ts), so issue #715 can
// add to it or replace it.
import type { Asset, AssetKind, Operation, OperationProfile } from './access.ts';
import type { BoxTool } from './sandboxes.ts';

/**
 * The operations a check probes (issue #2146, part 5): those that change no asset. A read, and an observe, whose credential
 * may port-forward too and must change nothing either.
 */
export type CheckedOperation = Extract<Operation, 'read' | 'observe'>;
export const CHECKED_OPERATIONS: readonly CheckedOperation[] = ['read', 'observe'];
/** Whether a need is one the check probes: a read or an observe. */
export const checkedNeed = (p: { operation: string }): boolean => (CHECKED_OPERATIONS as readonly string[]).includes(p.operation);
/** A template's needs that the check probes. */
export const checkedNeeds = (profiles: readonly OperationProfile[] | undefined): OperationProfile[] => (profiles ?? []).filter(checkedNeed);

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
  /**
   * It writes to the need's state backend (issue #715): it runs with `$HOPPER_STATE_BUCKET`, `$HOPPER_STATE_REGION` and
   * `$HOPPER_STATE_KEY` (the check's own key), and is not run for a need with no backend.
   */
  backend?: true;
  /** What a person reads when it fails: why it can fail on a credential that is right (issue #869). */
  note?: string;
  /**
   * The words of a refusal a right read credential gives (issue #1736): an `allowed` probe refused with them passes, and
   * its result carries its `note`. `helm.list` on a view role, which cannot read the secrets helm keeps its releases in.
   */
  rightRefusal?: RegExp;
  /** It probes the box, not an asset (issue #849): it runs once per check, for the first need of one of its kinds. */
  once?: true;
  /** The needs' operations it runs under (issue #2146, part 5); absent: a read only. */
  operations?: readonly CheckedOperation[];
}

/**
 * A probe for one asset: what the check runs. `kind` is the asset's kind and `operation` its need's (absent: a read): they
 * pick the credential the probe runs with. `vars`: more of its environment. `notRun`: why it is not run (issue #715); it
 * does not pass then.
 */
export interface ProbeRun { probe: Probe; kind: AssetKind; asset: string; operation?: 'observe'; vars?: Record<string, string>; notRun?: string; mark?: ProbeMark }

/**
 * A person's mark on one read probe of a template (issue #916): `expect-denied`, the read must be refused, as a credential
 * that is right refuses it (`helm.list` on a view role, which cannot read the secrets helm keeps its releases in); `skip`,
 * the check does not run it. A write probe takes no mark: each write must be refused, always.
 */
export type ProbeMark = 'expect-denied' | 'skip';
export const PROBE_MARKS: readonly ProbeMark[] = ['expect-denied', 'skip'];
/** A template's probe marks, by probe id. */
export type ProbeMarks = Record<string, ProbeMark>;
/** At most this many marks on a template. */
export const PROBE_MARKS_MAX = 64;

/** Why these marks cannot be kept on a template, with the probes of `catalog`; undefined when they can. */
export function probeMarksProblem(marks: Readonly<Record<string, string>>, catalog: readonly Pick<Probe, 'id' | 'expect'>[]): string | undefined {
  const ids = Object.keys(marks);
  if (ids.length > PROBE_MARKS_MAX) return `a template holds at most ${PROBE_MARKS_MAX} probe marks`;
  for (const id of ids) {
    const mark = marks[id]!;
    if (!(PROBE_MARKS as readonly string[]).includes(mark)) return `${mark} is no probe mark: ${PROBE_MARKS.join(' or ')}`;
    const probe = catalog.find((p) => p.id === id);
    if (!probe) return `${id} is no probe: mark one of ${catalog.filter((p) => p.expect === 'allowed').map((p) => p.id).join(', ')}`;
    if (probe.expect === 'denied') return `${id} is a write probe: a write must be refused always, so it takes no mark`;
  }
  return undefined;
}

/** The runs with the template's marks: a mark applies to a read probe only, so a mark on a write probe changes nothing. */
export const markRuns = (runs: readonly ProbeRun[], marks: ProbeMarks | undefined): ProbeRun[] =>
  runs.map((r) => {
    const mark = marks?.[r.probe.id];
    return mark && r.probe.expect === 'allowed' && (PROBE_MARKS as readonly string[]).includes(mark) ? { ...r, mark } : r;
  });

/**
 * The read credential a check box gets for one need (issue #797), minted for it: the environment its probes on that asset
 * run with (an AWS session, its region and STS), and a kubeconfig for a cluster or a namespace.
 */
export interface CheckCredential { asset: Asset; operation?: 'observe'; env: Record<string, string>; kubeconfig?: string }

/** The probes for a template's needs. The default is the hopper's catalog; issue #715 passes its own. */
export interface ProbeCatalog { runsFor(needs: readonly OperationProfile[]): ProbeRun[] }

/**
 * What a probe did: `allowed` (exit 0), `denied` (failed with a refusal), `error` (failed some other way, or did not run),
 * `not-run` (the check did not run it, as it lacks what it needs: unproven, never passed; issue #715), `skipped` (a
 * person marked it `skip`: not run, and passed; issue #916).
 */
export type ProbeOutcome = 'allowed' | 'denied' | 'error' | 'not-run' | 'skipped';

export interface ProbeResult {
  id: string;
  asset: string;
  /** It ran under an observe need's credential (issue #2146, part 5); absent: a read's. */
  operation?: 'observe';
  /** What it expected: its probe's, or `denied` when the template marks it `expect-denied`. */
  expect: ProbeExpect;
  /** The template's mark on it (issue #916). */
  mark?: ProbeMark;
  outcome: ProbeOutcome;
  passed: boolean;
  /** Its exit code; absent: it did not run. */
  exit?: number;
  /** The end of what it wrote, at most PROBE_OUTPUT_MAX characters. */
  output: string;
  /** Its probe's `note`, when it did not pass. */
  note?: string;
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
  /** The artifact that holds its report (issue #715): one per template, of the job that asked for it. Absent: none kept. */
  artifact?: string;
  /**
   * It failed only on a network error (issue #1468: a connection reset, a timeout), not on what the account or the
   * cluster answered: the check pass runs it again soon, with no person. Absent: a failure that waits for a person.
   */
  transient?: true;
  /**
   * The read needs the vault minted no credential for (issue #1779), each with the vault's reason: not a network error.
   * Setting the minting credential for one of their accounts or clusters runs the check again; until then a job that asks
   * for the template is told it cannot pass, so it asks for a need that mints. Absent: each need was minted for, or older.
   */
  unminted?: Unminted[];
}

/** A read need the check box got no credential for (issue #1779), and why. */
export interface Unminted { asset: Asset; reason: string }

/** A network error, as a mint's refusal or a check box's start says it (issue #1468): not a standing answer. */
const NETWORK_ERROR = /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|timed out|timeout)\b/i;

/** Whether each of these reasons is a network error only (issue #1468); false for none. */
export const onlyNetworkErrors = (reasons: readonly string[]): boolean => reasons.length > 0 && reasons.every((r) => NETWORK_ERROR.test(r));

/** Whether a template must pass a read-only check: one a job asked for with read and observe needs only (issue #2146). */
export interface CheckedTemplate {
  name: string; savedAt: string; readOnly?: boolean; check?: ReadOnlyCheck;
  /** Why its due check does not start now (issue #2236): kept in the hopper's memory by the check pass, never stored. */
  checkHeld?: string;
}

/** A probe result in words: `<id> on <asset>`, and ` under observe` for an observe need's (issue #2146, part 5). */
export const probeOn = (p: Pick<ProbeResult, 'id' | 'asset' | 'operation'>): string => `${p.id} on ${p.asset}${p.operation ? ` under ${p.operation}` : ''}`;

/** The marked probes of a check, in words: `<id> on <asset> (<mark>)`. */
export const markedProbes = (c: ReadOnlyCheck): string[] => c.probes.filter((p) => p.mark).map((p) => `${probeOn(p)} (${p.mark})`);

/** The check of the template's current version; undefined when there is none. */
export const currentCheck = (t: CheckedTemplate): ReadOnlyCheck | undefined => (t.check?.version === t.savedAt ? t.check : undefined);

/** The reads that passed as refused by a right credential (issue #1736), in words: `<id> on <asset>`. */
export const refusedReads = (c: ReadOnlyCheck): string[] =>
  c.probes.filter((p) => p.passed && p.expect === 'allowed' && p.outcome === 'denied').map(probeOn);

/** The probes that failed, in words: `<id> on <asset>`. */
export const failedProbes = (c: ReadOnlyCheck): string[] => c.probes.filter((p) => !p.passed).map((p) => `${probeOn(p)} (${p.outcome})`);

/** How soon a check that failed as the vault minted nothing for a need runs again by itself (issue #1845). */
export const CHECK_UNMINTED_MS = 60 * 60_000;

/**
 * The needs a failed check of the template's current version got no credential for (issue #1779); empty when it did not
 * fail so, or failed on a network error, which the check pass runs again by itself.
 */
export function unmintedNeeds(t: CheckedTemplate): Unminted[] {
  const c = currentCheck(t);
  return c?.state === 'failed' && !c.transient ? c.unminted ?? [] : [];
}

/** Why a box of the template waits for its read-only check; undefined when it needs none or its current version passed. */
export function checkWait(t: CheckedTemplate): string | undefined {
  if (!t.readOnly) return undefined;
  const c = currentCheck(t);
  if (c?.state === 'passed') return undefined;
  const wait = `waiting for the read-only check of ${t.name}`;
  if (!c) return `${wait}: it has not run on this version yet${t.checkHeld ? `: ${t.checkHeld}` : ''}`;
  if (c.state === 'running') return `${wait}: it runs now, since ${c.at}`;
  const failed = [...failedProbes(c), ...(c.problem ? [c.problem] : [])];
  if (c.transient) return `${wait}: it failed on a network error (${failed.join('; ')}). The hopper runs it again in a few minutes`;
  if (unmintedNeeds(t).length > 0) return `${wait}: it failed (${failed.join('; ')}). The hopper runs it again in an hour, or when a minting credential for its account or cluster is set. A person runs it again in Vault, or with hopper template check ${t.name}`;
  return `${wait}: it failed (${failed.join('; ')}). A person runs it again in Vault, or with hopper template check ${t.name}`;
}

/**
 * The read need whose AWS read session a terraform workspace's probes run with (issue #715): the template's one aws-role
 * read need, as the workspace's provider and its state backend are read with that role. Or why there is none: no such
 * need, or more than one, as the hopper cannot tell which role a workspace uses.
 */
export function workspaceRole(needs: readonly OperationProfile[]): OperationProfile | string {
  const roles = needs.filter((n) => n.operation === 'read' && n.asset.kind === 'aws-role');
  if (roles.length === 1) return roles[0]!;
  const has = "a terraform workspace is read with the AWS read session of the template's aws-role read need, and the template has";
  if (roles.length === 0) return `${has} none: ask for read on the aws-role its provider and state are read with`;
  return `${has} ${roles.length} (${roles.map((r) => r.asset.name).join(', ')}): ask for one`;
}
