// The vault as the hopper's parts reach it (issue #586): in the hopper's own process, or with its secrets in a container
// of its own (src/vault/remote.ts); the credential requests (issue #583) over either; and the view every answer carries.
import type { Clock, UserStore } from '../domain/ports.ts';
import { withReruns, type SystemSecretName, type VaultView } from '../domain/vault.ts';
import { laterRuns } from '../domain/rerun-chain.ts';
import type { MintAsk } from './mint.ts';
import type { MintTestAnswer } from './mint-test.ts'; import type { DiscoveryMintAnswer } from './discovery-mint.ts'; import type { Asset } from '../domain/access.ts';
import type { CheckMintAnswer, CheckMintAsk } from './checks.ts';
import type { NeedMintAnswer, NeedMintAsk } from './need-mint.ts'; import type { DatabaseReadAnswer, DatabaseReadAsk } from './database-reads.ts';
import { createCredentialRequests, type Asker, type CredentialAsk, type Give, type NeedAnswer } from './requests.ts';
import type { SetSecret, VaultResult, VaultService } from './service.ts';
import type { SharedSecrets } from './shared.ts';
import type { SystemChanger, SystemResult } from './system.ts';

/**
 * The vault as the hopper's parts reach it (issue #586): in the hopper (`localVault`), or with its secrets in a container
 * of its own (`remoteVault`, src/vault/remote.ts). Its secrets' metadata and its templates are read here at once; what
 * needs the vault's key — set, remove, deliver — and whether it can be used now (`status`) may cross the network.
 */
export interface Vault extends Pick<VaultService, 'forStep' | 'saveTemplate' | 'removeTemplate' | 'approveTemplate' | 'revokeTemplate' | 'approveProfile' | 'scopeOf' | 'boxRadius' | 'boxes' | 'templateScopes' | 'recordCheck' | 'checkTemplate' | 'agentCredential' | 'podCredential' | 'deliveredTo'> {
  /** Its secrets' metadata and its templates, never a value. `problem` only when `status` is not asked: see vaultView. */
  view(): VaultView;
  /** Why no vault secret can be stored or delivered now; undefined when one can. */
  status(): Promise<string | undefined>;
  set(s: SetSecret, by: string): Promise<VaultResult>;
  /** Keeps the user's system secret `name` in a vault backend (issue #658, requirement 6); absent where the system scope is not wired. */
  systemInBackend?(name: SystemSecretName, backend: string, reference: string, who: SystemChanger): Promise<SystemResult>;
  remove(name: string, by: string): Promise<VaultResult>;
  deliver(ask: { name: string; token: string }, machineKey: string): Promise<{ value: string } | { refused: string }>;
  mint(ask: MintAsk, machineKey: string): Promise<{ value: string } | { refused: string }>;
  /** A person's mint test (issue #781): an AWS read session minted where the minting credential is, and who STS says it is. */
  testMint(asset: string, by: string): Promise<MintTestAnswer>;
  /** Topology discovery's read credential (issue #1781 part 3), minted where the minting credential is. */
  mintForDiscovery(asset: Asset): Promise<DiscoveryMintAnswer>;
  /** A read-only check box's credential for one read need (issue #797), after Access, minted where the minting credential is. */
  mintForCheck(ask: CheckMintAsk): Promise<CheckMintAnswer>;
  /** A need step's credential for one need (issue #1007), after Access and the apply gate, minted where the minting credential is. */
  mintForNeedStep(ask: NeedMintAsk): Promise<NeedMintAnswer>;
  /** A need box or a check box ended (issue #1371): each Kubernetes token minted for it stops working. Never rejects. */
  releaseMints(box: string): Promise<void>;
  /** Unbinds each token a sandbox that ended left bound (issue #1371), and drops each database read role past its TTL (issue #2231): at start, then every few minutes. */
  reconcileMints(): Promise<void>;
  /** A job's database read (issue #2231), where the minting credential is opened. Absent: the vault runs in its own container, which reads no database yet. */
  readDatabase?(ask: DatabaseReadAsk): Promise<DatabaseReadAnswer>;
  /**
   * A job on a box loaded a skill whose credential its template does not give (issue #583, the skill broker proved who
   * asks): a person is asked — a credential request, opened or joined — or the job is told they declined.
   */
  need(ask: CredentialAsk, asker: Asker): NeedAnswer;
  /** A person gives a credential for a request: a vault secret (set as any other), added to its template's scope. */
  give(id: string, g: Give, by: string): Promise<VaultResult>;
  /** A person declines a request: each job that waits on it is told why. */
  decline(id: string, reason: string, by: string): VaultResult;
  /** The check pass says why a template's due read-only check does not start now, or undefined once it starts (issue #2236). */
  holdCheck(name: string, why: string | undefined): void;
  /** The shared secrets (issue #718): the hopper's admin sets and removes them. Absent: this hopper keeps none. */
  shared?: Pick<SharedSecrets, 'set' | 'remove'>;
  /** A person grants a job's item the vault (issue #652, src/vault/grants.ts), after Access: its jobs then get what their box's template gives. */
  grant?(jobId: string, by: string): VaultResult;
  /** A person takes a job's item's vault grant back (issue #652): its jobs get nothing from the vault again. */
  revokeGrant?(jobId: string, by: string): VaultResult;
  /** A person, or a delegate approver for them (issue #1138), denies a job's grant ask: the ask goes, and the job asks no more. 409: none waits. */
  denyGrant?(jobId: string, by: string): VaultResult;
}

/**
 * The credential requests (issue #583, src/vault/requests.ts) over a vault, wherever it runs: kept in the hopper's memory,
 * shown in the vault's view; a credential given is set through the vault itself. And the check holds (issue #2236).
 */
export function withCredentialRequests(v: Omit<Vault, 'need' | 'give' | 'decline' | 'holdCheck'>, o: { store: Pick<UserStore, 'vault' | 'events' | 'tx' | 'jobs'>; clock: Clock; idGen: () => string }): Vault {
  const requests = createCredentialRequests({ ...o, set: (s, by) => v.set(s, by) });
  // Why each template's due read-only check does not start now (issue #2236): kept in memory too, on the template's view.
  const held = new Map<string, string>();
  const view = (): VaultView => {
    const at = v.view();
    // A template approved for some jobs' runs covers the jobs that run them again (issue #2639 part 2).
    const later = (id: string): string[] => laterRuns(id, (x) => o.store.jobs.get(x), (key) => o.store.jobs.getBySourceKey(key));
    return { ...at, requests: requests.list(), templates: at.templates.map((t) => withReruns(held.has(t.name) ? { ...t, checkHeld: held.get(t.name)! } : t, later)) };
  };
  return {
    ...v, view, need: requests.need, give: requests.give, decline: requests.decline,
    holdCheck: (name, why) => { if (why) held.set(name, why); else held.delete(name); },
  };
}

/** The vault in the hopper's own process. */
export const localVault = (v: VaultService): Omit<Vault, 'need' | 'give' | 'decline' | 'holdCheck'> => ({
  view: () => v.view(),
  status: async () => v.view().problem,
  set: async (s, by) => v.set(s, by),
  remove: async (name, by) => v.remove(name, by),
  deliver: (ask, key) => v.deliver(ask, key),
  forStep: (ask) => v.forStep(ask),
  mint: (ask, key) => v.mint(ask, key),
  testMint: (asset, by) => v.testMint(asset, by), mintForDiscovery: (asset) => v.mintForDiscovery(asset),
  mintForCheck: (ask) => v.mintForCheck(ask),
  mintForNeedStep: (ask) => v.mintForNeedStep(ask), readDatabase: (ask) => v.readDatabase(ask),
  releaseMints: (box) => v.releaseMints(box), reconcileMints: () => v.reconcileMints(),
  saveTemplate: (t, by) => v.saveTemplate(t, by),
  removeTemplate: (name, by) => v.removeTemplate(name, by),
  approveTemplate: (name, by, job) => v.approveTemplate(name, by, job),
  revokeTemplate: (name, by) => v.revokeTemplate(name, by),
  approveProfile: (name, profile, by) => v.approveProfile(name, profile, by),
  scopeOf: (machine) => v.scopeOf(machine), boxRadius: (machine) => v.boxRadius(machine),
  boxes: () => v.boxes(),
  templateScopes: () => v.templateScopes(),
  recordCheck: (name, check) => v.recordCheck(name, check), checkTemplate: (name, by) => v.checkTemplate(name, by),
  agentCredential: (ask) => v.agentCredential(ask), podCredential: (ask) => v.podCredential(ask),
  deliveredTo: (jobId) => v.deliveredTo(jobId),
});

/** Whether the vault holds a template of this name: a box joins as, or is set to, only one that is there (issue #604). */
export const holdsTemplate = (v: Pick<Vault, 'view'>, name: string): boolean => v.view().templates.some((t) => t.name === name);

/** What `GET /api/vault` and each edit answer: the view, with the vault's status as its problem. */
export async function vaultView(v: Vault): Promise<VaultView> {
  const problem = await v.status();
  const { problem: _local, ...view } = v.view();
  return { ...view, ...(problem !== undefined ? { problem } : {}) };
}
