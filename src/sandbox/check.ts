// The read-only check's runs (issue #716, item 4; design.md "The read-only check"). A template that needs a check (a job
// asked for it with read needs only), approved, with no check of its current version, gets one: the hopper runs the
// probes for its needs in a check box — the template's image with its tools, under the sandbox flags, its probe script
// in place of the entrypoint — and keeps the result on the template. One check at a time. A check box carries its own
// label, not the box label: the reconcile pass leaves it, and this pass removes one no run holds (a hopper stopped
// mid-check). Issue #797: before the box starts, the vault mints the read credential each read need takes, under Access
// (`CheckTemplates.credential`); the box gets them in its environment, so its reads work and a write is refused by the
// account or the cluster. A need it gets none for fails the check with the reason, and no box runs.
// Issue #715: a passed check runs again once a day (`CHECK_EVERY_MS`), since an account or a cluster can change under a
// template. While it runs the template keeps the check that passed; a check that fails replaces it and blocks the template.
// Issue #715, part 2: a terraform workspace's probes run with the AWS read session of the template's aws-role read need.
// Issue #708: a check runs beside the hopper when it is given a runtime, else on a client target of the template's user,
// dialled in with a runtime there (`CheckPassContext.place`). With neither, the template waits for its check.
// Issue #715, part 4: each ended check's report is an artifact of the job that asked for the template (check-report.ts).
import type { OperationProfile } from '../domain/access.ts';
import type { Minted, MintReach } from '../domain/minting.ts';
import type { CheckCredential, ProbeCatalog, ReadOnlyCheck } from '../domain/read-only-check.ts';
import { currentCheck, markRuns, workspaceRole } from '../domain/read-only-check.ts';
import type { ContainerRuntime, ResourceLimits } from '../domain/sandboxes.ts';
import { imageApproved, type Template } from '../domain/vault.ts';
import { keepReport, type ReportUser } from './check-report.ts';
import { checkEnv, checkScript, readResults } from './check-script.ts';
import { boxImage, USER_LABEL } from './launch.ts';
import { DEFAULT_LIMITS } from './params.ts';

/** The label on every check box: its value is the hopper's instance id. */
export const CHECK_LABEL = 'io.hopper.check';
/** How long a whole check may run. */
export const CHECK_MS = 30 * 60_000;
/** How often a passed check runs again (issue #715). */
export const CHECK_EVERY_MS = 24 * 60 * 60_000;
const LIMITS: ResourceLimits = { cpus: DEFAULT_LIMITS.cpus.default, memoryMb: DEFAULT_LIMITS.memoryMb.default };

/** The templates the check pass reads, of every user, and where it keeps a check. */
export interface CheckTemplates {
  templates(): { userId: string; template: Template }[];
  /** Keeps the check on the user's template, when the template is still at the check's version. */
  record(userId: string, name: string, check: ReadOnlyCheck): Promise<void>;
  /** The read credential the check box `check` gets for one read need of the template (issue #797): minted after Access, or why not. */
  credential(userId: string, template: string, check: string, profile: OperationProfile): Promise<{ minted: Minted; reach: MintReach } | { refused: string }>;
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
 * passed `CHECK_EVERY_MS` ago or more (issue #715). A failed check waits for a person.
 */
export function dueForCheck(t: Template, now: Date): boolean {
  if (t.readOnly !== true || !imageApproved(t)) return false;
  const c = currentCheck(t);
  if (c?.state === 'passed') return now.getTime() - Date.parse(c.at) >= CHECK_EVERY_MS;
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

/**
 * The read credential of each read need, minted for the check box `name`; the reasons when one is not given. A terraform
 * workspace is minted nothing of its own (issue #715): it takes the AWS read session of the template's one aws-role read
 * need (`workspaceRole`), which Access allowed and the deny policy keeps read-only, state backend included.
 */
async function credentialsFor(c: CheckContext, userId: string, t: Template, name: string, needs: readonly OperationProfile[]): Promise<{ credentials: CheckCredential[] } | { problem: string }> {
  const credentials: CheckCredential[] = [];
  const problems: string[] = [];
  const noCredential = (need: OperationProfile, why: string): void => { problems.push(`the check box gets no credential for ${need.operation} on ${need.asset.kind} ${need.asset.name}: ${why}`); };
  for (const need of needs.filter((n) => n.asset.kind !== 'terraform-workspace')) {
    const r = await c.credentials.credential(userId, t.name, name, need);
    if ('refused' in r) noCredential(need, r.refused);
    else credentials.push(checkCredentialOf(need, r.minted, r.reach));
  }
  for (const workspace of needs.filter((n) => n.asset.kind === 'terraform-workspace')) {
    const role = workspaceRole(needs);
    if (typeof role === 'string') noCredential(workspace, role);
    const session = typeof role === 'string' ? undefined : credentials.find((x) => x.asset.kind === role.asset.kind && x.asset.name === role.asset.name);
    if (session) credentials.push({ ...session, asset: workspace.asset });
  }
  return problems.length > 0 ? { problem: problems.join('; ') } : { credentials };
}

/** One check of the template's current version, in a check box; the box and its volume are removed after it. */
export async function runCheck(c: CheckContext, userId: string, t: Template, name: string): Promise<ReadOnlyCheck> {
  const needs = (t.profiles ?? []).filter((p) => p.operation === 'read');
  // A person's marks on its read probes (issue #916): an expected refusal, or a probe not run.
  const runs = markRuns(c.probes.runsFor(needs), t.probeMarks);
  const ended = (state: 'passed' | 'failed', probes: ReadOnlyCheck['probes'], problem?: string): ReadOnlyCheck =>
    ({ version: t.savedAt, state, at: c.clock.now().toISOString(), probes, ...(problem ? { problem } : {}) });
  if (runs.length === 0) return ended('failed', [], 'no probe checks its needs: it cannot pass');
  const given = await credentialsFor(c, userId, t, name, needs);
  if ('problem' in given) return ended('failed', [], given.problem);
  const labels = { [CHECK_LABEL]: c.instanceId, [USER_LABEL]: userId };
  const volume = `${name}-home`;
  let id = '';
  try {
    const { image, user } = await boxImage(c.runtime, t.image, t.tools, t.readOnly);
    await c.runtime.createVolume(volume, labels);
    id = await c.runtime.create({ name, image, network: c.network, volume, labels, user, env: checkEnv(given.credentials), limits: LIMITS, script: checkScript(runs, given.credentials) });
    await c.runtime.start(id);
    const exit = await c.runtime.wait(id, CHECK_MS);
    const probes = readResults(runs, await c.runtime.logs(id));
    // Every probe passed and the script ended well, or it failed: a script cut short is no pass.
    const passed = exit === 0 && probes.every((p) => p.passed);
    return ended(passed ? 'passed' : 'failed', probes, exit !== 0 ? `the check box ended with ${exit}` : undefined);
  } catch (e) {
    return ended('failed', [], `the check box did not run: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (id) await c.runtime.remove(id).catch(() => {});
    await c.runtime.removeVolume(volume).catch(() => {});
  }
}

/**
 * The check pass: removes check boxes no run holds, then checks each template that is due, one after the other. A
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
  report: async (userId, t, check) => {
    const rt = all().find((x) => x.user.id === userId);
    return rt ? keepReport({ artifacts: rt.artifacts, jobs: rt.store.jobs }, t, check) : undefined;
  },
});
