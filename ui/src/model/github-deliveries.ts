// Settings → GitHub webhook (issue #1079), pure: the URL GitHub or a relay sends deliveries to, the GitHub webhook secret's
// line (never its value), the relay command, and what came in since the start.
import type { DeliverySecretView, GitHubDeliveriesView } from './wire.ts';

const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** The URL to give GitHub, or the relay: this page's origin and the path. */
export const deliveryUrl = (origin: string, path: string): string => `${origin.replace(/\/+$/, '')}${path}`;

export function deliverySecretLine(s: DeliverySecretView): string {
  if (!s.set) return 'No secret: the hopper takes no delivery.';
  return `Set${s.last4 ? ` — ends in ${s.last4}` : ''} — ${s.setAt ? when(s.setAt) : ''}${s.setBy ? ` by ${s.setBy}` : ''} · sealed`;
}

/** A relay from GitHub to this hopper with the GitHub CLI's webhook extension: GitHub needs no route to the hopper. */
export const relayCommand = (url: string): string => `gh webhook forward --repo=OWNER/NAME --events=issues --url=${url} --secret=SECRET`;

export function deliveriesLine(v: Pick<GitHubDeliveriesView, 'received' | 'refused' | 'ignored' | 'last'>): string {
  if (v.received + v.refused + v.ignored === 0) return 'No delivery since the hopper started.';
  const counts = `${v.received} taken, ${v.refused} refused, ${v.ignored} not read since the hopper started.`;
  return v.last ? `${counts} Last: ${v.last.event} ${v.last.action} on ${v.last.repo}, ${when(v.last.at)}.` : counts;
}
