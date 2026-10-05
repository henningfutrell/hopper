// The update notice (issue #44), from GET /api/update: its words, whether it shows, and when the
// page must reload because the daemon now runs another commit. What's new is plain-language
// bullets (issue #104): the words here never count commits.
import type { UpdateStatus } from '../../../src/domain/types.ts';

export function headline(s: UpdateStatus): string {
  switch (s.state) {
    case 'available': return s.channel === 'release' ? `Update available: release ${s.target?.ref}` : 'Update available';
    case 'applying': return `Updating: ${s.apply?.detail ?? 'starting'}`;
    case 'error': return `Update problem: ${s.reason ?? 'unknown'}`;
    case 'unavailable': return `Self-update unavailable: ${s.reason ?? 'unknown'}`;
    default: return 'Up to date';
  }
}

export const showNotice = (s: UpdateStatus | null): boolean => s !== null && (s.state === 'available' || s.state === 'applying' || s.state === 'error');

export const reloadNeeded = (loadedCommit: string | undefined, s: UpdateStatus): boolean =>
  loadedCommit !== undefined && s.installed !== undefined && s.installed.commit !== loadedCommit;
