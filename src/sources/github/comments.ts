// Posting hopper comments idempotently: every comment starts with its marker; before posting,
// an existing comment carrying the identical marker is reused (a retry after a crash never
// duplicates). Bodies are capped below GitHub's 65 536-char limit.

import type { GitHubApi } from './api.ts';
import { firstLine, truncate } from './markers.ts';

export const COMMENT_BODY_CAP = 60000;

export function commentBody(marker: string, text: string, jobId: string): string {
  return truncate(`${marker}\n${text}`, COMMENT_BODY_CAP, `\n\n(truncated, see job ${jobId})`);
}

async function findByMarker(api: GitHubApi, repo: string, number: number, marker: string): Promise<number | undefined> {
  const comments = await api.listComments(repo, number);
  return comments.find((c) => firstLine(c.body) === marker)?.id;
}

/** Post once: `known` (from source state) or an existing marked comment wins over a new post. */
export async function postOnce(
  api: GitHubApi, repo: string, number: number, marker: string, body: string, known: number | undefined,
): Promise<number> {
  if (known !== undefined) return known;
  const existing = await findByMarker(api, repo, number, marker);
  if (existing !== undefined) return existing;
  return (await api.comment(repo, number, body)).id;
}

/** Create the comment once, then edit it in place on every later call. */
export async function upsert(
  api: GitHubApi, repo: string, number: number, marker: string, body: string, known: number | undefined,
): Promise<number> {
  const id = known ?? await findByMarker(api, repo, number, marker);
  if (id === undefined) return (await api.comment(repo, number, body)).id;
  await api.editComment(repo, id, body);
  return id;
}
