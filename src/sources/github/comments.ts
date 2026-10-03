// Posting hopper comments idempotently: every comment starts with its marker; before posting,
// an existing comment carrying the identical marker is reused (a retry after a crash never
// duplicates). In app mode it must also be the bot's: a stranger's planted marker comment is
// never reused (editing it would 403). Bodies are capped below GitHub's 65 536-char limit.

import type { GitHubApi } from './api.ts';
import type { BotLogin } from './identity.ts';
import { firstLine, truncate } from './markers.ts';

export const COMMENT_BODY_CAP = 60000;

export function commentBody(marker: string, text: string, jobId: string): string {
  return truncate(`${marker}\n${text}`, COMMENT_BODY_CAP, `\n\n(truncated, see job ${jobId})`);
}

/** Where a hopper comment goes, and who the hopper posts as (bot in app mode). */
export interface CommentTarget {
  api: GitHubApi;
  repo: string;
  number: number;
  botLogin: BotLogin;
}

async function findByMarker(t: CommentTarget, marker: string): Promise<number | undefined> {
  const comments = await t.api.listComments(t.repo, t.number);
  return comments.find((c) => firstLine(c.body) === marker && (t.botLogin === undefined || c.author === t.botLogin))?.id;
}

/** Post once: `known` (from source state) or an existing marked comment wins over a new post. */
export async function postOnce(t: CommentTarget, marker: string, body: string, known: number | undefined): Promise<number> {
  if (known !== undefined) return known;
  const existing = await findByMarker(t, marker);
  if (existing !== undefined) return existing;
  return (await t.api.comment(t.repo, t.number, body)).id;
}

/** Create the comment once, then edit it in place on every later call. */
export async function upsert(t: CommentTarget, marker: string, body: string, known: number | undefined): Promise<number> {
  const id = known ?? await findByMarker(t, marker);
  if (id === undefined) return (await t.api.comment(t.repo, t.number, body)).id;
  await t.api.editComment(t.repo, id, body);
  return id;
}
