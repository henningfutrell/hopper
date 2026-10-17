// The leftovers on a Machines card (issue #1116, design.md "Leftovers a person decides"): what the layout before issue #1188
// left that the sweep does not judge, each with what a person needs to keep or remove it. Pure.
import type { LeftoverView } from '../../../src/domain/types.ts';

const size = (bytes: number): string => (bytes >= 1e9 ? `${bytes >= 1e10 ? Math.round(bytes / 1e9) : (bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

/** How old a leftover is, in days, or in hours under a day. */
export function ageText(ms: number): string {
  const hours = Math.floor(ms / 3600_000);
  if (hours < 1) return 'under an hour old';
  if (hours < 24) return hours === 1 ? '1 hour old' : `${hours} hours old`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day old' : `${days} days old`;
}

/** What a leftover is: a job's old files or a repository mirror, its size, its age, and the worktrees that use a mirror. */
export function leftoverText(l: LeftoverView): string {
  const what = l.kind === 'mirror' ? 'repository mirror' : 'old job files';
  const parts = [what, ...(l.bytes !== undefined ? [size(l.bytes)] : []), ageText(l.ageMs)];
  if (l.kind === 'mirror') parts.push(l.users === 1 ? 'used by 1 worktree' : `used by ${l.users ?? 0} worktrees`);
  return parts.join(' · ');
}

/** What a person is told before a removal: it cannot be undone, and what it loses. */
export function removalText(l: LeftoverView): string {
  const lost = l.unpushed ? 'It holds work not pushed: that work is lost.' : 'It holds no work that is not pushed.';
  const users = l.kind === 'mirror' && (l.users ?? 0) > 0 ? ' The worktrees that use it stop working.' : '';
  return `The folder is removed on the machine, whatever it holds. ${lost}${users} This cannot be undone.`;
}
