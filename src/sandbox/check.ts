// The read-only check's runs (issue #716, item 4; design.md "The read-only check"). A template that needs a check (a job
// asked for it with read needs only), approved, with no check of its current version, gets one: the hopper runs the
// probes for its needs in a check box — the template's image with its tools, under the sandbox flags, its probe script
// in place of the entrypoint — and keeps the result on the template. A check box carries its own
// label, not the box label: the reconcile pass leaves it, and this pass removes one no run holds (a hopper stopped
// mid-check). Issue #797: before the box starts, once its image is ready (issue #2112), the vault mints the read credential each read need takes, under Access
// (`CheckTemplates.credential`); the box gets them in its environment, so its reads work and a write is refused by the
// account or the cluster. A need it gets none for fails the check: issue #873, its probes are not run, each with the
// reason, and the probes of the other needs still run.
// Issue #715: a passed check runs again once a day (`CHECK_EVERY_MS`), since an account or a cluster can change under a
// template. While it runs the template keeps the check that passed; a check that fails replaces it and blocks the template.
// Issue #715, part 2: a terraform workspace's probes run with the AWS read session of the template's aws-role read need.
// Issue #708: a check runs beside the hopper when it is given a runtime, else on a client target of the template's user,
// dialled in with a runtime there (`CheckPassContext.place`). With neither, the template waits for its check.
// Issue #715, part 4: each ended check's report is an artifact of the job that asked for the template (check-report.ts).
// Issue #1468: a check that failed only on a network error (a mint's ECONNRESET, a timeout) is transient: it runs again
// after `CHECK_RETRY_MS`, with no person. Any other failure still waits for one.
// Issue #1736: a check that failed only on probes the catalog passes now (helm list refused on secrets, on a view role)
// runs again at the next pass, with no person (`judgedAgain`).
// Issue #1779: a failed check keeps the read needs the vault minted nothing for (`unminted`), not on a network error.
// Issue #2226: a check that does not end in `CHECK_DEADLINE_MS` (a pull, a build or a mint that hangs) fails as transient,
// saying the step it stopped at, and the pass goes on: one check that hangs never holds every later check. A check a
// stopped hopper left `running` runs again, after the templates with no check.
// Issue #2236: up to `CHECKS_AT_ONCE` checks run at once, and each pass starts the due ones that do not run yet: a check
// that does not end holds its own template, not every template after it. A due check that cannot start (no place, or as
// many checks run) is held with the reason (`CheckTemplates.held`), which its template's wait says (`checkWait`).
// Issue #2146, part 5: an observe changes no asset, so a template of read and observe needs takes the check too. The vault
// mints each observe for the check box as it mints a read, and the probes under it (exec and a Secret read refused) run
// with that credential: a read and an observe on one asset each have their own.
import type { OperationProfile } from '../domain/access.ts';
import type { Minted, MintReach } from '../domain/minting.ts';
import type { CheckCredential, ProbeCatalog, ProbeRun, ReadOnlyCheck, Unminted } from '../domain/read-only-check.ts';
import { CHECK_UNMINTED_MS, checkedNeeds, currentCheck, markRuns, onlyNetworkErrors, unmintedNeeds, workspaceRole } from '../domain/read-only-check.ts';
import type { ContainerRuntime } from '../domain/sandboxes.ts';
import { imageApproved, type Template } from '../domain/vault.ts';
import { keepReport, type ReportUser } from './check-report.ts';
import { checkEnv, checkScript, judge, readResults } from './check-script.ts';
import { boxImage } from './box-image.ts';
import type { Egress } from './egress.ts';
import { CHECK_LABEL, staleHome, sweepHomes, USER_LABEL } from './owned.ts';
import { boxLimits } from './params.ts';

export { CHECK_LABEL };

/** How long a check box may run. */
export const CHECK_MS = 30 * 60_000;
/** How long a whole check may take, its image and its mints with its box (issue #2226): then it fails, and the pass goes on. */
export const CHECK_DEADLINE_MS = CHECK_MS + 15 * 60_000;
/** How many read-only checks run at once (issue #2236): a check that does not end holds its own template only. */
export const CHECKS_AT_ONCE = 3;
/** Why a due check does not start when no place can run it (issue #708). */
export const NO_CHECK_PLACE = 'no container runtime can run it now: none beside the hopper, and no machine of the user is dialled in with one';
/** How often a passed check runs again (issue #715). */
export const CHECK_EVERY_MS = 24 * 60 * 60_000;
/** How soon a check that failed only on a network error runs again (issue #1468). */
export const CHECK_RETRY_MS = 5 * 60_000;
export { CHECK_UNMINTED_MS };

/** The templates the check pass reads, of every user, and where it keeps a check. */
export interface CheckTemplates {
  templates(): { userId: string; template: Template }[];
  /** Keeps the check on the user's template, when the template is still at the check's version. */
  record(userId: string, name: string, check: ReadOnlyCheck): Promise<void>;
  /** The read credential the check box `check` gets for one read need of the template (issue #797): minted after Access, or why not. */
  credential(userId: string, template: string, check: string, profile: OperationProfile): Promise<{ minted: Minted; reach: MintReach } | { refused: string }>;
  /** The check box `check` ended (issue #1371): each token minted for it stops working. Never rejects. */
  release?(userId: string, check: string): Promise<void>;
  /** Keeps an ended check's report as an artifact (issue #715): its id; undefined when no job asked for the template. */
  report(userId: string, t: Template, check: ReadOnlyCheck): Promise<string | undefined>;
  /** Why the user's template's due check does not start now (issue #2236), or undefined once it starts: kept in memory. */
  held?(userId: string, name: string, why: string | undefined): void;
}

export interface CheckContext {
  runtime: ContainerRuntime;
  /** Where the check box's read credentials come from (issue #797). */
  credentials: Pick<CheckTemplates, 'credential'>;
  instanceId: string;
  network: string;
  /** Beside the hopper with its egress set (issue #849): the check box joins its internal network, behind its proxy. */
  egress?: Egress;
  probes: ProbeCatalog;
  clock: { now(): Date };
  logger: { info(line: string): void; warn(line: string): void };
  /** Told each step the check comes to, in words (issue #2226): a check that does not end says where it stopped. */
  stepped?(what: string): void;
}

/** Where a check runs: the machine, its runtime, the network a check box joins there, and its egress (issue #849). */
export interface CheckPlace { machine: string; runtime: ContainerRuntime; network: string; egress?: Egress }

/** What the check pass needs: a check's context but its runtime, which `place` gives for each check. */
export interface CheckPassContext extends Omit<CheckContext, 'runtime' | 'network' | 'egress'> {
  /** The runtime beside the hopper, swept at each pass; undefined: none is given. */
  local?: ContainerRuntime;
  /** Where a check of the user's template runs now; undefined: nowhere, and the template waits. */
  place(userId: string): Promise<CheckPlace | undefined>;
  /** How long a whole check may take (issue #2226); `CHECK_DEADLINE_MS` when absent. */
  checkMs?: number;
}

/**
 * Whether the template gets a check now: it needs one, its image is approved, and its version has none — or one still
 * `running`, which the pass does not run itself only when a hopper stopped mid-check —, or one that
 * passed `CHECK_EVERY_MS` ago or more (issue #715), or one that failed only on a network error `CHECK_RETRY_MS` ago or
 * more (issue #1468), or one that failed as the vault minted nothing for a need `CHECK_UNMINTED_MS` ago or more (issue
 * #1845). Any other failed check waits for a person.
 */
export function dueForCheck(t: Template, now: Date): boolean {
  if (t.readOnly !== true || !imageApproved(t)) return false;
  const c = currentCheck(t);
  if (c?.state === 'passed') return now.getTime() - Date.parse(c.at) >= CHECK_EVERY_MS;
  if (c?.state === 'failed' && c.transient) return now.getTime() - Date.parse(c.at) >= CHECK_RETRY_MS;
  // Issue #1845: what the vault can mint changes outside the hopper too (a cluster made, a trust policy fixed).
  if (unmintedNeeds(t).length > 0) return now.getTime() - Date.parse(c!.at) >= CHECK_UNMINTED_MS;
  return c?.state !== 'failed';
}

/**
 * Whether a failed check of the template's current version failed only on probes the catalog passes now, from what each
 * did (issue #1736: one judged before a right credential's refusal passed a read). It runs again then, with no person.
 * A check with a problem, a probe that did not run, or a failed probe the catalog no longer has, does not.
 */
export function judgedAgain(t: Template, probes: ProbeCatalog): boolean {
  const c = currentCheck(t);
  if (t.readOnly !== true || !imageApproved(t) || c?.state !== 'failed' || c.problem !== undefined || c.probes.length === 0) return false;
  const runs = markRuns(probes.runsFor(checkedNeeds(t.profiles)), t.probeMarks);
  return c.probes.filter((p) => !p.passed).every((p) => {
    const run = runs.find((r) => r.probe.id === p.id && r.asset === p.asset && r.operation === p.operation);
    return run !== undefined && p.exit !== undefined && judge(run, p.exit, p.output).passed;
  });
}

/** A minted credential as the check box takes it: the AWS CLI's variables, or a kubeconfig of the cluster with the token. */
export function checkCredentialOf(profile: OperationProfile, minted: Minted, reach: MintReach): CheckCredential {
  if (minted.kind === 'aws' && reach.kind === 'aws') {
    return {
      asset: profile.asset, ...observeOf(profile),
      env: {
        AWS_ACCESS_KEY_ID: minted.AccessKeyId, AWS_SECRET_ACCESS_KEY: minted.SecretAccessKey, AWS_SESSION_TOKEN: minted.SessionToken,
        AWS_REGION: reach.region, AWS_DEFAULT_REGION: reach.region, ...(reach.stsEndpoint ? { AWS_ENDPOINT_URL_STS: reach.stsEndpoint } : {}),
      },
    };
  }
  if (minted.kind === 'kube' && reach.kind === 'kube') {
    const cluster = { server: reach.server, ...(reach.certificateAuthorityData ? { 'certificate-authority-data': reach.certificateAuthorityData } : {}) };
    const kubeconfig = {
      apiVersion: 'v1', kind: 'Config', 'current-context': 'hopper-check',
      clusters: [{ name: 'hopper-check', cluster }], users: [{ name: 'hopper-check', user: { token: minted.token } }],
      contexts: [{ name: 'hopper-check', context: { cluster: 'hopper-check', user: 'hopper-check' } }],
    };
    return { asset: profile.asset, ...observeOf(profile), env: {}, kubeconfig: JSON.stringify(kubeconfig) };
  }
  throw new Error(`a ${minted.kind} credential minted with a ${reach.kind} reach`);
}

/** An observe need's mark on what is made for it (issue #2146, part 5); a read's is none. */
const observeOf = (p: OperationProfile): { operation?: 'observe' } => (p.operation === 'observe' ? { operation: 'observe' } : {});

/** A need, as a key: its operation and its asset. A probe run for it has the same (`runKey`). */
const needKey = (n: OperationProfile): string => `${n.operation}\0${n.asset.kind}\0${n.asset.name}`;
const runKey = (r: ProbeRun): string => `${r.operation ?? 'read'}\0${r.kind}\0${r.asset}`;

/** What the check box is given: the credential of each need that has one, and why each other need has none (issue #873). */
interface Given {
  credentials: CheckCredential[];
  /** The reach of each credential minted, for the egress proxy (issue #849). */
  reaches: MintReach[];
  /** Why the check box gets no credential for a need, by the need (`needKey`). */
  missing: Map<string, string>;
  /** Whether each refusal was a network error only (issue #1468), so the check runs again with no person. */
  transient: boolean;
  /** The needs the vault refused to mint for, not on a network error (issue #1779). */
  unminted: Unminted[];
}

/**
 * The read credential of each read need, minted for the check box `name`; the reason for each need that gets none. A
 * terraform workspace is minted nothing of its own (issue #715): it takes the AWS read session of the template's one
 * aws-role read need (`workspaceRole`), which Access allowed and the deny policy keeps read-only, state backend included.
 */
async function credentialsFor(c: CheckContext, userId: string, t: Template, name: string, needs: readonly OperationProfile[]): Promise<Given> {
  const credentials: CheckCredential[] = [];
  const reaches: MintReach[] = [];
  const missing = new Map<string, string>();
  const refusals: string[] = [];
  const unminted: Unminted[] = [];
  let other = false;
  const noCredential = (need: OperationProfile, why: string): void => { missing.set(needKey(need), `not run: the check box gets no credential for ${need.operation} on ${need.asset.kind} ${need.asset.name}: ${why}`); };
  for (const need of needs.filter((n) => n.asset.kind !== 'terraform-workspace')) {
    const r = await c.credentials.credential(userId, t.name, name, need);
    if ('refused' in r) {
      noCredential(need, r.refused);
      refusals.push(r.refused);
      if (!onlyNetworkErrors([r.refused])) unminted.push({ asset: need.asset, reason: r.refused });
    }
    else { credentials.push(checkCredentialOf(need, r.minted, r.reach)); reaches.push(r.reach); }
  }
  for (const workspace of needs.filter((n) => n.asset.kind === 'terraform-workspace')) {
    const role = workspaceRole(needs);
    if (typeof role === 'string') { noCredential(workspace, role); other = true; continue; }
    const session = credentials.find((x) => x.asset.kind === role.asset.kind && x.asset.name === role.asset.name && !x.operation);
    if (session) credentials.push({ ...session, asset: workspace.asset });
    else noCredential(workspace, `the aws-role ${role.asset.name} it is read with gets none`);
  }
  return { credentials, reaches, missing, transient: !other && onlyNetworkErrors(refusals), unminted };
}

/**
 * One check of the template's current version, in a check box on a fresh home (issue #1371); the box and its volume are
 * removed after it.
 */
export async function runCheck(c: CheckContext, userId: string, t: Template, name: string): Promise<ReadOnlyCheck> {
  // Issue #2146, part 5: an observe need is checked as a read is, with its own credential and the probes under observe.
  const needs = checkedNeeds(t.profiles);
  // A person's marks on its read probes (issue #916): an expected refusal, or a probe not run.
  const runs = markRuns(c.probes.runsFor(needs), t.probeMarks);
  let unminted: Unminted[] = [];
  const ended = (state: 'passed' | 'failed', probes: ReadOnlyCheck['probes'], problem?: string, transient?: boolean): ReadOnlyCheck =>
    ({ version: t.savedAt, state, at: c.clock.now().toISOString(), probes, ...(problem ? { problem } : {}), ...(transient ? { transient: true as const } : {}),
      ...(state === 'failed' && unminted.length > 0 ? { unminted } : {}) });
  if (runs.length === 0) return ended('failed', [], 'no probe checks its needs: it cannot pass');
  // Issue #2112: the image first, then the mints. An EKS token works for 15 minutes from its signing, and a pull or a build
  // of the tools image can take longer: a token minted before it reached the cluster too late, and every probe failed.
  let boxed: { image: string; user: string } | undefined;
  if (runs.some((r) => r.notRun === undefined && r.mark !== 'skip')) {
    try {
      c.stepped?.('pulling or building the box image');
      boxed = await boxImage(c.runtime, t.image, t.tools, t.readOnly);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return ended('failed', [], `the check box did not run: ${why}`, onlyNetworkErrors([why]));
    }
  }
  c.stepped?.('minting the read credentials');
  const given = await credentialsFor(c, userId, t, name, needs);
  ({ unminted } = given);
  // Issue #873: a probe of a need with no credential is not run, and says why; the probes of the other needs still run.
  // The missing credential is its reason even when the probe lacks something else too (a state backend): it is the first fix.
  const checked = runs.map((r) => (given.missing.has(runKey(r)) ? { ...r, notRun: given.missing.get(runKey(r))! } : r));
  // A need with no credential that no probe covers fails the check too, with its reason.
  const uncovered = [...given.missing].filter(([key]) => !checked.some((r) => runKey(r) === key)).map(([, why]) => why);
  const problem = uncovered.length > 0 ? uncovered.join('; ') : undefined;
  // Transient only when the probes that failed are those a network error left with no credential.
  const transientOf = (probes: ReadOnlyCheck['probes']): boolean =>
    given.missing.size > 0 && given.transient && probes.every((p, n) => p.passed || given.missing.get(runKey(checked[n]!)) === checked[n]!.notRun);
  if (!boxed || checked.every((r) => r.notRun !== undefined || r.mark === 'skip')) {
    // No probe to run: no check box.
    const probes = readResults(checked, '');
    const passed = given.missing.size === 0 && probes.every((p) => p.passed);
    return ended(passed ? 'passed' : 'failed', probes, problem, !passed && transientOf(probes));
  }
  const labels = { [CHECK_LABEL]: c.instanceId, [USER_LABEL]: userId };
  const volume = `${name}-home`;
  let id = '';
  let madeHome = false;
  try {
    const { image, user } = boxed;
    c.stepped?.('starting the check box');
    if (!(await c.runtime.createVolume(volume, labels))) throw staleHome(volume);
    madeHome = true;
    // Issue #849: behind the egress proxy, which holds the hosts of its credentials before the box starts.
    if (c.egress) await c.egress.allow(given.reaches);
    const env = { ...checkEnv(given.credentials), ...(c.egress ? c.egress.env : {}) };
    id = await c.runtime.create({ name, image, network: c.egress?.network ?? c.network, volume, labels, user, env, limits: boxLimits(t.limits), script: checkScript(checked, given.credentials) });
    await c.runtime.start(id);
    c.stepped?.('running the probes');
    const exit = await c.runtime.wait(id, CHECK_MS);
    c.stepped?.('reading the probe results');
    const probes = readResults(checked, await c.runtime.logs(id));
    // Every probe passed, each need had its credential and the script ended well, or it failed: a script cut short is no pass.
    const passed = exit === 0 && given.missing.size === 0 && probes.every((p) => p.passed);
    const problems = [...(exit !== 0 ? [`the check box ended with ${exit}`] : []), ...(problem ? [problem] : [])];
    return ended(passed ? 'passed' : 'failed', probes, problems.length > 0 ? problems.join('; ') : undefined, !passed && exit === 0 && transientOf(probes));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return ended('failed', [], `the check box did not run: ${why}`, onlyNetworkErrors([why]));
  } finally {
    if (id) await c.runtime.remove(id).catch(() => {});
    if (madeHome) await c.runtime.removeVolume(volume).catch(() => {});
  }
}

/**
 * The check pass: removes check boxes and their homes no run holds, then starts the check of each template that is due
 * and not checked now, up to `CHECKS_AT_ONCE` at once (issue #2236), and ends when every check that runs now has. A
 * client target's check boxes no run holds are removed before the first check of a pass there.
 */
export function createCheckPass(c: CheckPassContext, templates: CheckTemplates): () => Promise<void> {
  const holds = new Set<string>();
  let n = 0;
  const sweep = async (runtime: ContainerRuntime): Promise<void> => {
    for (const box of await runtime.list({ [CHECK_LABEL]: c.instanceId })) {
      if (holds.has(box.name)) continue;
      await runtime.remove(box.id).catch(() => {});
      await runtime.removeVolume(`${box.name}-home`).catch(() => {});
    }
    await sweepHomes(runtime, { [CHECK_LABEL]: c.instanceId }, holds);
  };
  const limit = c.checkMs ?? CHECK_DEADLINE_MS;
  /** One check of the user's template at its place, recorded when it ends, or when its time is up (issue #2226). */
  const checkOne = async (userId: string, t: Template, at: CheckPlace): Promise<void> => {
    const name = `hopper-check-${t.name}-${Date.now().toString(36)}${(n++).toString(36)}`;
    holds.add(name);
    let late: Promise<unknown> | undefined;
    try {
      // A scheduled check (issue #715) leaves the passed one in place while it runs: the template's boxes go on.
      if (currentCheck(t)?.state !== 'passed') await templates.record(userId, t.name, { version: t.savedAt, state: 'running', at: c.clock.now().toISOString(), probes: [] });
      let step = 'starting';
      const checking = runCheck({ ...c, runtime: at.runtime, network: at.network, ...(at.egress ? { egress: at.egress } : {}), stepped: (what) => { step = what; } }, userId, t, name);
      let timer: NodeJS.Timeout | undefined;
      const overdue = new Promise<ReadOnlyCheck>((resolve) => {
        timer = setTimeout(() => { late = checking.catch(() => {}); resolve({
          version: t.savedAt, state: 'failed', at: c.clock.now().toISOString(), probes: [], transient: true,
          problem: `the check did not end in ${Math.round(limit / 60_000)} min: it stopped at ${step}`,
        }); }, limit);
        timer.unref();
      });
      const check = await Promise.race([checking, overdue]).finally(() => clearTimeout(timer));
      // A check that did not end is left behind: its box, if it ever starts, is no run's, and the next pass removes it.
      if (late) c.logger.warn(`hopper: the read-only check of template ${t.name} ${check.problem}; it runs again in ${CHECK_RETRY_MS / 60_000} min`);
      // A report that cannot be kept never changes the check: it is kept with no artifact, and the log says why.
      const artifact = await templates.report(userId, t, check).catch((e: unknown) => {
        c.logger.warn(`hopper: the read-only check of template ${t.name} ${check.state}, but its report was not kept: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      });
      await templates.record(userId, t.name, artifact ? { ...check, artifact } : check);
      c.logger.info(`hopper: the read-only check of template ${t.name} ${check.state}${at.runtime === c.local ? '' : ` on ${at.machine}`}`);
    } finally {
      // The check box is removed by now, or never started: its credentials end with it (issue #1371). A check that did not
      // end (issue #2226) releases them now, and again when its run ends, as it may mint after this.
      await templates.release?.(userId, name).catch(() => {});
      void late?.then(() => templates.release?.(userId, name)).catch(() => {});
      holds.delete(name);
    }
  };
  // Issue #2236: the checks that run now, by user and template, across passes. A pass starts the due ones not here.
  const checking = new Map<string, Promise<void>>();
  return async () => {
    if (c.local) await sweep(c.local);
    const swept = new Set<string>();
    const due = templates.templates().filter(({ template: t }) => dueForCheck(t, c.clock.now()) || judgedAgain(t, c.probes));
    // Issue #2226: a check a stopped hopper left `running` goes last, so a check that hangs again holds no template with none.
    const left = (t: Template): boolean => currentCheck(t)?.state === 'running';
    for (const { userId, template: t } of [...due.filter((x) => !left(x.template)), ...due.filter((x) => left(x.template))]) {
      const one = `${userId}\0${t.name}`;
      if (checking.has(one)) continue;
      if (checking.size >= CHECKS_AT_ONCE) {
        templates.held?.(userId, t.name, `${checking.size} other read-only checks run now, and it starts when one of them ends`);
        continue;
      }
      const at = await c.place(userId);
      if (!at) {
        templates.held?.(userId, t.name, NO_CHECK_PLACE);
        continue;
      }
      templates.held?.(userId, t.name, undefined);
      const key = `${userId}\0${at.machine}`;
      if (at.runtime !== c.local && !swept.has(key)) {
        swept.add(key);
        await sweep(at.runtime).catch(() => {});
      }
      checking.set(one, checkOne(userId, t, at).finally(() => { checking.delete(one); }));
    }
    // The pass ends when every check that runs now has: a tick does not wait for it (src/sandbox/service.ts).
    const ended = await Promise.allSettled([...checking.values()]);
    const failed = ended.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
  };
}

/** What the check pass reads of a user's vault: its templates, where a check is kept, the check box's mints, and where its report goes. */
interface UserVault {
  user: { id: string };
  store: { vault: { templates(): Template[] }; jobs: ReportUser['jobs'] };
  artifacts: ReportUser['artifacts'];
  vault: {
    recordCheck(name: string, check: ReadOnlyCheck): boolean;
    mintForCheck(ask: { template: string; check: string; profile: OperationProfile }): Promise<{ minted: Minted; reach: MintReach } | { refused: string }>;
    releaseMints(box: string): Promise<void>;
    holdCheck(name: string, why: string | undefined): void;
  };
}

/** The check pass's templates over the users' runtimes: each one's own templates, read and kept in their own vault, minted for by it. */
export const usersTemplates = (all: () => readonly UserVault[]): CheckTemplates => ({
  templates: () => all().flatMap((rt) => rt.store.vault.templates().map((template) => ({ userId: rt.user.id, template }))),
  record: async (userId, name, check) => { all().find((rt) => rt.user.id === userId)?.vault.recordCheck(name, check); },
  credential: async (userId, template, check, profile) => {
    const rt = all().find((x) => x.user.id === userId);
    return rt ? rt.vault.mintForCheck({ template, check, profile }) : { refused: `no user ${userId}` };
  },
  held: (userId, name, why) => { all().find((x) => x.user.id === userId)?.vault.holdCheck(name, why); },
  release: async (userId, check) => { await all().find((x) => x.user.id === userId)?.vault.releaseMints(check); },
  report: async (userId, t, check) => {
    const rt = all().find((x) => x.user.id === userId);
    return rt ? keepReport({ artifacts: rt.artifacts, jobs: rt.store.jobs }, t, check) : undefined;
  },
});
