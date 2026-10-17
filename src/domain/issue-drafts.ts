// File an issue (issue #471, design.md "File an issue"): what a person asks for, the draft that comes back, the confirm
// step, the filed issue, and the note a filed issue ends with. Pure. The person's own signed-in Claude writes the draft
// with the file-issue run skill (src/run-skills/, issue #472); the person reads it, edits it and confirms it; only then
// does the hopper file it, with their own GitHub connection, on one of their job repositories, with no label and no
// assignee, so filing never queues a job.
import type { RepoVisibility } from './promotions.ts';

/** The provider that drafts: the user's own `claude` CLI, signed in to their Claude account. */
export const ISSUE_DRAFT_PROVIDER = 'claude';

/** The most one draft may take: past it, the person is told and keeps their text. */
export const ISSUE_DRAFT_TIMEOUT_MS = 180_000;

/** What the routes take; the run skill's constraints (src/run-skills/constraints.ts) are tighter, and say so as findings. */
export const ISSUE_TITLE_MAX = 256;
export const ISSUE_BODY_MAX = 60_000;
export const ISSUE_TEXT_MAX = 10_000;
export const ISSUE_CONTEXT_MAX = 20_000;

/** What the person asks for: their own words, the context they attach, and on a run again the draft and what to change. */
export interface IssueDraftRequest {
  repo: string;
  text: string;
  context?: string;
  instructions?: string;
  previous?: { title: string; body: string };
}

/** A constraint of a drafted issue the text breaks (src/run-skills/constraints.ts): its id and what it is. */
export interface IssueFinding { constraint: string; what: string }

/** What comes back: the draft cleaned of secrets and personal data, and what the draft broke. */
export interface DraftAnswer {
  repo: string;
  title: string;
  body: string;
  /** What the drafting skill says it changed or left out; never filed. */
  notes: string;
  /** The constraints the draft as written broke: a secret or personal data is masked in `title` and `body`. */
  findings: IssueFinding[];
  provider: string;
  model?: string;
  /** The run skill and its id (`file-issue@<id>`): what a filed issue's record names as what drafted it. */
  skill: string;
}

/** Whether File an issue can be used now, and why not. */
export interface IssueDraftStatus {
  provider: string;
  /** Whether the provider is there to draft. */
  available: boolean;
  /** Whether the whole flow can run: a provider, a GitHub connection, a job repository. */
  usable: boolean;
  /** Why it cannot, in plain words. */
  reason?: string;
  /** The repositories an issue may be filed on: the user's job repositories. */
  repos: string[];
}

/** The confirm step: where it goes, with what, and what stops it. */
export interface IssueCheck {
  repo: string;
  visibility: RepoVisibility;
  title: string;
  body: string;
  /** Always empty: filing adds no label and no assignee, so it starts no job. */
  labels: string[];
  assignees: string[];
  findings: IssueFinding[];
  /** Why it cannot be filed as it is; undefined: it can. */
  refusal?: string;
}

/** What a filed issue is. */
export interface FiledIssue { repo: string; number: number; url: string }

/** The line a filed issue ends with: what drafted it, and that a person read and filed it. It names no person. */
export const FILED_NOTE = '_Drafted with Claude through the hopper\'s File an issue, then read, edited and filed by its author._';

/** The body as filed: the person's text, then the note. */
export const filedBody = (body: string): string => `${body.trim()}\n\n---\n${FILED_NOTE}`;

/**
 * Why the findings stop a filing; undefined: they do not. Every constraint but personal data stops it. Personal data
 * stops it on a public repository, and on another unless the person allowed it (as Promote to GitHub's scan).
 */
export function filingRefusal(found: readonly IssueFinding[], o: { visibility: RepoVisibility; allowPersonalData?: boolean }): string | undefined {
  const hard = found.find((f) => f.constraint !== 'no-personal-data');
  if (hard) return `the text cannot be filed: ${hard.what}. Change it`;
  if (!found.some((f) => f.constraint === 'no-personal-data')) return undefined;
  if (o.visibility === 'public') return 'the text holds personal data, and the repository is public: remove it';
  return o.allowPersonalData ? undefined : 'the text holds personal data: remove it, or allow it for this private repository';
}

/** The run skill's context for a request: what the person attached, then on a run again the edited draft and what to change. */
export function draftContext(r: Pick<IssueDraftRequest, 'context' | 'instructions' | 'previous'>): string | undefined {
  const parts = [
    ...(r.context?.trim() ? [r.context.trim()] : []),
    ...(r.previous ? [`The earlier draft, as the user edited it:\n\nTitle: ${r.previous.title}\n\n${r.previous.body}`] : []),
    ...(r.instructions?.trim() ? [`What the user asks to change in that draft: ${r.instructions.trim()}`] : []),
  ];
  return parts.length ? parts.join('\n\n') : undefined;
}
