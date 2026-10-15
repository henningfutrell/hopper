// Which comments are the hopper's own: the connected account acts as its user, so the hopper's marker decides.

import type { GitHubComment } from './api.ts';
import { hasMarker } from './markers.ts';

export function isHopperComment(c: Pick<GitHubComment, 'body'>): boolean {
  return hasMarker(c.body);
}
