// A need step's credentials (issue #1007, design.md "Need steps"): a job at work asks the hopper to run one
// command in a need box of a template that covers its needs; before the box starts, the vault mints the credential of each
// need for that step only — an AWS role session, a Kubernetes token —, never for the job's own machine. As a check box's
// mint (checks.ts): Access is asked as a live job of the template (`decideCheckMint`, recorded with the need box as the
// check), so only a profile a person or a policy approved for the template is minted. An operation but read goes through
// the apply gate too (issue #870): no change without an approved, current plan. Each mint is `vault.minted` (the need box
// as its machine), each refusal `vault.mint_refused`; never a credential. A Kubernetes token is bound to a Secret of its
// own (issue #1371), held for the need box until its step ends (bindings.ts).
import type { UserStore } from '../domain/ports.ts';
import type { OperationProfile, VaultAccess } from '../domain/access.ts';
import { expiryOf, mintKindFor, mintTarget, type Minted, type MintReach } from '../domain/minting.ts';
import { AT_WORK } from './box.ts';
import { principalOf, type MintFrom, type MintingOptions } from './mint.ts';
import type { MintBindings } from './bindings.ts';

/** A need box `step` of `template`, run for the job `job`, asks for the credential of one need; `plan`: the approved plan a change applies. */
export interface NeedMintAsk { template: string; step: string; job: string; profile: OperationProfile; plan?: string }

/** The minted credential and where it is used, or why there is none. */
export type NeedMintAnswer = { minted: Minted; reach: MintReach } | { refused: string };

export interface NeedMinting {
  /** A need step's credential for one need (issue #1007), after Access and, for a change, the apply gate. */
  mintForNeedStep(ask: NeedMintAsk, from?: MintFrom): Promise<NeedMintAnswer>;
}

export function needMinting(store: Pick<UserStore, 'vault' | 'events' | 'tx' | 'jobs'>, o: { access?: VaultAccess | undefined; mintFrom: MintFrom; plans?: MintingOptions['plans']; bindings?: MintBindings }): NeedMinting {
  const { vault, events } = store;
  return {
    async mintForNeedStep({ template, step, job, profile, plan }, from = o.mintFrom) {
      const kind = mintKindFor(profile.asset.kind);
      // A kind the vault mints nothing for: no mint was asked, so no mint is refused (the step's own refusal says why).
      if (!kind) return { refused: `the vault mints a credential for an aws-role, a cluster or a namespace only, not for ${profile.asset.kind} ${profile.asset.name}` };
      const refuse = (reason: string, decision?: string): NeedMintAnswer => {
        events.append({
          type: 'vault.mint_refused', jobId: job, machineId: step,
          data: { mint: { kind, operation: profile.operation, asset: profile.asset }, machine: step, template, job, reason, ...(decision ? { decision } : {}) },
        });
        return { refused: reason };
      };
      const atWork = (): boolean => AT_WORK.includes(store.jobs.get(job)?.status ?? '');
      if (!atWork()) return refuse('the job is not at work: the vault mints for a step only while its job runs');
      const named = mintTarget(kind, profile);
      if (typeof named === 'string') return refuse(named);
      // A need box's token ends with it (issue #1371): bound to a Secret its step's end deletes.
      const target = named.kind === 'kube' && o.bindings ? { ...named, bindTo: o.bindings.name() } : named;
      if (!o.access) return refuse('access is not part of this hopper: the vault mints nothing without it');
      const decision = await o.access.decideCheckMint({ template, check: step, operation: profile.operation, asset: profile.asset });
      if (!decision.allowed) return refuse(`Access denied it: ${decision.reason}`, decision.id);
      // No change without a plan (issue #870): every operation but read changes infrastructure.
      const planNo = o.plans ? await o.plans.gate(profile, plan) : profile.operation === 'read' ? undefined : 'no apply without a plan: this hopper keeps no plans';
      if (planNo) return refuse(planNo, decision.id);
      const { mintsFor } = target;
      const credential = vault.list().find((s) => s.mints?.kind === mintsFor.kind && s.mints.name === mintsFor.name);
      if (!credential) return refuse(`no minting credential mints for ${mintsFor.kind} ${mintsFor.name}: a person adds one on Settings → Vault`, decision.id);
      // Held and recorded before the minter makes the Secret (issue #1628): the step's end releases it, whatever the
      // outcome, and a hopper that stops meanwhile leaves it to the reconcile pass.
      if (target.kind === 'kube' && target.bindTo) o.bindings?.named(step, { credential: credential.name, namespace: target.namespace, secret: target.bindTo }, job);
      const made = await from(credential.name, target, job);
      if ('refused' in made) return refuse(made.refused, decision.id);
      // The minting credential's own service took a while: the job must still be at work.
      if (!atWork()) return refuse('the job is not at work: the vault mints for a step only while its job runs', decision.id);
      const principal = principalOf(target, made);
      const at = new Date().toISOString();
      store.tx(() => {
        const now = vault.get(credential.name);
        if (now?.id === credential.id) vault.replace({ ...now, lastUsed: { at, machine: step, job } }, vault.sealed(now.id) ?? null);
        events.append({
          type: 'vault.minted', jobId: job, machineId: step,
          data: {
            kind, operation: profile.operation, asset: profile.asset, template, machine: step, job, credential: credential.name, decision: decision.id,
            expiresAt: expiryOf(made.minted), renewal: false, ...(profile.operation !== 'read' && plan ? { plan } : {}), ...(principal ? { principal } : {}),
            ...(made.bound ? { bound: made.bound } : {}),
          },
        });
      });
      return { minted: made.minted, reach: made.reach };
    },
  };
}
