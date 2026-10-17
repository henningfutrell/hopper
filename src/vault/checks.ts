// The read-only check on the vault's side (issue #716, item 4): a check kept on its template, a person asking for it
// to run again, and (issue #797) the check box's read credentials. The check itself runs in the sandbox module
// (src/sandbox/check.ts); the vault keeps only its result, and mints.
//
// The check box's mints (issue #797, design.md "The read-only check"): before a check box of a template starts, the
// vault mints the read credential each of its read needs takes — an AWS read session for an `aws-role`, a Kubernetes
// token for a `cluster` or a `namespace` — so the probes' reads work and a write is refused by the account or the
// cluster, not for want of a credential. As a job's mint: only after Access allows the template the read
// (`decideCheckMint`, recorded as the check's decision), from the minting credential for the account or cluster, never
// leaving the hopper or the vault's own container. The check runs no job, so the AWS session is named for the check
// (`CHECK_MINT_ID`), and the minting credential's `lastUsed` (a job's) is left as it is. `vault.check_minted` and
// `vault.check_mint_refused` record each, never a credential.
import type { UserStore } from '../domain/ports.ts';
import type { OperationProfile, VaultAccess } from '../domain/access.ts';
import { CHECK_MINT_ID, expiryOf, mintKindFor, mintTarget, type Minted, type MintReach } from '../domain/minting.ts';
import { currentCheck, failedProbes, probeMarksProblem, type ProbeMarks, type ReadOnlyCheck } from '../domain/read-only-check.ts';
import { PROBES } from '../sandbox/probes.ts';
import type { MintFrom } from './mint.ts';
import type { MintBindings } from './bindings.ts';

/**
 * A template's probe marks at a save (issue #916): the `given` ones, which replace the ones it `had`, or those when none
 * are given; `keep` is what the template and its `template.saved` event hold. `problem`: why the given ones cannot be kept.
 */
export function probeMarksFor(given: Readonly<Record<string, string>> | undefined, had: ProbeMarks | undefined): { problem?: string; keep: { probeMarks?: ProbeMarks } } {
  const problem = given ? probeMarksProblem(given, PROBES) : undefined;
  const marks = { ...(problem ? had : (given as ProbeMarks | undefined) ?? had) };
  return { ...(problem ? { problem } : {}), keep: Object.keys(marks).length ? { probeMarks: marks } : {} };
}

type Result = { ok: true } | { ok: false; code: 'invalid' | 'not_found' | 'conflict'; error: string };

export interface TemplateChecks {
  /** Keeps the check on the template; false (nothing kept) when it is gone or was saved again since the check began. */
  recordCheck(name: string, check: ReadOnlyCheck): boolean;
  /** A person asks for the check to run again: the template's current check goes, and the next check pass runs one. */
  checkTemplate(name: string, by: string): Result;
  /** A read-only check box's credential for one read need (issue #797), after Access: minted, with where it is used, or why not. */
  mintForCheck(ask: CheckMintAsk, from?: MintFrom): Promise<CheckMintAnswer>;
}

/** A check box `check` of `template` asks for the credential of one read need. */
export interface CheckMintAsk { template: string; check: string; profile: OperationProfile }

/** The minted credential and where it is used, or why there is none. */
export type CheckMintAnswer = { minted: Minted; reach: MintReach } | { refused: string };

export function templateChecks(store: Pick<UserStore, 'vault' | 'events' | 'tx'>, o: { access?: VaultAccess | undefined; mintFrom: MintFrom; bindings?: MintBindings }): TemplateChecks {
  const { vault, events } = store;
  const checkMint = createCheckMinting({ store, ...(o.access ? { access: o.access } : {}), ...(o.bindings ? { bindings: o.bindings } : {}) });
  return {
    mintForCheck: (ask, from) => checkMint(ask, from ?? o.mintFrom),
    recordCheck(name, check) {
      return store.tx(() => {
        const t = vault.template(name);
        if (!t || t.savedAt !== check.version) return false;
        vault.saveTemplate({ ...t, check });
        if (check.state !== 'running') {
          events.append({ type: 'template.checked', data: { template: name, state: check.state, failed: failedProbes(check), ...(check.problem ? { problem: check.problem } : {}), ...(check.artifact ? { artifact: check.artifact } : {}) } });
        }
        return true;
      });
    },
    checkTemplate(name, by) {
      const t = vault.template(name);
      if (!t) return { ok: false, code: 'not_found', error: `no template ${name}` };
      if (!t.readOnly) return { ok: false, code: 'invalid', error: `${name} takes no read-only check: only a template a job asked for with read needs only does` };
      if (currentCheck(t)?.state === 'running') return { ok: false, code: 'conflict', error: `the read-only check of ${name} runs now` };
      store.tx(() => {
        const { check: _was, ...rest } = t;
        vault.saveTemplate(rest);
        events.append({ type: 'template.check_requested', data: { template: name, by } });
      });
      return { ok: true };
    },
  };
}

function createCheckMinting(o: { store: Pick<UserStore, 'vault' | 'events'>; access?: VaultAccess; bindings?: MintBindings }): (ask: CheckMintAsk, from: MintFrom) => Promise<CheckMintAnswer> {
  const { vault, events } = o.store;
  return async ({ template, check, profile }, from) => {
    const kind = mintKindFor(profile.asset.kind);
    const refuse = (reason: string, decision?: string): CheckMintAnswer => {
      events.append({
        type: 'vault.check_mint_refused',
        data: { mint: { ...(kind ? { kind } : {}), operation: profile.operation, asset: profile.asset }, template, check, reason, ...(decision ? { decision } : {}) },
      });
      return { refused: reason };
    };
    if (!kind) return refuse(`the vault mints a credential for ${profile.operation} on an aws-role, a cluster or a namespace only`);
    const named = mintTarget(kind, profile);
    if (typeof named === 'string') return refuse(named);
    // A check box's token ends with it (issue #1371): bound to a Secret the check's end deletes.
    const target = named.kind === 'kube' && o.bindings ? { ...named, bindTo: o.bindings.name() } : named;
    if (!o.access) return refuse('access is not part of this hopper: the vault mints nothing without it');
    const decision = await o.access.decideCheckMint({ template, check, operation: profile.operation, asset: profile.asset });
    if (!decision.allowed) return refuse(`Access denied it: ${decision.reason}`, decision.id);
    const { mintsFor } = target;
    const credential = vault.list().find((s) => s.mints?.kind === mintsFor.kind && s.mints.name === mintsFor.name);
    if (!credential) return refuse(`no minting credential mints for ${mintsFor.kind} ${mintsFor.name}: a person adds one on Settings → Vault`, decision.id);
    // Held and recorded before the minter makes the Secret (issue #1628), as a need step's.
    if (target.kind === 'kube' && target.bindTo) o.bindings?.named(check, { credential: credential.name, namespace: target.namespace, secret: target.bindTo });
    const made = await from(credential.name, target, CHECK_MINT_ID);
    if ('refused' in made) return refuse(made.refused, decision.id);
    events.append({
      type: 'vault.check_minted',
      data: { kind, operation: profile.operation, asset: profile.asset, template, check, credential: credential.name, decision: decision.id, expiresAt: expiryOf(made.minted), ...(made.bound ? { bound: made.bound } : {}) },
    });
    return { minted: made.minted, reach: made.reach };
  };
}
