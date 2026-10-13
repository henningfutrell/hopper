// Allowed hosts (issue #1024, design.md "Reaching the UI across a tailnet"): the hosts the hopper's admin allowed, kept in the
// instance's settings and read at each request, with this host's tailnet names and addresses, as more LAN names. A change
// applies at once, without a restart, and is `allowed_hosts.changed`.
import type { InstanceEvents, InstanceSettingsRepository } from '../domain/ports.ts';
import { normalHosts, type AllowedHostsView } from '../domain/allowed-hosts.ts';
import { tailscaleSource, watchTailnet, type TailnetSource } from './tailnet.ts';

export interface AllowedHosts {
  /** The names a request may name beyond the LAN names: this host's tailnet's, then the admin's. */
  names(): string[];
  /** Whether this host is on a tailnet now. */
  tailnet(): boolean;
  view(): AllowedHostsView;
  /** Keeps the whole list; nothing changed, nothing kept. */
  change(hosts: readonly string[], by: string): AllowedHostsView;
  /** Stops reading the tailnet. */
  stop(): void;
}

export function createAllowedHosts(o: {
  settings: Pick<InstanceSettingsRepository, 'getAllowedHosts' | 'setAllowedHosts'>;
  events: Pick<InstanceEvents, 'append'>;
  /** Default tailscaled's local API, else the Tailscale interface; null: none. */
  tailnet?: TailnetSource | null | undefined;
  lanNames: readonly string[];
  port: () => number;
  logger: { info(line: string): void };
}): AllowedHosts {
  const source = o.tailnet === undefined ? tailscaleSource() : o.tailnet;
  const tailnet = source ? watchTailnet({ source, logger: o.logger }) : undefined;
  let hosts = o.settings.getAllowedHosts();
  const view = (): AllowedHostsView => ({ hosts: [...hosts], lan: [...o.lanNames], tailnet: { on: tailnet?.on() ?? false, names: tailnet?.names() ?? [] }, port: o.port() });
  return {
    names: () => [...(tailnet?.names() ?? []), ...hosts],
    tailnet: () => tailnet?.on() ?? false,
    view,
    change(next, by) {
      const to = normalHosts(next);
      if (to.join('\n') !== hosts.join('\n')) {
        const from = hosts;
        o.settings.setAllowedHosts(to);
        hosts = to;
        o.events.append({ type: 'allowed_hosts.changed', data: { from, to, by } });
      }
      return view();
    },
    stop: () => tailnet?.stop(),
  };
}
