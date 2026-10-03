// The job's prompt (issue body + issue context block) and environment. Only comments by
// allowlisted authors that are not hopper comments reach the job: anyone else's text would be a
// prompt-injection path into a skip-permissions agent. The footer differs per mode: gh jobs
// comment with `gh` and the marker (as the owner); app jobs with $HOPPER_COMMENT_CMD (as the app).

import type { GitHubComment, GitHubIssue } from './api.ts';
import { isHopperComment } from './identity.ts';
import type { BotLogin } from './identity.ts';
import { JOB_COMMENT_MARKER, truncate } from './markers.ts';
import type { Priority } from './priority.ts';

export const BODY_CAP = 64000;
export const CONTEXT_CAP = 16000;
export const COMMENT_CAP = 1000;

const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

export type SourceMode = 'gh' | 'app';

const ISSUE_LINE = 'Your issue is $HOPPER_ISSUE_URL (repo $HOPPER_REPO, number $HOPPER_ISSUE_NUMBER).';
const NO_CLOSE = 'Do not close this issue and do not use "Closes #N" — closing the issue cancels you.';

const FOOTERS: Record<SourceMode, string> = {
  gh: [
    '[how to report on your issue]',
    ISSUE_LINE,
    'To comment on it: gh issue comment "$HOPPER_ISSUE_NUMBER" -R "$HOPPER_REPO" --body "$(printf \'%s\\n%s\' "$HOPPER_COMMENT_MARKER" "<your text>")"',
    'Always start your comments with $HOPPER_COMMENT_MARKER. job-hopper posts your status, questions and result for you.',
    NO_CLOSE,
  ].join('\n'),
  app: [
    '[how to report on your issue]',
    ISSUE_LINE,
    'To comment on your issue: "$HOPPER_COMMENT_CMD" "<your text>" (posts as the job-hopper app).',
    'Never comment with gh: it posts as the owner, and a comment from him after a question reads as his answer.',
    'job-hopper posts your status, questions and result for you.',
    NO_CLOSE,
  ].join('\n'),
};

const COMMENTS_HEADER: Record<SourceMode, string> = {
  gh: 'only allowlisted authors, no hopper-marked comments',
  app: 'only allowlisted authors, no hopper comments',
};

export function contextComments(comments: GitHubComment[], authors: string[], limit: number, botLogin?: BotLogin): GitHubComment[] {
  if (limit === 0) return [];
  return comments
    .filter((c) => authors.includes(c.author) && !isHopperComment(c, botLogin) && c.body.trim() !== '')
    .sort((a, b) => a.id - b.id)
    .slice(-limit);
}

function commentLine(c: GitHubComment): string {
  const body = truncate(c.body.trim(), COMMENT_CAP, '…').replace(/\r?\n/g, '\n  ');
  return `- ${c.author} at ${c.createdAt}: ${body}`;
}

export function contextBlock(issue: GitHubIssue, p: Priority, comments: GitHubComment[], limit: number, mode: SourceMode = 'gh'): string {
  const FOOTER = FOOTERS[mode];
  const head = [
    '[job-hopper issue context]',
    `repo: ${issue.repo} · issue: #${issue.number} · url: ${issue.url}`,
    `title: ${oneLine(issue.title)}`,
    `labels: ${issue.labels.join(', ')} · author: ${issue.author}`,
    `priority: ${p.priority} (${p.reason}) · project item: ${p.projectItem}`,
  ].join('\n');
  const lines = comments.map(commentLine);
  const build = (kept: string[]) => kept.length === 0
    ? `${head}\nrecent comments: none\n${FOOTER}`
    : `${head}\nrecent comments (oldest first, up to ${limit}; ${COMMENTS_HEADER[mode]}):\n${kept.join('\n')}\n${FOOTER}`;
  let kept = lines;
  let block = build(kept);
  while (block.length > CONTEXT_CAP && kept.length > 0) {
    kept = kept.slice(1); // drop the oldest first
    block = build(kept);
  }
  return block.length > CONTEXT_CAP ? `${block.slice(0, CONTEXT_CAP - FOOTER.length - 1)}\n${FOOTER}` : block;
}

export function issuePrompt(issue: GitHubIssue, context: string): string {
  return `${truncate(issue.body, BODY_CAP, '\n(truncated)')}\n\n${context}`;
}

/** The phase-3 issue env; `extra` adds the app's HOPPER_TOKEN_FILE / _COMMENT_CMD / _GITHUB_API. */
export function issueEnv(issue: GitHubIssue, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...extra,
    HOPPER_ISSUE_URL: issue.url,
    HOPPER_REPO: issue.repo,
    HOPPER_ISSUE_NUMBER: String(issue.number),
    HOPPER_ISSUE_TITLE: oneLine(issue.title),
    HOPPER_COMMENT_MARKER: JOB_COMMENT_MARKER,
  };
}
