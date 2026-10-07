// Which comments are the hopper's own. With the app the hopper posts as its bot, so the author
// decides; the marker stays a secondary check (and is the only one with a connected account, which
// acts as its user).

import type { GitHubComment } from './api.ts';
import { hasMarker } from './markers.ts';

/** The bot login in app mode; undefined in gh mode. */
export type BotLogin = string | undefined;

export function isHopperComment(c: Pick<GitHubComment, 'author' | 'body'>, botLogin: BotLogin): boolean {
  return (botLogin !== undefined && c.author === botLogin) || hasMarker(c.body);
}
