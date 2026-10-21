// Minting (issue #580, design.md "Minting: short-lived credentials"): a box's job asks for a credential for an
// operation on an asset; the vault mints a short-lived one — an AWS role session, a Kubernetes token — from the minting
// credential for that account or cluster, and only after Access (`decideMint`) allows the box's template the operation
// on the asset. Every mint and every renewal asks Access again. A deny mints nothing: the profile waits at the
// first-time gate (Settings → Vault) when the template declares it, else it is refused; the reason is on the job's
// timeline. The audit (`vault.minted`) carries Access's decision id beside each mint. The minting credential is opened
// (or read in its vault backend) in memory, for the one call, and never leaves the hopper.
import type { Clock, UserStore } from '../domain/ports.ts';
import { ASSET_KINDS, changesAsset, profileProblem, type Asset, type AssetKind, type MintDecision, type Operation, type OperationProfile, type VaultAccess } from '../domain/access.ts';
import type { ClusterOverride } from '../domain/clusters.ts';
import { expiryOf, mintTarget, profileInWords, type CallerIdentity, type ClusterIdentity, type Minted, type MintKind, type MintReach, type MintTarget } from '../domain/minting.ts';
import type { VaultSecret } from '../domain/vault.ts';
import { awsRegionOf, awsSessionName, mintingCredentialOf } from '../domain/minting.ts';
import type { CredentialMinter, VaultRepository } from '../domain/ports.ts';
import { AT_WORK, boxAsk, type BoxAskOptions } from './box.ts';
import { mintDiscovered, mintEks } from './eks.ts';
import { mintSourceFor, type ClusterDiscovery, type MintSource } from '../domain/cluster-discovery.ts';
import { readClusters, readKnownClusters } from './clusters.ts';
import { mintPrincipal } from '../domain/out-of-band.ts';
import type { UnbindFrom } from './bindings.ts';
import { appliesRefusal } from '../domain/infra-plans.ts';

/** `plan` (issue #870): the plan an operation that changes infrastructure applies. */
export interface MintAsk { mint: MintKind; operation: string; asset: string; plan?: string; token: string }

/**
 * Mints from the minting credential `name` for `target`: in the hopper, or (issue #586) in the vault's own container,
 * which holds the value, for the job `jobId` (an AWS session is named for it, `awsSessionName`). Called only after
 * Access allowed it, or for a person's mint test (issue #781): `identify` then asks STS who the minted session is, where
 * the credential's STS is known, or (issue #854) the cluster who the token is. `reach`: where the minted credential is
 * used (issue #797), never a secret. `roleArn` and `sessionName`: the role session an EKS token was signed with. Or
 * (issue #1766) a cluster to find in the AWS accounts: `credential` and `account` then say which minting credential and
 * account it was found with. Never says the minting credential's value.
 */
export type MintFrom = (from: string | ClusterDiscovery, target: MintTarget, jobId: string, identify?: boolean) => Promise<MintedFrom | MintRefused>;
/** Why a mint gave nothing. `kubeconfigGone` (issue #1845): the source was an EKS minting credential whose kubeconfig secret is gone. */
export interface MintRefused { refused: string; kubeconfigGone?: true }
export interface MintedFrom {
  minted: Minted; reach: MintReach; roleArn?: string; sessionName?: string; identity?: CallerIdentity; cluster?: ClusterIdentity;
  /** The AWS minting credential and account a discovered cluster's token was signed with (issue #1766). */
  credential?: string; account?: string;
  /** A discovered cluster (issue #1845): the region EKS has it in, and the regions the vault looked in, by account. */
  region?: string; searched?: { account: string; regions: string[] }[];
  /** Why the mint came from somewhere else than the cluster's own minting credential (issue #1845, `mintPassingOver`). */
  warning?: string;
  /** The Secret the token is bound to (issue #1371), when the target asked for one (`bindTo`) and the credential could: a `token` one, not EKS. */
  bound?: { namespace: string; secret: string };
}

export interface MintingOptions extends Omit<BoxAskOptions, 'job'> {
  store: Pick<UserStore, 'vault' | 'events' | 'tx' | 'jobs' | 'config' | 'topology'>;
  /** The vault's user: Access names a job by its user and id. */
  userId: string;
  access?: VaultAccess;
  clock: Clock;
  /** The apply gate (issue #870): absent, no credential that changes infrastructure is minted. */
  plans?: { gate(profile: OperationProfile, planId: string | undefined): Promise<string | undefined> };
  /** Whether infra applies are on (issue #1722, the instance's setting, read at each ask); off, only a read is minted. Absent: on. */
  applies?: () => boolean;
  /** What was minted, by job: each job's mint keys. Default: a map of its own. */
  minted?: Map<string, Set<string>>;
}

/** `namespace/lab/web` as an asset; undefined when it names no kind the model has. */
export function assetOf(said: string): Asset | undefined {
  const i = said.indexOf('/');
  const kind = said.slice(0, i);
  return i > 0 && (ASSET_KINDS as readonly string[]).includes(kind) ? { kind: kind as AssetKind, name: said.slice(i + 1) } : undefined;
}

/** What `MintFrom` takes for a source: a minting credential's name, or the cluster to find. */
export const fromOf = (s: MintSource<{ name: string }>): string | ClusterDiscovery => ('credential' in s ? s.credential.name : s.discover);

/** The minting credential a mint used, for its record: the source's own, else the AWS one a discovery found it with. */
export const usedOf = (s: MintSource<{ name: string }>, made: Pick<MintedFrom, 'credential'>): string => ('credential' in s ? s.credential.name : made.credential ?? '');

/**
 * Mints for `target` from `source` (issue #1845). When that is an EKS minting credential whose kubeconfig secret is gone,
 * the vault passes over it: it mints from where `again` says with that credential left out — the cluster found in the
 * AWS accounts —, and `warning` says so. A refusal then says both reasons. Answers the source the mint came from.
 */
export async function mintPassingOver<S extends { name: string }>(
  from: MintFrom, source: MintSource<S>, again: (skip: string) => MintSource<S> | string, target: MintTarget, jobId: string, identify?: boolean,
): Promise<{ source: MintSource<S>; made: MintedFrom | { refused: string } }> {
  const made = await from(fromOf(source), target, jobId, identify);
  if (!('refused' in made) || !made.kubeconfigGone || !('credential' in source)) return { source, made };
  const skip = source.credential.name;
  const other = again(skip);
  const passed = (why: string) => ({ source, made: { refused: `${made.refused}; passed over it: ${why}` } });
  if (typeof other === 'string') return passed(other);
  const second = await from(fromOf(other), target, jobId, identify);
  if ('refused' in second) return passed(second.refused);
  const warning = `${made.refused}. The vault passed over it and found the cluster in the AWS accounts: fix or remove ${skip} on Settings → Vault`;
  return { source: other, made: { ...second, warning } };
}

/** The sources `mintPassingOver` mints from in place of a minting credential it passes over: as `mintSourceFor`, without it. */
export const sourceWithout = <S extends { name: string; mints?: Asset }>(secrets: readonly S[], target: MintTarget, operation: Operation, clusters: readonly ClusterOverride[], known: readonly string[] = []) =>
  (skip: string): MintSource<S> | string => mintSourceFor(secrets.filter((s) => s.name !== skip), target, operation, clusters, known);

const sameProfile = (a: OperationProfile, b: OperationProfile): boolean => a.operation === b.operation && a.asset.kind === b.asset.kind && a.asset.name === b.asset.name;

export function createMinting(o: MintingOptions): (ask: MintAsk, machineKey: string, from: MintFrom) => Promise<{ value: string } | { refused: string }> {
  const { vault, events } = o.store;
  // A mint for a job and profile minted before is a renewal. Kept in memory: a restart counts the next one as a first.
  const minted = o.minted ?? new Map<string, Set<string>>();

  /** Why Access's deny stops the mint: waiting at the first-time gate, or not declared at all. */
  const denied = (template: string, profile: OperationProfile, d: MintDecision): string => {
    const declared = (vault.template(template)?.profiles ?? []).some((p) => sameProfile(p, profile));
    const approved = (o.access?.approvedProfiles().get(template) ?? []).some((p) => sameProfile(p, profile));
    if (declared && !approved) return `Access denied it: ${d.reason}. ${profileInWords(profile)} waits for a person's approval on Access requests (the first-time gate)`;
    if (!declared) return `Access denied it: ${d.reason}. ${template} does not declare ${profileInWords(profile)}: a person adds it to the template on Settings → Vault, then approves it`;
    return `Access denied it: ${d.reason}`;
  };

  return async (ask, machineKey, from) => {
    const box = boxAsk({ ...o, job: (id) => o.store.jobs.get(id) }, ask.token, machineKey);
    const asset = assetOf(ask.asset);
    const said = { kind: ask.mint, operation: ask.operation, asset: asset ?? ask.asset };
    const refuse = (reason: string, decision?: MintDecision): { refused: string } => {
      const job = box.job;
      events.append({
        type: 'vault.mint_refused', ...(job ? { jobId: job.id } : {}), ...(box.machine ? { machineId: box.machine.name } : {}),
        data: {
          mint: said, machine: box.machine?.name ?? 'a machine that is gone', ...(box.machine?.template ? { template: box.machine.template } : {}),
          ...(job ? { job: job.id } : {}), reason, ...(decision ? { decision: decision.id } : {}),
        },
      });
      return { refused: reason };
    };
    if ('refused' in box) return refuse(box.refused);
    const { machine, job } = box;
    if (!asset) return refuse(`asset ${ask.asset} names no asset kind: one of ${ASSET_KINDS.join(', ')}`);
    const profile = { operation: ask.operation, asset } as OperationProfile;
    const problem = profileProblem(profile);
    if (problem) return refuse(problem);
    const target = mintTarget(ask.mint, profile);
    if (typeof target === 'string') return refuse(target);
    const off = appliesRefusal(profile, o.applies?.() ?? true);
    if (off) return refuse(off);
    if (!o.access) return refuse('access is not part of this hopper: the vault mints nothing without it');

    // Access takes the template from who the job is now (issue #581): the box it runs on, joined as its template.
    const decision = await o.access.decideMint({ requester: { kind: 'job', userId: o.userId, jobId: job.id }, operation: profile.operation, asset });
    if (!decision.allowed) return refuse(denied(machine.template, profile, decision), decision);
    // No apply without a plan (issue #870): a write, sync or apply changes infrastructure; a read or an observe does not.
    const planNo = o.plans ? await o.plans.gate(profile, ask.plan) : changesAsset(profile) ? 'no apply without a plan: this hopper keeps no plans' : undefined;
    if (planNo) return refuse(planNo, decision);
    const plan = changesAsset(profile) && ask.plan ? { plan: ask.plan } : {};

    const clusters = readClusters(o.store.config), known = readKnownClusters(o.store.topology);
    const found = mintSourceFor(vault.list(), target, profile.operation, clusters, known);
    if (typeof found === 'string') return refuse(found, decision);
    const { source, made } = await mintPassingOver(from, found, sourceWithout(vault.list(), target, profile.operation, clusters, known), target, job.id);
    if ('refused' in made) return refuse(made.refused, decision);
    const used = usedOf(source, made);
    const out = made.minted;
    // Who the credential writes as (issue #871): an audit-log write by it, while it is valid, is the plan's apply.
    const principal = principalOf(target, made);
    // A vault backend's read (issue #585) or the vault's container (issue #586) takes a while: the job must still be at work.
    const still = o.store.jobs.get(job.id)?.status;
    if (!still || !AT_WORK.includes(still)) return refuse(`the job is not at work (${still ?? 'no such job'}): the vault mints only while it runs`, decision);
    const key = `${ask.mint} ${profileInWords(profile)}`;
    // A job no longer at work mints no more: its keys go (issue #1402).
    for (const id of minted.keys()) if (id !== job.id && !AT_WORK.includes(o.store.jobs.get(id)?.status ?? '')) minted.delete(id);
    const keys = minted.get(job.id) ?? new Set<string>();
    const renewal = keys.has(key);
    minted.set(job.id, keys.add(key));
    const at = o.clock.now().toISOString();
    o.store.tx(() => {
      const now = vault.get(used);
      if (now && ('discover' in source || now.id === source.credential.id)) vault.replace({ ...now, lastUsed: { at, machine: machine.name, job: job.id } }, vault.sealed(now.id) ?? null);
      events.append({
        type: 'vault.minted', jobId: job.id, machineId: machine.name,
        data: { kind: ask.mint, operation: profile.operation, asset, template: machine.template, machine: machine.name, job: job.id, credential: used, decision: decision.id, expiresAt: expiryOf(out), renewal, ...plan, ...(principal ? { principal } : {}) },
      });
    });
    const { kind: _kind, ...answer } = out;
    return { value: JSON.stringify(answer) };
  };
}

/** Who a minted credential writes as, as an audit log names it (issue #871): an EKS token as its role's session. */
export function principalOf(target: MintTarget, made: Pick<MintedFrom, 'roleArn' | 'sessionName'>): string | undefined {
  if (target.kind === 'kube' && !made.roleArn) return mintPrincipal({ kind: 'kube', namespace: target.namespace, serviceAccount: target.serviceAccount });
  const roleArn = target.kind === 'aws' ? target.roleArn : made.roleArn;
  return roleArn && made.sessionName ? mintPrincipal({ kind: 'aws', roleArn, sessionName: made.sessionName }) : undefined;
}

/**
 * Unbinds here (issue #1371): deletes the Secret a sandbox's token is bound to, with the minting credential that made it
 * (opened, or read in its vault backend). Never says its value.
 */
export function unbindHere(o: Parameters<typeof mintHere>[0]): UnbindFrom {
  return async (b) => {
    const credential = o.vault.get(b.credential);
    if (!credential?.mints) return { refused: `the vault holds no minting credential ${b.credential}` };
    if (!o.minter) return { refused: 'this vault has no minter' };
    const read = await o.valueOf(credential);
    if ('refused' in read) return { refused: `the minting credential ${b.credential}: ${read.refused}` };
    const c = mintingCredentialOf('kube', read.value);
    if (typeof c === 'string') return { refused: `the minting credential ${b.credential}: ${c}` };
    if (c.type !== 'token') return { refused: `the minting credential ${b.credential} binds no token` };
    try {
      await o.minter.kubeUnbind(c, { namespace: b.namespace, secret: b.secret });
      return { ok: true };
    } catch (e) {
      return { refused: (e as Error).message };
    }
  };
}

/**
 * Mints here from the minting credential `name` (opened, or read in its vault backend): never says its value. A cluster's
 * `eks` credential (issue #854) reads the AWS minting credential of its role's account too.
 */
export function mintHere(o: { vault: Pick<VaultRepository, 'get' | 'list'>; minter?: CredentialMinter; valueOf(secret: VaultSecret): Promise<{ value: string } | { refused: string }> }): MintFrom {
  return async (from, target, jobId, identify) => {
    const minter = o.minter;
    if (typeof from !== 'string') {
      if (!minter) return { refused: 'this vault has no minter' };
      if (target.kind !== 'kube') return { refused: `the vault finds a cluster, not ${target.mintsFor.kind} ${target.mintsFor.name}` };
      return await mintDiscovered({ vault: o.vault, minter, valueOf: o.valueOf }, from, jobId, identify)
        .catch((e: unknown) => ({ refused: `minting for cluster ${from.cluster} failed: ${(e as Error).message}` }));
    }
    const name = from;
    const credential = o.vault.get(name);
    if (!credential?.mints) return { refused: `the vault holds no minting credential ${name}` };
    if (!minter) return { refused: 'this vault has no minter' };
    const read = await o.valueOf(credential);
    if ('refused' in read) return { refused: `the minting credential ${name}: ${read.refused}` };
    try {
      if (target.kind === 'aws') {
        const c = mintingCredentialOf('aws', read.value);
        if (typeof c === 'string') return { refused: `the minting credential ${name}: ${c}` };
        const sessionName = awsSessionName(c, jobId);
        const minted = await minter.awsSession(c, { roleArn: target.roleArn, sessionName, policyArns: target.policyArns, policy: target.policy, durationSeconds: target.durationSeconds });
        const reach: MintReach = { kind: 'aws', region: awsRegionOf(c), ...(c.Endpoint ? { stsEndpoint: c.Endpoint } : {}) };
        return { minted, reach, sessionName, ...(identify ? { identity: await minter.awsCallerIdentity(c, minted) } : {}) };
      }
      const c = mintingCredentialOf('kube', read.value);
      if (typeof c === 'string') return { refused: `the minting credential ${name}: ${c}` };
      if (c.type === 'eks') return await mintEks({ vault: o.vault, minter, valueOf: o.valueOf }, name, c, jobId, identify);
      const reach = { kind: 'kube' as const, server: c.server, ...(c.certificateAuthorityData ? { certificateAuthorityData: c.certificateAuthorityData } : {}) };
      const minted = await minter.kubeToken(c, { namespace: target.namespace, serviceAccount: target.serviceAccount, expirationSeconds: target.expirationSeconds, ...(target.bindTo ? { bindTo: target.bindTo } : {}) });
      const bound = target.bindTo ? { bound: { namespace: target.namespace, secret: target.bindTo } } : {};
      return { minted, reach, ...bound, ...(identify ? { cluster: await minter.kubeIdentity(reach, minted.token) } : {}) };
    } catch (e) {
      return { refused: `minting from ${name} failed: ${(e as Error).message}` };
    }
  };
}
