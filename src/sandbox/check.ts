// The read-only check's runs (issue #716, item 4; design.md "The read-only check"). A template that needs a check (a job
// asked for it with read needs only), approved, with no check of its current version, gets one: the hopper runs the
// probes for its needs in a check box — the template's image with its tools, under the sandbox flags, its probe script
// in place of the entrypoint — and keeps the result on the template. One check at a time. A check box carries its own
// label, not the box label: the reconcile pass leaves it, and this pass removes one no run holds (a hopper stopped
// mid-check). Issue #797: before the box starts, the vault mints the read credential each read need takes, under Access
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
import type { OperationProfile } from '../domain/access.ts';
import type { Minted, MintReach } from '../domain/minting.ts';
import type { CheckCredential, ProbeCatalog, ProbeRun, ReadOnlyCheck } from '../domain/read-only-check.ts';
import { currentCheck, markRuns, onlyNetworkErrors, workspaceRole } from '../domain/read-only-check.ts';
import type { ContainerRuntime } from '../domain/sandboxes.ts';
import { imageApproved, type Template } from '../domain/vault.ts';
import { keepReport, type ReportUser } from './check-report.ts';
import { checkEnv, checkScript, readResults } from './check-script.ts';
import { boxImage } from './box-image.ts';
import { CHECK_LABEL, staleHome, sweepHomes, USER_LABEL } from './owned.ts';
import { boxLimits } from './params.ts';

export { CHECK_LABEL };

/** How long a whole check may run. */
export const CHECK_MS = 30 * 60_000;
/** How often a passed check runs again (issue #715). */
export const CHECK_EVERY_MS = 24 * 60 * 60_000;
/** How soon a check that failed only on a network error runs again (issue #1468). */
export const CHECK_RETRY_MS = 5 * 60_000;

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
}

export interface CheckContext {
  runtime: ContainerRuntime;
  /** Where the check box's read credentials come from (issue #797). */
  credentials: Pick<CheckTemplates, 'credential'>;
  instanceId: string;
  network: string;
  probes: ProbeCatalog;
  clock: { now(): Date };
  logger: { info(line: string): void; warn(line: string): void };
}

/** Where a check runs: the machine, its runtime, and the network a check box joins there. */
export interface CheckPlace { machine: string; runtime: ContainerRuntime; network: string }

/** What the check pass needs: a check's context but its runtime, which `place` gives for each check. */
export interface CheckPassContext extends Omit<CheckContext, 'runtime' | 'network'> {
  /** The runtime beside the hopper, swept at each pass; undefined: none is given. */
  local?: ContainerRuntime;
  /** Where a check of the user's template runs now; undefined: nowhere, and the template waits. */
  place(userId: string): Promise<CheckPlace | undefined>;
}

/**
 * Whether the template gets a check now: it needs one, its image is approved, and its version has none — or one still
 * `running`, which a pass finds only when a hopper stopped mid-check: passes run one after the other —, or one that
 * passed `CHECK_EVERY_MS` ago or more (issue #715), or one that failed only on a network error `CHECK_RETRY_MS` ago or
 * more (issue #1468). Any other failed check waits for a person.
 */
export function dueForCheck(t: Template, now: Date): boolean {
  if (t.readOnly !== true || !imageApproved(t)) return false;
  const c = currentCheck(t);
  if (c?.state === 'passed') return now.getTime() - Date.parse(c.at) >= CHECK_EVERY_MS;
  if (c?.state === 'failed' && c.transient) return now.getTime() - Date.parse(c.at) >= CHECK_RETRY_MS;
  return c?.state !== 'failed';
}

/** A minted credential as the check box takes it: the AWS CLI's variables, or a kubeconfig of the cluster with the token. */
export function checkCredentialOf(profile: OperationProfile, minted: Minted, reach: MintReach): CheckCredential {
  if (minted.kind === 'aws' && reach.kind === 'aws') {
    return {
      asset: profile.asset,
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
    return { asset: profile.asset, env: {}, kubeconfig: JSON.stringify(kubeconfig) };
  }
  throw new Error(`a ${minted.kind} credential minted with a ${reach.kind} reach`);
}

/** A need's asset, as a key: a probe run on it has the same (`runKey`). */
const assetKey = (a: { kind: string; name: string }): string => `${a.kind}\0${a.name}`;
const runKey = (r: ProbeRun): string => `${r.kind}\0${r.asset}`;

/** What the check box is given: the credential of each need that has one, and why each other need has none (issue #873). */
interface Given {
  credentials: CheckCredential[];
  /** Why the check box gets no credential for a need, by its asset (`assetKey`). */
  missing: Map<string, string>;
  /** Whether each refusal was a network error only (issue #1468), so the check runs again with no person. */
  transient: boolean;
}

/**
 * The read credential of each read need, minted for the check box `name`; the reason for each need that gets none. A
 * terraform workspace is minted nothing of its own (issue #715): it takes the AWS read session of the template's one
 * aws-role read need (`workspaceRole`), which Access allowed and the deny policy keeps read-only, state backend included.
 */
async function credentialsFor(c: CheckContext, userId: string, t: Template, name: string, needs: readonly OperationProfile[]): Promise<Given> {
  const credentials: CheckCredential[] = [];
  const missing = new Map<string, string>();
  const refusals: string[] = [];
  let other = false;
  const noCredential = (need: OperationProfile, why: string): void => { missing.set(assetKey(need.asset), `not run: the check box gets no credential for ${need.operation} on ${need.asset.kind} ${need.asset.name}: ${why}`); };
  for (const need of needs.filter((n) => n.asset.kind !== 'terraform-workspace')) {
    const r = await c.credentials.credential(userId, t.name, name, need);
    if ('refused' in r) { noCredential(need, r.refused); refusals.push(r.refused); }
    else credentials.push(checkCredentialOf(need, r.minted, r.reach));
  }
  for (const workspace of needs.filter((n) => n.asset.kind === 'terraform-workspace')) {
    const role = workspaceRole(needs);
    if (typeof role === 'string') { noCredential(workspace, role); other = true; continue; }
    const session = credentials.find((x) => x.asset.kind === role.asset.kind && x.asset.name === role.asset.name);
    if (session) credentials.push({ ...session, asset: workspace.asset });
    else noCredential(workspace, `the aws-role ${role.asset.name} it is read with gets none`);
  }
  return { credentials, missing, transient: !other && onlyNetworkErrors(refusals) };
}

/**
 * One check of the template's current version, in a check box on a fresh home (issue #1371); the box and its volume are
 * removed after it.
 */
export async function runCheck(c: CheckContext, userId: string, t: Template, name: string): Promise<ReadOnlyCheck> {
  const needs = (t.profiles ?? []).filter((p) => p.operation === 'read');
  // A person's marks on its read probes (issue #916): an expected refusal, or a probe not run.
  const runs = markRuns(c.probes.runsFor(needs), t.probeMarks);
  const ended = (state: 'passed' | 'failed', probes: ReadOnlyCheck['probes'], problem?: string, transient?: boolean): ReadOnlyCheck =>
    ({ version: t.savedAt, state, at: c.clock.now().toISOString(), probes, ...(problem ? { problem } : {}), ...(transient ? { transient: true as const } : {}) });
  if (runs.length === 0) return ended('failed', [], 'no probe checks its needs: it cannot pass');
  const given = await credentialsFor(c, userId, t, name, needs);
  // Issue #873: a probe of a need with no credential is not run, and says why; the probes of the other needs still run.
  const checked = runs.map((r) => (r.notRun === undefined && given.missing.has(runKey(r)) ? { ...r, notRun: given.missing.get(runKey(r))! } : r));
  // A need with no credential that no probe covers fails the check too, with its reason.
  const uncovered = [...given.missing].filter(([key]) => !checked.some((r) => runKey(r) === key)).map(([, why]) => why);
  const problem = uncovered.length > 0 ? uncovered.join('; ') : undefined;
  // Transient only when the probes that failed are those a network error left with no credential.
  const transientOf = (probes: ReadOnlyCheck['probes']): boolean =>
    given.missing.size > 0 && given.transient && probes.every((p, n) => p.passed || given.missing.get(runKey(checked[n]!)) === checked[n]!.notRun);
  if (checked.every((r) => r.notRun !== undefined || r.mark === 'skip')) {
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
    const { image, user } = await boxImage(c.runtime, t.image, t.tools, t.readOnly);
    if (!(await c.runtime.createVolume(volume, labels))) throw staleHome(volume);
    madeHome = true;
    id = await c.runtime.create({ name, image, network: c.network, volume, labels, user, env: checkEnv(given.credentials), limits: boxLimits(t.limits), script: checkScript(checked, given.credentials) });
    await c.runtime.start(id);
    const exit = await c.runtime.wait(id, CHECK_MS);
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
 * The check pass: removes check boxes and their homes no run holds, then checks each template that is due, one after the other. A
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
  return async () => {
    if (c.local) await sweep(c.local);
    const swept = new Set<string>();
    for (const { userId, template: t } of templates.templates()) {
      if (!dueForCheck(t, c.clock.now())) continue;
      const at = await c.place(userId);
      if (!at) continue;
      const key = `${userId}\0${at.machine}`;
      if (at.runtime !== c.local && !swept.has(key)) {
        swept.add(key);
        await sweep(at.runtime).catch(() => {});
      }
      const name = `hopper-check-${t.name}-${Date.now().toString(36)}${(n++).toString(36)}`;
      holds.add(name);
      try {
        // A scheduled check (issue #715) leaves the passed one in place while it runs: the template's boxes go on.
        if (currentCheck(t)?.state !== 'passed') await templates.record(userId, t.name, { version: t.savedAt, state: 'running', at: c.clock.now().toISOString(), probes: [] });
        const check = await runCheck({ ...c, runtime: at.runtime, network: at.network }, userId, t, name);
        // A report that cannot be kept never changes the check: it is kept with no artifact, and the log says why.
        const artifact = await templates.report(userId, t, check).catch((e: unknown) => {
          c.logger.warn(`hopper: the read-only check of template ${t.name} ${check.state}, but its report was not kept: ${e instanceof Error ? e.message : String(e)}`);
          return undefined;
        });
        await templates.record(userId, t.name, artifact ? { ...check, artifact } : check);
        c.logger.info(`hopper: the read-only check of template ${t.name} ${check.state}${at.runtime === c.local ? '' : ` on ${at.machine}`}`);
      } finally {
        // The check box is removed by now, or never started: its credentials end with it (issue #1371).
        await templates.release?.(userId, name).catch(() => {});
        holds.delete(name);
      }
    }
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
  release: async (userId, check) => { await all().find((x) => x.user.id === userId)?.vault.releaseMints(check); },
  report: async (userId, t, check) => {
    const rt = all().find((x) => x.user.id === userId);
    return rt ? keepReport({ artifacts: rt.artifacts, jobs: rt.store.jobs }, t, check) : undefined;
  },
});
