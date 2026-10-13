// Promote to GitHub (issue #946, design.md "Promote to GitHub"): a direct job's outputs stay private in the hopper until a
// person promotes them — an issue, or a comment on an issue they pick, on a repository they choose, posted with their own
// GitHub connection after a preview they edit and confirm. What carries over and how it reads, the record a promotion
// leaves, when an artifact promoted is stale, and when a direct job is offered for promotion. Pure.
import type { DirectJobView } from './direct-jobs.ts';

/** Where a promotion goes: a new issue, or a comment on an issue the person picks. */
export type PromotionTarget = { kind: 'issue' } | { kind: 'comment'; number: number };

/** An artifact as a promotion links it: the revision it linked. */
export interface PromotedArtifact { id: string; title: string; revision: number }

/** A promotion of a direct job, as kept: one live per direct job; a revoked one stays as a record. */
export interface Promotion {
  id: string;
  directJobId: string;
  repo: string;
  kind: 'issue' | 'comment';
  /** The issue: the one made, or the one commented on. */
  number: number;
  /** The issue's URL, or the comment's. */
  url: string;
  /** The comment's id, for a comment: what a promotion made again edits. */
  commentId?: number;
  artifacts: PromotedArtifact[];
  /** Who promoted it: the person, as the hopper names them. */
  promotedBy: string;
  promotedAt: string;
  /** When it was last posted: the first promotion, or the latest made again. */
  updatedAt: string;
  revokedAt?: string;
  revokedBy?: string;
}

/** A promotion as a direct job reads back: the artifacts changed since it was posted are stale. */
export interface PromotionView extends Promotion { stale: string[] }

export interface PromotionRepository {
  add(p: Omit<Promotion, 'id'>): Promotion;
  update(p: Promotion): void;
  /** The direct job's live promotion: not revoked. */
  live(directJobId: string): Promotion | undefined;
}

/** A repository's visibility, as GitHub answers it. */
export type RepoVisibility = 'public' | 'private' | 'internal';

/** What a scan of the text found: a secret is never posted; personal data only on a private repository, when allowed. */
export interface ScanFinding { kind: 'secret' | 'personal'; what: string }

/** An artifact the preview offers: the job's, each linked, never attached. */
export interface PromotionArtifact extends PromotedArtifact { summary?: string; kind: string; url: string }

/** The preview: what would be posted, for the person to edit and confirm. Changes nothing. */
export interface PromotionDraft {
  repo: string;
  visibility: RepoVisibility;
  target: PromotionTarget;
  title: string;
  /** The text the person edits: the brief and the results, cleaned. The artifacts and the footer are added when posted. */
  body: string;
  labels: string[];
  artifacts: PromotionArtifact[];
  /** Whether the requester is named. */
  includeRequester: boolean;
  /** The text below the body as it would be posted now: the artifacts, the hopper's link, who promoted it. */
  footer: string;
  /** The live promotion this one updates, when there is one. */
  update?: { kind: 'issue' | 'comment'; number: number; url: string };
  findings: ScanFinding[];
  /** What the person must know before confirming. */
  notes: string[];
}

/** What the person confirms. */
export interface PromotionRequest {
  repo: string;
  target: PromotionTarget;
  title: string;
  body: string;
  labels: string[];
  /** The ids of the job's artifacts to link. */
  artifacts: string[];
  includeRequester?: boolean;
  /** The repository is public, and the person posts there anyway. */
  confirmPublic?: boolean;
  /** Personal data the scan found stays: only on a repository that is not public. */
  allowPersonalData?: boolean;
}

/** What the confirm step says of a revoke, and what a revoke answers. */
export const REVOKE_NOTE = 'A revoke ends the link in the hopper only. It does not unpublish anything: GitHub keeps the issue or the comment, and its text, until a person removes it there.';

/** The hopper's own labels never carry over: on GitHub they could start a job. */
const HOPPER_LABEL = /^hopper(?::|$)/i;

/** The routing labels a promotion carries: the job's, once each, without the hopper's own. */
export const carriedLabels = (labels: readonly string[]): string[] => [...new Set(labels.filter((l) => !HOPPER_LABEL.test(l.trim())).map((l) => l.trim()).filter((l) => l !== ''))];

/** The artifacts promoted whose revision is newer now: stale on GitHub. */
export function staleArtifacts(p: Pick<Promotion, 'artifacts'>, now: readonly { id: string; revision: number }[]): string[] {
  return p.artifacts.filter((a) => (now.find((n) => n.id === a.id)?.revision ?? a.revision) > a.revision).map((a) => a.id);
}

/**
 * Whether a direct job is offered for promotion: `asked` when the submitter asked for it when done, `suggested` when it
 * made an artifact a person may want to share; only once its job finished and while no promotion is live.
 */
export function promotionOffer(d: Pick<DirectJobView, 'job' | 'promoteWhenDone' | 'artifacts' | 'promotion'>): 'asked' | 'suggested' | undefined {
  if (d.job?.status !== 'finished' || d.promotion) return undefined;
  if (d.promoteWhenDone) return 'asked';
  return d.artifacts.length > 0 ? 'suggested' : undefined;
}

/** The text a person edits, before the footer: the brief, then the results. */
export function promotionDraftBody(brief: string, result: string | undefined): string {
  return [brief.trim(), ...(result ? ['', '### Results', '', result.trim()] : [])].join('\n');
}

const RESULT_MAX = 8000;

/** A job's result as text for a promotion: text as it is, any other as JSON; at most 8000 characters. */
export function resultSummary(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}\n…` : text;
}

/** What is below the body: the artifacts as links, the hopper's link, who promoted it and, when asked, who requested it. */
export interface PromotionFooter {
  artifacts: (PromotedArtifact & { summary?: string })[];
  directJobId: string;
  /** The hopper's public URL: links are made only on it; without one, things are named by id. */
  publicUrl?: string;
  promotedBy: string;
  requester?: string;
}

/** The footer as posted. Links need a hopper sign-in to open. */
export function promotionFooter(f: PromotionFooter): string {
  const base = f.publicUrl?.replace(/\/+$/, '');
  const line = (a: PromotionFooter['artifacts'][number]): string => {
    const summary = a.summary ? ` — ${a.summary}` : '';
    return base ? `- [${a.title}](${base}/#artifacts/${a.id})${summary} (revision ${a.revision})` : `- ${a.title}${summary} (revision ${a.revision}, artifact ${a.id} in the hopper)`;
  };
  const from = base ? `From the hopper: ${base}/#direct-jobs/${f.directJobId}` : `From the hopper: direct job ${f.directJobId}`;
  return [
    ...(f.artifacts.length > 0 ? ['### Artifacts', '', ...f.artifacts.map(line), ''] : []),
    '---',
    `${from} (opening it needs a hopper sign-in).`,
    `Promoted by ${f.promotedBy}.${f.requester ? ` Requested by ${f.requester}.` : ''}`,
  ].join('\n');
}

/** The whole text posted: the body the person confirmed, then the footer. */
export const promotionText = (f: PromotionFooter & { body: string }): string => `${f.body.trim()}\n\n${promotionFooter(f)}`;
