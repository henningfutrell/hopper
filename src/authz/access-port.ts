// What Access answers (issue #559, design.md "Access: OpenFGA decides each mint"): the port the vault, artifacts, the
// system scope and a changed item's acceptance ask. Implemented by createAccess (service.ts); apart for its size.
import type {
  AccessDecisionRecord, AccessView, MintDecision, MintRequest, OperationProfile, SystemSecretAsk, TemplateApprovals,
} from '../domain/types.ts';

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
  decideTextAcceptance(userId: string, item: { ownerId: string; key: string }): Promise<{ allowed: boolean; reason: string }>;
  /** Allowed or denied for the requester, why, and the relationship path; recorded. The vault calls it before every mint and renewal. */
  decideMint(request: MintRequest): Promise<MintDecision>;
  /** Whether a requester may change or read a system secret (issue #657): OpenFGA's `can_change` or `can_read`, with the owner and an admin told for that check only. Not recorded. */
  decideSystemSecret(ask: SystemSecretAsk): Promise<{ allowed: boolean; reason: string }>;
  /** A check for a made-up live job of `template`, tried from Settings → Access; recorded as a trial by `by`. */
  tryCheck(request: Omit<MintRequest, 'requester'> & { template: string }, by: string): Promise<AccessDecisionRecord>;
  /** The template approved for the operation profile (the vault's gate writes this, issue #558); pushed at once. */
  approve(template: string, profile: OperationProfile, by: string): Promise<void>;
  revoke(approval: number, by: string): Promise<void>;
  /** A new model, against the version read; OpenFGA must take it when it can be asked. */
  setModel(dsl: string, version: number, by: string): Promise<void>;
  /** Push the model and every approval to OpenFGA, putting back what differs; resolves when done or failed (the status says which). */
  sync(): Promise<void>;
  view(): AccessView;
  start(): void;
  stop(): void;
}
