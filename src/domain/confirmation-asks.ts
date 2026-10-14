// A person confirms what an agent asks (issue #909, design.md "A person confirms what an agent asks"): an API token
// approves what waits within its grant's scopes, but not a high-risk infra plan, nor a write, sync or apply profile of a
// template. For those the hopper asks a person — a confirmation ask, an event the notifiers and webhook subscriptions
// that take it send on — and a person approves the item in the UI. What needs a person, the ask's words, and the asks
// made. Pure.
import type { Asset, Operation, OperationProfile } from './access.ts';
import type { InfraPlan } from './infra-plans.ts';

/** What an ask is for: an infra plan, or an operation profile of a vault template. */
export const CONFIRMATION_KINDS = ['infra-plan', 'vault-profile'] as const;
export type ConfirmationKind = (typeof CONFIRMATION_KINDS)[number];

/** An ask for an item is not sent again for this long: the agent may ask again, a person is asked once. */
export const ASK_QUIET_MINUTES = 60;
/** How long an ask is shown on its item while the item still waits. */
export const ASK_SHOWN_HOURS = 24;

/** A confirmation ask, as its event keeps it. `ref`: the item, one string (a plan's id, `<template>:<operation>/<kind>/<name>`). */
export type ConfirmationAsk = { kind: ConfirmationKind; ref: string; words: string; asker: string; plan?: string; template?: string; operation?: Operation; asset?: Asset };

/** Who asked last, and when. */
export interface AskedBy { asker: string; at: string }

/** A plan needs a person unless its summary says low risk: a plan with no summary is not known to be low. */
export const planNeedsPerson = (plan: Pick<InfraPlan, 'summary'>): boolean => plan.summary?.level !== 'low';

/** A profile needs a person unless it only reads: a write credential is a person's to approve. */
export const profileNeedsPerson = (p: Pick<OperationProfile, 'operation'>): boolean => p.operation !== 'read';

export const profileRef = (template: string, p: OperationProfile): string => `${template}:${p.operation}/${p.asset.kind}/${p.asset.name}`;

export function planAsk(plan: Pick<InfraPlan, 'id' | 'target' | 'summary'>, asker: string): ConfirmationAsk {
  const what = plan.summary ? `${plan.summary.level} risk): ${plan.summary.words}` : 'risk not known)';
  return { kind: 'infra-plan', ref: plan.id, plan: plan.id, asker, words: `approve plan ${plan.id.slice(0, 8)} for ${plan.target} (${what}` };
}

export function profileAsk(template: string, p: OperationProfile, asker: string): ConfirmationAsk {
  return {
    kind: 'vault-profile', ref: profileRef(template, p), template, operation: p.operation, asset: p.asset, asker,
    words: `approve ${p.operation} on ${p.asset.kind} ${p.asset.name} for template ${template}`,
  };
}

/** What the API token is told: nothing was approved; a person is asked. */
export const waitingWords = (ask: Pick<ConfirmationAsk, 'words'>): string =>
  `a person confirms this: ${ask.words}. An API token does not approve a high-risk plan or a write, sync or apply profile: the hopper asked a person, who approves it in the UI`;

/** The latest ask of each item of `kind`, by its ref, from the asks' events oldest first. */
export function latestAsks(events: readonly { at: string; data: unknown }[], kind: ConfirmationKind): Map<string, AskedBy> {
  const latest = new Map<string, AskedBy>();
  for (const e of events) {
    const d = e.data as Partial<ConfirmationAsk>;
    if (d.kind === kind && typeof d.ref === 'string') latest.set(d.ref, { asker: String(d.asker), at: e.at });
  }
  return latest;
}

/** Whether the item was asked for within the quiet time: then no new ask is sent. */
export const askedRecently = (last: AskedBy | undefined, now: Date): boolean =>
  last !== undefined && now.getTime() - Date.parse(last.at) < ASK_QUIET_MINUTES * 60_000;
