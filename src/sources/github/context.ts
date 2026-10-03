// The job's prompt (issue body + issue context block) and environment. Only comments by
// allowlisted authors and without a hopper marker reach the job: anyone else's text would be a
// prompt-injection path into a skip-permissions agent.

import type { GitHubComment, GitHubIssue } from './api.ts';
import { JOB_COMMENT_MARKER, hasMarker, truncate } from './markers.ts';
import type { Priority } from './priority.ts';

export const BODY_CAP = 64000;
export const CONTEXT_CAP = 16000;
export const COMMENT_CAP = 1000;

const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

const FOOTER = [
  '[how to report on your issue]',
  'Your issue is $HOPPER_ISSUE_URL (repo $HOPPER_REPO, number $HOPPER_ISSUE_NUMBER).',
  'To comment on it: gh issue comment "$HOPPER_ISSUE_NUMBER" -R "$HOPPER_REPO" --body "$(printf \'%s\\n%s\' "$HOPPER_COMMENT_MARKER" "<your text>")"',
  'Always start your comments with $HOPPER_COMMENT_MARKER. job-hopper posts your status, questions and result for you.',
  'Do not close this issue and do not use "Closes #N" — closing the issue cancels you.',
].join('\n');

export function contextComments(comments: GitHubComment[], authors: string[], limit: number): GitHubComment[] {
  if (limit === 0) return [];
  return comments
    .filter((c) => authors.includes(c.author) && !hasMarker(c.body) && c.body.trim() !== '')
    .sort((a, b) => a.id - b.id)
    .slice(-limit);
}

function commentLine(c: GitHubComment): string {
  const body = truncate(c.body.trim(), COMMENT_CAP, '…').replace(/\r?\n/g, '\n  ');
  return `- ${c.author} at ${c.createdAt}: ${body}`;
}

export function contextBlock(issue: GitHubIssue, p: Priority, comments: GitHubComment[], limit: number): string {
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
    : `${head}\nrecent comments (oldest first, up to ${limit}; only allowlisted authors, no hopper-marked comments):\n${kept.join('\n')}\n${FOOTER}`;
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

export function issueEnv(issue: GitHubIssue): Record<string, string> {
  return {
    HOPPER_ISSUE_URL: issue.url,
    HOPPER_REPO: issue.repo,
    HOPPER_ISSUE_NUMBER: String(issue.number),
    HOPPER_ISSUE_TITLE: oneLine(issue.title),
    HOPPER_COMMENT_MARKER: JOB_COMMENT_MARKER,
  };
}
