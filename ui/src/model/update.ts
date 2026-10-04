// The update notice (issue #44), from GET /api/update: its words, whether it shows, the compare
// link, and when the page must reload because the daemon now runs another commit.
import type { UpdateStatus } from '../../../src/domain/types.ts';

const commits = (n: number, truncated: boolean) => `${n}${truncated ? '+' : ''} new commit${n === 1 && !truncated ? '' : 's'}`;

export function headline(s: UpdateStatus): string {
  switch (s.state) {
    case 'available': {
      const n = commits(s.changes.length, s.truncated);
      return s.channel === 'release' ? `Update available: release ${s.target?.ref} (${n})` : `Update available: ${n} on ${s.target?.ref}`;
    }
    case 'applying': return `Updating: ${s.apply?.detail ?? 'starting'}`;
    case 'error': return `Update problem: ${s.reason ?? 'unknown'}`;
    case 'unavailable': return `Self-update unavailable: ${s.reason ?? 'unknown'}`;
    default: return 'Up to date';
  }
}

export const showNotice = (s: UpdateStatus | null): boolean => s !== null && (s.state === 'available' || s.state === 'applying' || s.state === 'error');

/** The GitHub compare page for a repository given as ssh or https; undefined for any other host. */
export function compareUrl(repo: string, from: string, to: string): string | undefined {
  const m = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repo);
  return m ? `https://github.com/${m[1]}/${m[2]}/compare/${from}...${to}` : undefined;
}

export const reloadNeeded = (loadedCommit: string | undefined, s: UpdateStatus): boolean =>
  loadedCommit !== undefined && s.installed !== undefined && s.installed.commit !== loadedCommit;
