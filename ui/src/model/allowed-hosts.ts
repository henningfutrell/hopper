// Allowed hosts in the UI (issue #1024), pure: the tailnet line, and the hosts a person typed, one a line, as the list to save.
import type { AllowedHostsView } from './wire.ts';

/** What the hopper found of this host's tailnet. */
export const tailnetLine = (view: AllowedHostsView): string =>
  view.tailnet.on
    ? `On a tailnet: the hopper also answers to ${view.tailnet.names.map((n) => (n.includes(':') ? `[${n}]` : n) + `:${view.port}`).join(', ')}.`
    : 'Not on a tailnet: the hopper found no Tailscale on this host. In a container, mount the host\'s /var/run/tailscale to see it, or add its names below.';

/** The typed text as the list to save: a host a line (or comma-separated), trimmed, each once. */
export const hostsOf = (text: string): string[] => [...new Set(text.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter((h) => h !== ''))];
