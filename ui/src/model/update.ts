// The update notice (issue #44), from GET /api/update: its words, whether it shows, and when the
// page must reload because the daemon now runs another commit. What's new is plain-language
// bullets (issue #104): the words here never count commits.
import type { UpdateStatus } from '../../../src/domain/types.ts';

/** The update channels, least stable first, and what each one pulls (issue #282). */
export const CHANNELS: { channel: UpdateStatus['channel']; hint: string }[] = [
  { channel: 'dev', hint: 'Every change as soon as it is merged: newest first, and the first to break.' },
  { channel: 'beta', hint: 'Changes once they have run on dev: a preview of the next stable version.' },
  { channel: 'main', hint: 'Changes once they have run on beta: the stable version.' },
  { channel: 'release', hint: 'Release tags only.' },
];

export function headline(s: UpdateStatus): string {
  switch (s.state) {
    case 'available':
      if (s.channel === 'release') return `Update available: release ${s.target?.ref}`;
      // Installed from another channel's branch: applying moves to this channel (issue #282).
      return s.installed && s.installed.branch !== s.channel ? `Update available: move to the ${s.channel} channel` : 'Update available';
    case 'applying': return `Updating: ${s.apply?.detail ?? 'starting'}`;
    case 'error': return `Update problem: ${s.reason ?? 'unknown'}`;
    case 'unavailable': return `Self-update unavailable: ${s.reason ?? 'unknown'}`;
    default: return 'Up to date';
  }
}

export const showNotice = (s: UpdateStatus | null): boolean => s !== null && (s.state === 'available' || s.state === 'applying' || s.state === 'error');

export const reloadNeeded = (loadedCommit: string | undefined, s: UpdateStatus): boolean =>
  loadedCommit !== undefined && s.installed !== undefined && s.installed.commit !== loadedCommit;
