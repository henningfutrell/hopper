// Component watchers in the UI (issue #1077), pure: the panel's note, its summary of the setting, and a line for each
// watcher and each drift it found.
import type { ComponentWatcherSettings, ComponentWatcherView, DriftView } from './wire.ts';

export const COMPONENT_WATCHERS_NOTE = 'A component watcher checks one part of the hopper against its source of truth on an interval: the work-item ledger against GitHub. '
  + 'With drift issues on, each kind of drift it finds is one issue on the hopper\'s own repository, filed and updated with your GitHub account. '
  + 'The issue names no item, repository or person: each item is a short hash of its key, and this panel lists the items.';

export const componentWatchersSummary = (s: ComponentWatcherSettings): string => (s.fileIssues
  ? 'On: each kind of drift is one issue on the hopper\'s own repository, updated while it lasts.'
  : 'Off: a drift is recorded as an event and shown here. No issue is filed.');

const every = (seconds: number): string => (seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`);

export function watcherLine(w: ComponentWatcherView): string {
  const head = `${w.component} against ${w.truth}, every ${every(w.intervalSeconds)}`;
  if (w.error) return `${head}: the last check failed: ${w.error}.`;
  if (!w.checkedAt) return `${head}: not checked yet.`;
  return `${head}: checked ${w.checkedAt}, ${w.drifts.length === 0 ? 'no drift' : `${w.drifts.length} kind(s) of drift`}.`;
}

export const driftLine = (d: DriftView): string => `${d.kind.replaceAll('_', ' ')}: ${d.items} item${d.items === 1 ? '' : 's'} since ${d.since}${d.issue ? `, issue #${d.issue.number}` : ''}.`;
