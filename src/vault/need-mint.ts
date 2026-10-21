// A need step's credentials (issue #1007, design.md "Need steps"): a job at work asks the hopper to run one
// command in a need box of a template that covers its needs; before the box starts, the vault mints the credential of each
// need for that step only — an AWS role session, a Kubernetes token —, never for the job's own machine. As a check box's
// mint (checks.ts): Access is asked as a live job of the template (`decideCheckMint`, recorded with the need box as the
// check), so only a profile a person or a policy approved for the template is minted. An operation but read goes through
// the apply gate too (issue #870): no change without an approved, current plan. Each mint is `vault.minted` (the need box
// as its machine), each refusal `vault.mint_refused`; never a credential. A Kubernetes token is bound to a Secret of its
// own (issue #1371), held for the need box until its step ends (bindings.ts). A change narrowed to granted actions (issue
// #2206) is minted only while a person's action grant covers each of them still, and needs no plan (issue #2370).
import type { UserStore } from '../domain/ports.ts';
import { changesAsset, type OperationProfile, type VaultAccess } from '../domain/access.ts';
import { expiryOf, mintKindFor, mintTarget, type Minted, type MintReach } from '../domain/minting.ts';
import { mintSourceFor } from '../domain/cluster-discovery.ts';
import { readClusters, readKnownClusters } from './clusters.ts';
import { AT_WORK } from './box.ts';
import { mintPassingOver, principalOf, sourceWithout, usedOf, type MintFrom, type MintingOptions } from './mint.ts';
import type { MintBindings } from './bindings.ts';
import { appliesRefusal } from '../domain/infra-plans.ts';
import type { AwsAction } from '../domain/action-grants.ts';
import { notGranted } from './action-grants.ts';

/** A need box `step` of `template`, run for the job `job`, asks for the credential of one need; `plan`: the approved plan a change applies. */
export interface NeedMintAsk { template: string; step: string; job: string; profile: OperationProfile; plan?: string; actions?: AwsAction[] }

/** The minted credential and where it is used, or why there is none. */
export type NeedMintAnswer = { minted: Minted; reach: MintReach } | { refused: string };

export interface NeedMinting {
  /** A need step's credential for one need (issue #1007), after Access and, for a change, the apply gate. */
  mintForNeedStep(ask: NeedMintAsk, from?: MintFrom): Promise<NeedMintAnswer>;
}

export function needMinting(store: Pick<UserStore, 'vault' | 'events' | 'tx' | 'jobs' | 'config' | 'topology' | 'settings'>, o: { access?: VaultAccess | undefined; mintFrom: MintFrom; plans?: MintingOptions['plans']; applies?: MintingOptions['applies']; bindings?: MintBindings }): NeedMinting {
  const { vault, events } = store;
  return {
    async mintForNeedStep({ template, step, job, profile, plan, actions }, from = o.mintFrom) {
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
      const named = mintTarget(kind, profile, actions);
      if (typeof named === 'string') return refuse(named);
      // Issue #2206: each granted action still granted now; a revoke or the time limit bites at the next mint.
      const gone = actions?.length ? notGranted(store, profile.asset.name, actions, new Date()) : [];
      if (gone.length) return refuse(`no action grant covers ${gone.map((a) => `${a.action} on ${a.resource}`).join(', ')} now: a person grants it on Access requests`);
      const off = appliesRefusal(profile, o.applies?.() ?? true);
      if (off) return refuse(off);
      // A need box's token ends with it (issue #1371): bound to a Secret its step's end deletes.
      const target = named.kind === 'kube' && o.bindings ? { ...named, bindTo: o.bindings.name() } : named;
      if (!o.access) return refuse('access is not part of this hopper: the vault mints nothing without it');
      const decision = await o.access.decideCheckMint({ template, check: step, operation: profile.operation, asset: profile.asset });
      if (!decision.allowed) return refuse(`Access denied it: ${decision.reason}`, decision.id);
      // No change without a plan (issue #870): a write, sync or apply changes infrastructure; a read or an observe does not.
      // Issue #2370: a change narrowed to granted actions needs none, as the person's grant of each action on its resource
      // approves exactly that change. A plan the step names is still checked.
      const granted = actions?.length && plan === undefined;
      const planNo = granted ? undefined : o.plans ? await o.plans.gate(profile, plan) : changesAsset(profile) ? 'no apply without a plan: this hopper keeps no plans' : undefined;
      if (planNo) return refuse(planNo, decision.id);
      const clusters = readClusters(store.config), known = readKnownClusters(store.topology);
      const found = mintSourceFor(vault.list(), target, profile.operation, clusters, known);
      if (typeof found === 'string') return refuse(found, decision.id);
      // Held and recorded before the minter makes the Secret (issue #1628): the step's end releases it, whatever the
      // outcome, and a hopper that stops meanwhile leaves it to the reconcile pass. A discovered cluster's EKS token binds to nothing.
      if (target.kind === 'kube' && target.bindTo && 'credential' in found) o.bindings?.named(step, { credential: found.credential.name, namespace: target.namespace, secret: target.bindTo }, job);
      const { source, made } = await mintPassingOver(from, found, sourceWithout(vault.list(), target, profile.operation, clusters, known), target, job);
      if ('refused' in made) return refuse(made.refused, decision.id);
      // The minting credential's own service took a while: the job must still be at work.
      if (!atWork()) return refuse('the job is not at work: the vault mints for a step only while its job runs', decision.id);
      const principal = principalOf(target, made);
      const at = new Date().toISOString();
      store.tx(() => {
        const credential = usedOf(source, made);
        const now = vault.get(credential);
        if (now && ('discover' in source || now.id === source.credential.id)) vault.replace({ ...now, lastUsed: { at, machine: step, job } }, vault.sealed(now.id) ?? null);
        events.append({
          type: 'vault.minted', jobId: job, machineId: step,
          data: {
            kind, operation: profile.operation, asset: profile.asset, template, machine: step, job, credential, decision: decision.id,
            expiresAt: expiryOf(made.minted), renewal: false, ...(changesAsset(profile) && plan ? { plan } : {}), ...(principal ? { principal } : {}),
            ...(made.bound ? { bound: made.bound } : {}), ...(actions?.length ? { actions: actions.map((a) => ({ action: a.action, resource: a.resource })) } : {}),
          },
        });
      });
      return { minted: made.minted, reach: made.reach };
    },
  };
}
