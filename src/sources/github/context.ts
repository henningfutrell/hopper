// The job's prompt (issue body + issue context block) and environment: the issue, read-only.
// Only the assignee's comments that are not hopper comments reach the job (issue #387; the app bot's never):
// anyone else's text would be a prompt-injection path into a skip-permissions agent. The job never writes to
// its issue, and its prompt says nothing about commenting (its pane is still logged in to gh as
// the owner: the prompt is the only lever, and silence about issues is the instruction).

import type { GitHubComment, GitHubIssue } from './api.ts';
import { isHopperComment } from './identity.ts';
import type { BotLogin } from './identity.ts';
import type { Completion } from './completion.ts';
import { truncate } from './markers.ts';
import type { Priority } from './priority.ts';

export const BODY_CAP = 64000;
export const CONTEXT_CAP = 16000;
export const COMMENT_CAP = 1000;

const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/** Who the source acts as: the App's bot, or a connected account (issue #214). */
export type SourceMode = 'app' | 'account';


const COMMENTS_HEADER: Record<SourceMode, string> = {
  app: "only the assignee's, no hopper comments",
  account: "only the assignee's, no hopper-marked comments",
};

/** The assignee's own comments, newest `limit`, oldest first; none without an assignee. */
export function contextComments(comments: GitHubComment[], assignee: string | undefined, limit: number, botLogin?: BotLogin): GitHubComment[] {
  if (limit === 0 || assignee === undefined) return [];
  const login = assignee.toLowerCase();
  return comments
    .filter((c) => c.author.toLowerCase() === login && !isHopperComment(c, botLogin) && c.body.trim() !== '')
    .sort((a, b) => a.id - b.id)
    .slice(-limit);
}

/**
 * What done means to the job, by its issue's completion (issues #171, #187). JobSource.notComplete
 * holds the job to it (completion.ts); the rest — checks, push, verifying where it runs — is the
 * job's to do and nothing the hopper can see.
 */
export function doneLine(n: number, completion: Completion): string {
  return completion === 'merge'
    ? `done (completion: merge): only once the change ships — the repo's own checks pass, the change is pushed, a pull request this job opens with "Closes #${n}" in its body is merged to the default branch, and the merged change is verified where the product runs. A local commit, an unpushed branch or an open pull request is not done; a job that ends done without the merge ends failed. One exception: when the issue needs no code change, close it as completed and end done`
    : `done (completion: pull-request): once the change is ready for review — the repo's own checks pass, the change is pushed, and a pull request this job opens with "Closes #${n}" in its body is open and not a draft. Do not merge it: a person reviews and merges it. A local commit, an unpushed branch or a draft is not done; a job that ends done without the pull request ends failed`;
}

function commentLine(c: GitHubComment): string {
  const body = truncate(c.body.trim(), COMMENT_CAP, '…').replace(/\r?\n/g, '\n  ');
  return `- ${c.author} at ${c.createdAt}: ${body}`;
}

export function contextBlock(issue: GitHubIssue, p: Priority, completion: Completion, comments: GitHubComment[], limit: number, mode: SourceMode = 'account'): string {
  const head = [
    '[hopper issue context]',
    `repo: ${issue.repo} · issue: #${issue.number} · url: ${issue.url}`,
    `title: ${oneLine(issue.title)}`,
    `labels: ${issue.labels.join(', ')} · author: ${issue.author}`,
    `priority: ${p.priority} (${p.reason}) · project item: ${p.projectItem}`,
    doneLine(issue.number, completion),
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
