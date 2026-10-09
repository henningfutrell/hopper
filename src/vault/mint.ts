// Minting (issue #580, design.md "Minting: short-lived credentials"): a box's job asks for a credential for an
// operation on an asset; the vault mints a short-lived one — an AWS role session, a Kubernetes token — from the minting
// credential for that account or cluster, and only after Access (`decideMint`) allows the box's template the operation
// on the asset. Every mint and every renewal asks Access again. A deny mints nothing: the profile waits at the
// first-time gate (Settings → Vault) when the template declares it, else it is refused; the reason is on the job's
// timeline. The audit (`vault.minted`) carries Access's decision id beside each mint. The minting credential is opened
// (or read in its vault backend) in memory, for the one call, and never leaves the hopper.
import type { Clock, CredentialMinter, UserStore } from '../domain/ports.ts';
import { ASSET_KINDS, profileProblem, type Asset, type AssetKind, type MintDecision, type OperationProfile, type VaultAccess } from '../domain/access.ts';
import { expiryOf, mintingCredentialOf, mintTarget, profileInWords, type MintKind, type MintTarget } from '../domain/minting.ts';
import type { VaultSecret } from '../domain/vault.ts';
import { AT_WORK, boxAsk, type BoxAskOptions } from './box.ts';

export interface MintAsk { mint: MintKind; operation: string; asset: string; token: string }

export interface MintingOptions extends Omit<BoxAskOptions, 'job'> {
  store: Pick<UserStore, 'vault' | 'events' | 'tx' | 'jobs'>;
  /** The vault's user: Access names a job by its user and id. */
  userId: string;
  /** A secret's value now: opened by the key provider, or read in its vault backend (issue #585); or why not. */
  read(secret: VaultSecret): Promise<{ value: string } | { refused: string }>;
  access?: VaultAccess;
  minter?: CredentialMinter;
  clock: Clock;
}

/** `namespace/lab/web` as an asset; undefined when it names no kind the model has. */
function assetOf(said: string): Asset | undefined {
  const i = said.indexOf('/');
  const kind = said.slice(0, i);
  return i > 0 && (ASSET_KINDS as readonly string[]).includes(kind) ? { kind: kind as AssetKind, name: said.slice(i + 1) } : undefined;
}

const sameProfile = (a: OperationProfile, b: OperationProfile): boolean => a.operation === b.operation && a.asset.kind === b.asset.kind && a.asset.name === b.asset.name;

export function createMinting(o: MintingOptions): (ask: MintAsk, machineKey: string) => Promise<{ value: string } | { refused: string }> {
  const { vault, events } = o.store;
  // A mint for a job and profile minted before is a renewal. Kept in memory: a restart counts the next one as a first.
  const minted = new Set<string>();

  /** Why Access's deny stops the mint: waiting at the first-time gate, or not declared at all. */
  const denied = (template: string, profile: OperationProfile, d: MintDecision): string => {
    const declared = (vault.template(template)?.profiles ?? []).some((p) => sameProfile(p, profile));
    const approved = (o.access?.approvedProfiles(template) ?? []).some((p) => sameProfile(p, profile));
    if (declared && !approved) return `Access denied it: ${d.reason}. ${profileInWords(profile)} waits for a person's approval on Settings → Vault (the first-time gate)`;
    if (!declared) return `Access denied it: ${d.reason}. ${template} does not declare ${profileInWords(profile)}: a person adds it to the template on Settings → Vault, then approves it`;
    return `Access denied it: ${d.reason}`;
  };

  const mintWith = (target: MintTarget, value: string, jobId: string) => {
    if (target.kind === 'aws') {
      const c = mintingCredentialOf('aws', value);
      if (typeof c === 'string') throw new Error(c);
      return o.minter!.awsSession(c, { roleArn: target.roleArn, sessionName: `hopper-${jobId}`.slice(0, 64), policyArns: target.policyArns, durationSeconds: target.durationSeconds });
    }
    const c = mintingCredentialOf('kube', value);
    if (typeof c === 'string') throw new Error(c);
    return o.minter!.kubeToken(c, { namespace: target.namespace, serviceAccount: target.serviceAccount, expirationSeconds: target.expirationSeconds });
  };

  return async (ask, machineKey) => {
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
    if (!o.access) return refuse('access is not part of this hopper: the vault mints nothing without it');

    const decision = await o.access.decideMint({ job: { userId: o.userId, jobId: job.id }, template: machine.template, operation: profile.operation, asset });
    if (!decision.allowed) return refuse(denied(machine.template, profile, decision), decision);

    const { mintsFor } = target;
    const credential: VaultSecret | undefined = vault.list().find((s) => s.mints?.kind === mintsFor.kind && s.mints.name === mintsFor.name);
    if (!credential) return refuse(`no minting credential mints for ${mintsFor.kind} ${mintsFor.name}: a person adds one on Settings → Vault`, decision);
    if (!o.minter) return refuse('this hopper has no minter', decision);
    const read = await o.read(credential);
    if ('refused' in read) return refuse(`the minting credential ${credential.name}: ${read.refused}`, decision);
    // A vault backend's read (issue #585) takes a while: the job must still be at work now.
    const still = o.store.jobs.get(job.id)?.status;
    if (!still || !AT_WORK.includes(still)) return refuse(`the job is not at work (${still ?? 'no such job'}): the vault mints only while it runs`, decision);
    let out;
    try {
      out = await mintWith(target, read.value, job.id);
    } catch (e) {
      return refuse(`minting from ${credential.name} failed: ${(e as Error).message}`, decision);
    }
    const key = `${job.id} ${ask.mint} ${profileInWords(profile)}`;
    const renewal = minted.has(key);
    minted.add(key);
    const at = o.clock.now().toISOString();
    o.store.tx(() => {
      const now = vault.get(credential.name);
      if (now?.id === credential.id) vault.replace({ ...now, lastUsed: { at, machine: machine.name, job: job.id } }, vault.sealed(now.id) ?? null);
      events.append({
        type: 'vault.minted', jobId: job.id, machineId: machine.name,
        data: { kind: ask.mint, operation: profile.operation, asset, template: machine.template, machine: machine.name, job: job.id, credential: credential.name, decision: decision.id, expiresAt: expiryOf(out), renewal },
      });
    });
    const { kind: _kind, ...answer } = out;
    return { value: JSON.stringify(answer) };
  };
}
