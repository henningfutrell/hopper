// Promote to GitHub in the UI (issue #946, design.md "Promote to GitHub"), pure: what the promote form keeps, the preview
// it asks for, the edits it starts from the preview, why it cannot be posted yet, the request it posts, and the lines a
// direct job shows — the offer, and its promotion with what changed since. Part 2: which linked artifacts to commit to the
// promotion's branch, and the direct job a job was made for (the job view promotes it too).
import type { DirectJobView, PromotionDraft, PromotionRequest, PromotionTarget } from './wire.ts';

/** What the form keeps: every field as typed or ticked. */
export interface PromoteEdits {
  repo: string;
  target: 'issue' | 'comment';
  /** The issue a comment goes on. */
  number: string;
  includeRequester: boolean;
  title: string;
  body: string;
  /** Split at commas. */
  labels: string;
  artifacts: string[];
  /** The linked artifacts to commit to the promotion's branch: none until the person ticks one. */
  commit: string[];
  confirmPublic: boolean;
  allowPersonalData: boolean;
}

/** Where the form starts: the live promotion's place, else the direct job's repository. */
export function startEdits(d: DirectJobView): PromoteEdits {
  const p = d.promotion;
  return {
    repo: p?.repo ?? d.repo ?? '', target: p?.kind ?? 'issue', number: p?.kind === 'comment' ? String(p.number) : '', includeRequester: false,
    title: '', body: '', labels: '', artifacts: [], commit: [], confirmPublic: false, allowPersonalData: false,
  };
}

const REPO = /^[^/\s]+\/[^/\s]+$/;
const NUMBER = /^[1-9]\d{0,9}$/;

const targetOf = (e: PromoteEdits): PromotionTarget => (e.target === 'comment' ? { kind: 'comment', number: Number(e.number) } : { kind: 'issue' });

/** Why a preview cannot be asked for yet; undefined: it can. */
export function previewProblem(e: PromoteEdits): string | undefined {
  if (e.repo.trim() !== '' && !REPO.test(e.repo.trim())) return 'Give the repository as owner/name';
  if (e.target === 'comment' && !NUMBER.test(e.number.trim())) return 'Give the number of the issue to comment on';
  return undefined;
}

/** The preview's request: only what is given. */
export const previewRequest = (e: PromoteEdits): { repo?: string; target: PromotionTarget; includeRequester?: boolean } => ({
  ...(e.repo.trim() ? { repo: e.repo.trim() } : {}), target: targetOf(e), ...(e.includeRequester ? { includeRequester: true } : {}),
});

/** The edits after a preview: its text, its labels and every artifact ticked; the confirmations cleared. */
export const fromPreview = (e: PromoteEdits, p: PromotionDraft): PromoteEdits => ({
  ...e, repo: p.repo, target: p.target.kind, number: p.target.kind === 'comment' ? String(p.target.number) : '',
  title: p.title, body: p.body, labels: p.labels.join(', '), artifacts: p.artifacts.map((a) => a.id), commit: [], confirmPublic: false, allowPersonalData: false,
});

/** Why the edits cannot be posted yet; undefined: they can. The daemon scans the text again. */
export function promoteProblem(e: PromoteEdits, p: PromotionDraft): string | undefined {
  if (e.title.trim() === '') return 'Give it a title';
  if (e.body.trim() === '') return 'Say what to post';
  if (p.visibility === 'public' && !e.confirmPublic) return 'Confirm that the repository is public';
  return undefined;
}

/** The request a confirm posts: an artifact is committed only when it is linked too. */
export const promoteRequest = (e: PromoteEdits): PromotionRequest => {
  const commit = e.commit.filter((id) => e.artifacts.includes(id));
  return {
    repo: e.repo.trim(), target: targetOf(e), title: e.title.trim(), body: e.body.trim(),
    labels: [...new Set(e.labels.split(',').map((l) => l.trim()).filter((l) => l !== ''))], artifacts: e.artifacts, ...(commit.length > 0 ? { commit } : {}),
    ...(e.includeRequester ? { includeRequester: true } : {}), ...(e.confirmPublic ? { confirmPublic: true } : {}), ...(e.allowPersonalData ? { allowPersonalData: true } : {}),
  };
};

/** Whether the direct job's job ended: only then is it promoted. */
export const promotable = (d: DirectJobView): boolean => d.job?.status === 'finished' || d.job?.status === 'failed';

/** What the offer says; undefined: no offer. */
export function offerLine(d: DirectJobView): string | undefined {
  if (d.offer === 'asked') return 'Its submitter asked to promote it to GitHub when done. Preview it, edit it, then confirm.';
  if (d.offer === 'suggested') return `It made ${d.artifacts.length === 1 ? 'an artifact' : `${d.artifacts.length} artifacts`} you may want to share. Promote it to GitHub?`;
  return undefined;
}

/** Where it was promoted, and what changed since; undefined: not promoted. */
export function promotionLine(d: DirectJobView): string | undefined {
  const p = d.promotion;
  if (!p) return undefined;
  const where = p.kind === 'issue' ? `as issue ${p.repo}#${p.number}` : `as a comment on ${p.repo}#${p.number}`;
  const n = p.stale.length;
  return `Promoted ${where}${n > 0 ? ` · ${n === 1 ? '1 artifact changed' : `${n} artifacts changed`} since: promote again to update it` : ''}`;
}

const DIRECT_KEY = /^direct:(.+)$/;

/** The direct job a job was made for, from its source; undefined: a job from anything else. */
export function directJobOf(job: { source?: { source: string; key: string } }): string | undefined {
  return job.source?.source === 'direct' ? DIRECT_KEY.exec(job.source.key)?.[1] : undefined;
}
