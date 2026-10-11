// The read-only check's runs (issue #716, item 4; design.md "The read-only check"). A template that needs a check (a job
// asked for it with read needs only), approved, with no check of its current version, gets one: the hopper runs the
// probes for its needs in a check box — the template's image with its tools, under the sandbox flags, its probe script
// in place of the entrypoint — and keeps the result on the template. One check at a time. A check box carries its own
// label, not the box label: the reconcile pass leaves it, and this pass removes one no run holds (a hopper stopped
// mid-check). Issue #797: before the box starts, the vault mints the read credential each read need takes, under Access
// (`CheckTemplates.credential`); the box gets them in its environment, so its reads work and a write is refused by the
// account or the cluster. A need it gets none for fails the check with the reason, and no box runs.
import type { OperationProfile } from '../domain/access.ts';
import type { Minted, MintReach } from '../domain/minting.ts';
import type { CheckCredential, ProbeCatalog, ReadOnlyCheck } from '../domain/read-only-check.ts';
import { currentCheck } from '../domain/read-only-check.ts';
import type { ContainerRuntime, ResourceLimits } from '../domain/sandboxes.ts';
import { imageApproved, type Template } from '../domain/vault.ts';
import { checkEnv, checkScript, readResults } from './check-script.ts';
import { boxImage, USER_LABEL } from './launch.ts';
import { DEFAULT_LIMITS } from './params.ts';

/** The label on every check box: its value is the hopper's instance id. */
export const CHECK_LABEL = 'io.hopper.check';
/** How long a whole check may run. */
export const CHECK_MS = 30 * 60_000;
const LIMITS: ResourceLimits = { cpus: DEFAULT_LIMITS.cpus.default, memoryMb: DEFAULT_LIMITS.memoryMb.default };

/** The templates the check pass reads, of every user, and where it keeps a check. */
export interface CheckTemplates {
  templates(): { userId: string; template: Template }[];
  /** Keeps the check on the user's template, when the template is still at the check's version. */
  record(userId: string, name: string, check: ReadOnlyCheck): Promise<void>;
  /** The read credential the check box `check` gets for one read need of the template (issue #797): minted after Access, or why not. */
  credential(userId: string, template: string, check: string, profile: OperationProfile): Promise<{ minted: Minted; reach: MintReach } | { refused: string }>;
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

/**
 * Whether the template gets a check now: it needs one, its image is approved, and its version has none — or one still
 * `running`, which a pass finds only when a hopper stopped mid-check: passes run one after the other.
 */
export function dueForCheck(t: Template): boolean {
  const state = currentCheck(t)?.state;
  return t.readOnly === true && imageApproved(t) && state !== 'passed' && state !== 'failed';
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

/** The read credential of each read need, minted for the check box `name`; the reasons when one is not given. */
async function credentialsFor(c: CheckContext, userId: string, t: Template, name: string, needs: readonly OperationProfile[]): Promise<{ credentials: CheckCredential[] } | { problem: string }> {
  const credentials: CheckCredential[] = [];
  const problems: string[] = [];
  for (const need of needs) {
    const r = await c.credentials.credential(userId, t.name, name, need);
    if ('refused' in r) problems.push(`the check box gets no credential for ${need.operation} on ${need.asset.kind} ${need.asset.name}: ${r.refused}`);
    else credentials.push(checkCredentialOf(need, r.minted, r.reach));
  }
  return problems.length > 0 ? { problem: problems.join('; ') } : { credentials };
}

/** One check of the template's current version, in a check box; the box and its volume are removed after it. */
export async function runCheck(c: CheckContext, userId: string, t: Template, name: string): Promise<ReadOnlyCheck> {
  const needs = (t.profiles ?? []).filter((p) => p.operation === 'read');
  const runs = c.probes.runsFor(needs);
  const ended = (state: 'passed' | 'failed', probes: ReadOnlyCheck['probes'], problem?: string): ReadOnlyCheck =>
    ({ version: t.savedAt, state, at: c.clock.now().toISOString(), probes, ...(problem ? { problem } : {}) });
  if (runs.length === 0) return ended('failed', [], 'no probe checks its needs: it cannot pass');
  const given = await credentialsFor(c, userId, t, name, needs);
  if ('problem' in given) return ended('failed', [], given.problem);
  const labels = { [CHECK_LABEL]: c.instanceId, [USER_LABEL]: userId };
  const volume = `${name}-home`;
  let id = '';
  try {
    const { image, user } = await boxImage(c.runtime, t.image, t.tools);
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

/** The check pass: removes check boxes no run holds, then checks each template that is due, one after the other. */
export function createCheckPass(c: CheckContext, templates: CheckTemplates): () => Promise<void> {
  const holds = new Set<string>();
  let n = 0;
  return async () => {
    for (const box of await c.runtime.list({ [CHECK_LABEL]: c.instanceId })) {
      if (holds.has(box.name)) continue;
      await c.runtime.remove(box.id).catch(() => {});
      await c.runtime.removeVolume(`${box.name}-home`).catch(() => {});
    }
    for (const { userId, template: t } of templates.templates()) {
      if (!dueForCheck(t)) continue;
      const name = `hopper-check-${t.name}-${Date.now().toString(36)}${(n++).toString(36)}`;
      holds.add(name);
      try {
        await templates.record(userId, t.name, { version: t.savedAt, state: 'running', at: c.clock.now().toISOString(), probes: [] });
        const check = await runCheck(c, userId, t, name);
        await templates.record(userId, t.name, check);
        c.logger.info(`hopper: the read-only check of template ${t.name} ${check.state}`);
      } finally {
        holds.delete(name);
      }
    }
  };
}

/** What the check pass reads of a user's vault: its templates, where a check is kept, and the check box's mints. */
interface UserVault {
  user: { id: string };
  store: { vault: { templates(): Template[] } };
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
});
