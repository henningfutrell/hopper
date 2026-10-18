// The comment command (issue #655 part 21, Decision N3; design.md "Trust stamps"): a comment whose first line is
// `/hopper run`, `/hopper research` or `/hopper propose`. Written by the source's own account on a labelled issue, it
// nominates the issue as the assignment does, and `research` and `propose` ask its job for that kind. Only the newest
// command of that account counts, and only one not edited since it was written: anyone who can edit a comment could have
// written an edited one. Pure.
import type { ReviewKind } from './review.ts';

export const COMMAND_VERBS = ['run', 'research', 'propose'] as const;
export type CommandVerb = typeof COMMAND_VERBS[number];

const COMMAND = /^\/hopper[ \t]+(run|research|propose)[ \t]*$/i;

/** The verb of a text whose first line that is not empty is a command; undefined for any other text. */
export function parseCommand(body: string): CommandVerb | undefined {
  const first = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
  return first === undefined ? undefined : (COMMAND.exec(first)?.[1]?.toLowerCase() as CommandVerb | undefined);
}

export const isCommand = (body: string): boolean => parseCommand(body) !== undefined;

/** A comment as the command reads it. `updatedAt` absent: whether it was edited is not known, so it is no command. */
export interface CommandComment { id: number; author: string; body: string; createdAt: string; url: string; updatedAt?: string; viaApp?: string }

/** A command as read: its verb, who wrote it, when, its link, and the app it was written through, if any. */
export interface CommentCommand { verb: CommandVerb; login: string; at: string; url: string; app?: string }

/** The newest command `login` wrote among `comments` and did not edit; undefined when there is none. */
export function commandOf(comments: readonly CommandComment[], login: string): CommentCommand | undefined {
  const own = comments.filter((c) => c.author.toLowerCase() === login.toLowerCase() && c.updatedAt === c.createdAt);
  for (const c of [...own].sort((a, b) => b.id - a.id)) {
    const verb = parseCommand(c.body);
    if (verb) return { verb, login: c.author, at: c.createdAt, url: c.url, ...(c.viaApp ? { app: c.viaApp } : {}) };
  }
  return undefined;
}

/** What a command asks its job for, beside the work. */
export const commandAsks = (verb: CommandVerb): ReviewKind[] => (verb === 'research' ? ['research'] : verb === 'propose' ? ['proposal'] : []);
