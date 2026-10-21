// What Access answers (issue #559, design.md "Access: OpenFGA decides each mint"): the port the vault, artifacts, the
// system scope and a changed item's acceptance ask. Implemented by createAccess (service.ts); apart for its size.
import type {
  AccessAnswer, AccessDecisionRecord, ApiTokenAsk, ApiTokenBoxAsk, CheckMintRequest, AccessStatus, AccessView, MintDecision, MintRequest, OperationProfile, RelayAsk, SharedSecretAsk, SystemSecretAsk, TemplateApprovals,
} from '../domain/types.ts';
import type { TrustLevel } from '../domain/trust-stamp.ts';
import type { GitLabActorRef, MinTrust } from '../domain/access.ts';

/** Who asks to see an artifact (issue #624): a user of the hopper, or the holder of a public link. */
export type ArtifactViewer = { kind: 'user'; userId: string } | { kind: 'link'; userId: string; shareId: string };
/** A live share of an artifact, as Access writes it: the owner, the artifact, the share, and the user it is with (none: a link). */
export interface LiveShare { ownerId: string; artifactId: string; shareId: string; userId?: string }

export interface Access extends TemplateApprovals {
  /** Whether `viewer` may see the artifact (issue #624): OpenFGA's `can_view`, once the live shares are pushed. Not recorded: it is asked at each view. */
  decideView(viewer: ArtifactViewer, artifact: { userId: string; id: string }): Promise<{ allowed: boolean; reason: string }>;
  /**
   * Whether the user may accept an item's new text (issue #662): OpenFGA's `item#can_accept_text`, the item's owner told at
   * the check. Not recorded: the acceptance's own event is. Denied when OpenFGA cannot be asked or the model lacks it.
   */
  decideTextAcceptance(userId: string, item: { ownerId: string; key: string }): Promise<AccessAnswer>;
  /**
   * Whether GitHub login `login` may start the user's jobs (issue #652): OpenFGA's `intake#can_start_jobs`, the user's
   * trusted actors told at the check. Not recorded. Denied, marked `unavailable`, when OpenFGA cannot be asked.
   */
  decideIntakeActor(userId: string, login: string, actors: readonly string[]): Promise<AccessAnswer>;
  /**
   * Whether a GitLab user may start the user's jobs (issue #1448): OpenFGA's `intake#can_start_jobs` for `gitlab_account`, the
   * user's GitLab account told as their trusted actor at the check. Not recorded. Denied, marked `unavailable`, when OpenFGA
   * cannot be asked.
   */
  decideGitLabIntakeActor(userId: string, actor: GitLabActorRef, actors: readonly GitLabActorRef[]): Promise<AccessAnswer>;
  /**
   * Whether the user may grant the jobs of an item the vault (issue #652): OpenFGA's `vault_grant#can_grant`, the item's
   * owner told at the check. Not recorded: the grant's own event is. Denied, marked `unavailable`, when OpenFGA cannot be asked.
   */
  decideVaultGrant(userId: string, grant: { ownerId: string; key: string }): Promise<AccessAnswer>;
  /**
   * Whether the user may attach to a job's terminal (issue #1128): view its pane and type into it. OpenFGA's
   * `terminal#can_attach`, the job's owner told at the check. Not recorded: the terminal's own events are. Denied, marked
   * `unavailable`, when OpenFGA cannot be asked.
   */
  decideTerminal(userId: string, terminal: { ownerId: string; jobId: string }): Promise<AccessAnswer>;
  /**
   * Whether the user may attach to a machine's terminal (issue #1128): list, view and type into the panes of the hopper's
   * herdr session there. OpenFGA's `machine_terminal#can_attach`, the machine's owner told at the check. Not recorded: the
   * terminal's own events are. Denied, marked `unavailable`, when OpenFGA cannot be asked.
   */
  decideMachineTerminal(userId: string, terminal: { ownerId: string; machineId: string }): Promise<AccessAnswer>;
  /**
   * Whether a job may relay to a target of its bastion (issue #2146): OpenFGA's `bastion#can_relay`, the job told as its
   * owner and as running its template, and the template as approved for the target when a person approved it. Not
   * recorded: the relay's own events are. Denied, marked `unavailable`, when OpenFGA cannot be asked.
   */
  decideRelay(ask: RelayAsk): Promise<AccessAnswer>;
  /**
   * Whether the user may see a search hit (issue #945): OpenFGA's `search_hit#can_view`, its owner told at the check and,
   * unless it is private (a direct job's), every user as a reader. Not recorded. Denied, marked `unavailable`, when
   * OpenFGA cannot be asked.
   */
  decideSearchHit(viewerId: string, hit: { ownerId: string; type: string; ref: string; private: boolean }): Promise<AccessAnswer>;
  /** Allowed or denied for the requester, why, and the relationship path; recorded. The vault calls it before every mint and renewal. */
  decideMint(request: MintRequest): Promise<MintDecision>;
  /** Allowed or denied for a read-only check box of the template (issue #797), asked as for a live job of it; recorded as the check's. */
  decideCheckMint(request: CheckMintRequest): Promise<MintDecision>;
  /** Whether a requester may change or read a system secret (issue #657): OpenFGA's `can_change` or `can_read`, with the owner and an admin told for that check only. Not recorded. */
  decideSystemSecret(ask: SystemSecretAsk): Promise<AccessAnswer>;
  /** Whether a user may read or change a shared secret (issue #718): OpenFGA's `can_read` or `can_change`, its readers and an admin told for that check only. Not recorded. */
  decideSharedSecret(ask: SharedSecretAsk): Promise<AccessAnswer>;
  /** Whether the user's API token may act with a role (issue #718): OpenFGA's `api_token#can_view|can_operate|can_administer`, its owner told. Not recorded. */
  decideApiToken(ask: ApiTokenAsk): Promise<AccessAnswer>;
  /** Whether the user's API token may do a box action (issue #795): OpenFGA's `api_token#can_run_on_box`, its owner told, and `box_runner` for a box token. Not recorded. */
  decideBoxAction(ask: ApiTokenBoxAsk): Promise<AccessAnswer>;
  /** A check for a made-up live job of `template`, tried from Users & access → Access; recorded as a trial by `by`. */
  tryCheck(request: Omit<MintRequest, 'requester'> & { template: string; level?: TrustLevel }, by: string): Promise<AccessDecisionRecord>;
  /** A profile's minimum trust (issue #655, part 15), or none (`null`): no job below it is its requester. 400: the model lacks the trust relations. */
  setMinTrust(profile: OperationProfile, level: TrustLevel | null, by: string): Promise<void>;
  /** Each profile's minimum trust (part 15), as kept: what a job's stamp may ask for at gate 2 (part 16). */
  minTrusts(): MinTrust[];
  /** The template approved for the operation profile (the vault's gate writes this, issue #558); pushed at once. */
  approve(template: string, profile: OperationProfile, by: string): Promise<void>;
  revoke(approval: number, by: string): Promise<void>;
  /** A new model, against the version read; OpenFGA must take it when it can be asked. */
  setModel(dsl: string, version: number, by: string): Promise<void>;
  /** Push the model and every approval to OpenFGA, putting back what differs; resolves when done or failed (the status says which). */
  sync(): Promise<void>;
  view(): AccessView;
  /** Whether OpenFGA can be asked now, and why not (issue #696). */
  status(): AccessStatus;
  start(): void;
  /** No more pushes; resolves once the push in flight, if any, ended. */
  stop(): Promise<void>;
}
