// What a job that follows a hand-off is told (issue #551), pure: the failure a person looked at and their note. A
// continued job's own agent session gets it as the answer it resumes with; a new job of the item, after its prompt.
import type { Handoff, HandoffResolutionAction } from '../domain/types.ts';

/** The error as the brief quotes it: the most it carries, its end kept, where the reason usually is. */
const ERROR_CHARS = 2000;

const errorOf = (h: Pick<Handoff, 'error'>): string => (h.error.length > ERROR_CHARS ? `…${h.error.slice(-ERROR_CHARS)}` : h.error);

function failureLines(h: Pick<Handoff, 'summary' | 'reasons' | 'error'>): string[] {
  return [
    'The failure:', h.summary,
    ...(h.reasons.length ? ['', 'The assessment:', ...h.reasons.map((r) => `- ${r}`)] : []),
    '', 'The error:', errorOf(h),
  ];
}

const noteLines = (note: string | undefined): string[] => (note ? ['', 'The person\'s note:', note] : ['', 'The person left no note.']);

/**
 * The brief for `continue` or `fixed`. `resumes`: the job's own agent session goes on in its work tree, which may
 * have been cleaned since it failed; else a new job of the item, with none of the earlier session's history.
 */
export function handoffBrief(h: Pick<Handoff, 'summary' | 'reasons' | 'error'>, action: Extract<HandoffResolutionAction, 'continue' | 'fixed'>, note: string | undefined, resumes: boolean): string {
  const opening = resumes
    ? ['This job failed and was handed to a person. They looked at it and ask you to go on, in this same session and work tree.',
      'The work tree may have been cleaned up since: look at what is there first (git status, git log, the branch on the remote) and go on from it; do not start over.']
    : action === 'fixed'
      ? ['An earlier job of this item failed and was handed to a person. They fixed the cause outside the job (its environment, credentials or repository) and run it again now.']
      : ['An earlier job of this item failed and was handed to a person. They looked at it and ask this job to go on from it. This is a new session: you have none of the earlier one\'s history; its branch or pull request may already exist, so look for them first.'];
  return [...opening, '', ...failureLines(h), ...noteLines(note)].join('\n');
}

/**
 * What a timed-out job still at work is told when it goes on (issue #630). `resumes`: its own agent session, in its
 * kept work tree; else a new job of its item, with none of the earlier session's history.
 */
export function timedOutBrief(resumes: boolean): string {
  return resumes
    ? ['This job timed out while it was at work. Go on from where you stopped, in this same session and work tree.',
      'Look at what is there first (git status, git log, the branch on the remote, its pull request), then finish the work. Do not start over.'].join('\n')
    : ['An earlier job of this item timed out while it was at work. This is a new session: you have none of the earlier one\'s history.',
      'Go on from its pushed branch or its open pull request: look for them first, then finish the work. Do not start over.'].join('\n');
}
