// The vault as the hopper's parts reach it (issue #586): in the hopper's own process, or with its secrets in a container
// of its own (src/vault/remote.ts); the credential requests (issue #583) over either; and the view every answer carries.
import type { Clock, UserStore } from '../domain/ports.ts';
import type { VaultView } from '../domain/vault.ts';
import type { MintAsk } from './mint.ts';
import { createCredentialRequests, type Asker, type CredentialAsk, type Give, type NeedAnswer } from './requests.ts';
import type { SetSecret, VaultResult, VaultService } from './service.ts';

/**
 * The vault as the hopper's parts reach it (issue #586): in the hopper (`localVault`), or with its secrets in a container
 * of its own (`remoteVault`, src/vault/remote.ts). Its secrets' metadata and its templates are read here at once; what
 * needs the vault's key — set, remove, deliver — and whether it can be used now (`status`) may cross the network.
 */
export interface Vault extends Pick<VaultService, 'saveTemplate' | 'removeTemplate' | 'approveTemplate' | 'revokeTemplate' | 'approveProfile' | 'scopeOf' | 'boxRadius' | 'boxes' | 'templateScopes'> {
  /** Its secrets' metadata and its templates, never a value. `problem` only when `status` is not asked: see vaultView. */
  view(): VaultView;
  /** Why no vault secret can be stored or delivered now; undefined when one can. */
  status(): Promise<string | undefined>;
  set(s: SetSecret, by: string): Promise<VaultResult>;
  remove(name: string, by: string): Promise<VaultResult>;
  deliver(ask: { name: string; token: string }, machineKey: string): Promise<{ value: string } | { refused: string }>;
  mint(ask: MintAsk, machineKey: string): Promise<{ value: string } | { refused: string }>;
  /**
   * A job on a box loaded a skill whose credential its template does not give (issue #583, the skill broker proved who
   * asks): a person is asked — a credential request, opened or joined — or the job is told they declined.
   */
  need(ask: CredentialAsk, asker: Asker): NeedAnswer;
  /** A person gives a credential for a request: a vault secret (set as any other), added to its template's scope. */
  give(id: string, g: Give, by: string): Promise<VaultResult>;
  /** A person declines a request: each job that waits on it is told why. */
  decline(id: string, reason: string, by: string): VaultResult;
}

/**
 * The credential requests (issue #583, src/vault/requests.ts) over a vault, wherever it runs: kept in the hopper's memory,
 * shown in the vault's view; a credential given is set through the vault itself.
 */
export function withCredentialRequests(v: Omit<Vault, 'need' | 'give' | 'decline'>, o: { store: Pick<UserStore, 'vault' | 'events' | 'tx' | 'jobs'>; clock: Clock; idGen: () => string }): Vault {
  const requests = createCredentialRequests({ ...o, set: (s, by) => v.set(s, by) });
  return { ...v, view: () => ({ ...v.view(), requests: requests.list() }), need: requests.need, give: requests.give, decline: requests.decline };
}

/** The vault in the hopper's own process. */
export const localVault = (v: VaultService): Omit<Vault, 'need' | 'give' | 'decline'> => ({
  view: () => v.view(),
  status: async () => v.view().problem,
  set: async (s, by) => v.set(s, by),
  remove: async (name, by) => v.remove(name, by),
  deliver: (ask, key) => v.deliver(ask, key),
  mint: (ask, key) => v.mint(ask, key),
  saveTemplate: (t, by) => v.saveTemplate(t, by),
  removeTemplate: (name, by) => v.removeTemplate(name, by),
  approveTemplate: (name, by) => v.approveTemplate(name, by),
  revokeTemplate: (name, by) => v.revokeTemplate(name, by),
  approveProfile: (name, profile, by) => v.approveProfile(name, profile, by),
  scopeOf: (machine) => v.scopeOf(machine), boxRadius: (machine) => v.boxRadius(machine),
  boxes: () => v.boxes(),
  templateScopes: () => v.templateScopes(),
});

/** Whether the vault holds a template of this name: a box joins as, or is set to, only one that is there (issue #604). */
export const holdsTemplate = (v: Pick<Vault, 'view'>, name: string): boolean => v.view().templates.some((t) => t.name === name);

/** What `GET /api/vault` and each edit answer: the view, with the vault's status as its problem. */
export async function vaultView(v: Vault): Promise<VaultView> {
  const problem = await v.status();
  const { problem: _local, ...view } = v.view();
  return { ...view, ...(problem !== undefined ? { problem } : {}) };
}
