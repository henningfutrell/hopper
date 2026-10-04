// The job's prompt (issue body + issue context block) and environment: the issue, read-only.
// Only comments by allowlisted authors that are not hopper comments reach the job: anyone else's
// text would be a prompt-injection path into a skip-permissions agent. The job never writes to
// its issue, and its prompt says nothing about commenting (its pane is still logged in to gh as
// the owner: the prompt is the only lever, and silence about issues is the instruction).

import type { GitHubComment, GitHubIssue } from './api.ts';
import { isHopperComment } from './identity.ts';
import type { BotLogin } from './identity.ts';
import { truncate } from './markers.ts';
import type { Priority } from './priority.ts';

export const BODY_CAP = 64000;
export const CONTEXT_CAP = 16000;
export const COMMENT_CAP = 1000;

const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

export type SourceMode = 'gh' | 'app';


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
  const head = [
    '[job-hopper issue context]',
    `repo: ${issue.repo} · issue: #${issue.number} · url: ${issue.url}`,
    `title: ${oneLine(issue.title)}`,
    `labels: ${issue.labels.join(', ')} · author: ${issue.author}`,
    `priority: ${p.priority} (${p.reason}) · project item: ${p.projectItem}`,
  ].join('\n');
  const lines = comments.map(commentLine);
  const build = (kept: string[]) => kept.length === 0
    ? `${head}\nrecent comments: none`
    : `${head}\nrecent comments (oldest first, up to ${limit}; ${COMMENTS_HEADER[mode]}):\n${kept.join('\n')}`;
  let kept = lines;
  let block = build(kept);
  while (block.length > CONTEXT_CAP && kept.length > 0) {
    kept = kept.slice(1); // drop the oldest first
    block = build(kept);
  }
  return block.length > CONTEXT_CAP ? block.slice(0, CONTEXT_CAP) : block;
}

export function issuePrompt(issue: GitHubIssue, context: string): string {
  return `${truncate(issue.body, BODY_CAP, '\n(truncated)')}\n\n${context}`;
}

/** The job's issue, as read-only context. */
export function issueEnv(issue: GitHubIssue): Record<string, string> {
  return {
    HOPPER_ISSUE_URL: issue.url,
    HOPPER_REPO: issue.repo,
    HOPPER_ISSUE_NUMBER: String(issue.number),
    HOPPER_ISSUE_TITLE: oneLine(issue.title),
  };
}
