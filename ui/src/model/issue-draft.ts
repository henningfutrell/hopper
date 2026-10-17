// File an issue in the UI (issue #471), pure: what the daemon answers — whether the flow can run, the draft, the confirm
// step, the filed issue —, what the person asks, why an ask cannot go yet, and what the button says. The person's text
// and the draft stay here, in the dialog, until it closes: the daemon keeps no draft.

export interface IssueDraftStatus { provider: string; available: boolean; usable: boolean; reason?: string; repos: string[] }

export interface ScanFinding { kind: 'secret' | 'personal'; what: string }

export interface IssueDraft { repo: string; title: string; body: string; findings: ScanFinding[]; provider: string; model?: string; skill: string }

export interface IssueCheck {
  repo: string;
  visibility: 'public' | 'private' | 'internal';
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  findings: ScanFinding[];
  refusal?: string;
}

export interface FiledIssue { repo: string; number: number; url: string }

/** What a draft or its prompt is asked with. */
export interface IssueAsk {
  repo: string;
  text: string;
  context?: string;
  instructions?: string;
  previous?: { title: string; body: string };
}

/** The ask as the daemon takes it: empty parts left out. */
export function askBody(a: IssueAsk): IssueAsk {
  return {
    repo: a.repo, text: a.text,
    ...(a.context?.trim() ? { context: a.context } : {}),
    ...(a.instructions?.trim() ? { instructions: a.instructions } : {}),
    ...(a.previous ? { previous: a.previous } : {}),
  };
}

/** Why the ask cannot be drafted yet; undefined: it can. */
export function askProblem(a: Pick<IssueAsk, 'repo' | 'text'>): string | undefined {
  if (!a.repo) return 'Pick a repository';
  if (a.text.trim() === '') return 'Say what the issue is about';
  return undefined;
}

/** Why the edited draft cannot go to the confirm step yet; undefined: it can. */
export function editProblem(d: { title: string; body: string }): string | undefined {
  if (d.title.trim() === '') return 'Give the issue a title';
  if (d.body.trim() === '') return 'Say what the issue is';
  return undefined;
}

/** The File an issue button: shown to an operator or admin only; off, with the reason, while the flow cannot run. */
export function buttonState(canOperate: boolean, s: IssueDraftStatus | undefined): { show: boolean; disabled: boolean; title: string } {
  if (!canOperate) return { show: false, disabled: true, title: '' };
  if (!s) return { show: true, disabled: true, title: 'Checking whether Claude can draft an issue…' };
  if (!s.usable) return { show: true, disabled: true, title: `File an issue is not available: ${s.reason ?? 'no provider'}` };
  return { show: true, disabled: false, title: 'File an issue: describe it, Claude drafts it, you edit and confirm it' };
}

/** What stops the confirm step's Confirm: the scan's refusal, or a public repository not confirmed. */
export function confirmProblem(c: IssueCheck, o: { confirmPublic: boolean }): string | undefined {
  if (c.refusal) return c.refusal;
  if (c.visibility === 'public' && !o.confirmPublic) return 'The repository is public: tick that you want to file there';
  return undefined;
}

/** A finding as the person reads it: in the draft it was masked; at the confirm step the edited text holds it. */
export const findingLine = (f: ScanFinding, at: 'draft' | 'check'): string => (at === 'draft' ? `Masked in the draft: ${f.what}` : `The text holds ${f.what}`);
